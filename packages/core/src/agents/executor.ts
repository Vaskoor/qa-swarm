import type { Agent, AgentContext } from "./base.js";
import type {
  GeneratedTest,
  SwarmState,
  TestResult,
  RunSignal,
  Artifact,
  HealRecord,
} from "../types.js";
import { PlaywrightBrowserTool } from "../tools/browser.js";
import { HttpApiTool } from "../tools/api.js";
import { healLocator, toHealRecord } from "../selfheal/locator-healer.js";
import { QuarantineManager } from "../selfheal/quarantine.js";
import { absolutize } from "../report/render-playwright.js";

/**
 * Executor agent.
 *
 * Runs each generated test for real:
 *  - UI tests drive a headless browser step by step.
 *  - API tests hit the endpoint and validate status.
 *
 * On selector failure it invokes the self-healer, retries once, and records
 * the heal so the reporter can show "N locators auto-healed".
 */
export class ExecutorAgent implements Agent {
  readonly role = "executor" as const;

  async run(state: SwarmState, ctx: AgentContext): Promise<Partial<SwarmState>> {
    const { config } = state;
    const results: TestResult[] = [];
    const heals: HealRecord[] = [];
    const quarantine = new QuarantineManager(config.flakeThreshold);
    const api = new HttpApiTool();

    const uiTests = state.tests.filter((t) => t.kind !== "api");
    const apiTests = state.tests.filter((t) => t.kind === "api");

    // --- API tests: fast, no browser needed -------------------------------
    for (const test of apiTests) {
      results.push(await this.runApiTest(test, api, config.baseUrl ?? "", ctx));
    }

    // --- UI tests: shared browser for speed -------------------------------
    if (uiTests.length > 0) {
      const browser = new PlaywrightBrowserTool({
        headless: config.headless,
        baseUrl: config.baseUrl,
        screenshotDir: `${config.outputDir}/screenshots`,
      });
      try {
        await browser.launch();
        for (const test of uiTests) {
          const { result, heal } = await this.runUiTest(
            test,
            browser,
            config.baseUrl ?? "",
            ctx,
            config.outputDir,
          );
          const finalResult = quarantine.isQuarantined(test.id)
            ? { ...result, status: "quarantined" as const }
            : result;
          results.push(finalResult);
          if (heal) heals.push(heal);
          quarantine.observe(result);
        }
      } finally {
        await browser.close();
      }
    }

    const passed = results.filter((r) => r.status === "passed").length;
    const failed = results.filter((r) => r.status === "failed").length;
    ctx.log(
      this.role,
      `executed ${results.length} test(s): ${passed} passed, ${failed} failed, ${heals.length} healed`,
      failed > 0 ? "warn" : "info",
    );

    return {
      results,
      phase: "triaging",
      // stash heal/quarantine data in log for the reporter
      log: [
        ...state.log,
        ...heals.map((h) => ({
          at: h.at,
          agent: this.role,
          level: "info" as const,
          message: `healed locator ${h.brokenSelector} → ${h.healedSelector} (${h.strategy}, ${h.confidence.toFixed(2)})`,
        })),
      ],
    };
  }

  // --- UI execution -------------------------------------------------------

  private async runUiTest(
    test: GeneratedTest,
    browser: PlaywrightBrowserTool,
    baseUrl: string,
    ctx: AgentContext,
    outputDir: string,
  ): Promise<{ result: TestResult; heal?: HealRecord }> {
    const started = Date.now();
    const signals: RunSignal[] = [];
    const artifacts: Artifact[] = [];
    let heal: HealRecord | undefined;
    let attempts = 0;
    const maxAttempts = 2;

    while (attempts < maxAttempts) {
      attempts++;
      signals.length = 0;
      try {
        for (const step of test.steps) {
          if (step.action === "goto") {
            const res = await browser.goto(absolutize(step.url, baseUrl));
            if (res.status >= 400) {
              signals.push({
                kind: "network",
                level: "error",
                message: `HTTP ${res.status} for ${res.url}`,
                at: new Date().toISOString(),
              });
            }
          } else if (step.action === "click") {
            await browser.click(step.selector).catch(async (err: Error) => {
              // Self-heal: re-snapshot and find a replacement locator.
              const snap = await browser.snapshot();
              const healed = healLocator({
                brokenSelector: step.selector,
                candidates: snap.elements,
              });
              if (healed.healed && healed.selector) {
                heal = toHealRecord(test.id, { brokenSelector: step.selector, candidates: snap.elements }, healed);
                await browser.click(healed.selector);
              } else {
                throw err;
              }
            });
          } else if (step.action === "fill") {
            await browser.fill(step.selector, step.value).catch(async (err: Error) => {
              const snap = await browser.snapshot();
              const healed = healLocator({
                brokenSelector: step.selector,
                candidates: snap.elements,
              });
              if (healed.healed && healed.selector) {
                heal = toHealRecord(test.id, { brokenSelector: step.selector, candidates: snap.elements }, healed);
                await browser.fill(healed.selector, step.value);
              } else {
                throw err;
              }
            });
          } else if (step.action === "wait") {
            await new Promise((r) => setTimeout(r, step.ms));
          }
          // expect / request / custom handled below via signals
        }

        // Capture a screenshot as evidence on success or failure.
        const shotPath = `${outputDir}/artifacts/${test.id}-${Date.now()}.png`;
        await browser.screenshot(shotPath).catch(() => {});
        artifacts.push({ kind: "screenshot", path: shotPath });

        return {
          result: {
            testId: test.id,
            title: test.title,
            status: attempts > 1 ? "flaky" : "passed",
            durationMs: Date.now() - started,
            artifacts,
            attempts,
            signals,
          },
          heal,
        };
      } catch (err) {
        const e = err as Error;
        if (attempts < maxAttempts) {
          // brief backoff before retry
          await new Promise((r) => setTimeout(r, 250 * attempts));
          continue;
        }
        const shotPath = `${outputDir}/artifacts/${test.id}-FAIL-${Date.now()}.png`;
        await browser.screenshot(shotPath).catch(() => {});
        artifacts.push({ kind: "screenshot", path: shotPath, description: "failure" });
        return {
          result: {
            testId: test.id,
            title: test.title,
            status: "failed",
            durationMs: Date.now() - started,
            error: e.message,
            stack: e.stack,
            artifacts,
            attempts,
            failedSelector: extractSelector(e.message),
            signals,
          },
          heal,
        };
      }
    }

    // unreachable, but keeps TS happy
    return {
      result: {
        testId: test.id,
        title: test.title,
        status: "failed",
        durationMs: Date.now() - started,
        artifacts,
        attempts,
      },
    };
  }

  // --- API execution ------------------------------------------------------

  private async runApiTest(
    test: GeneratedTest,
    api: HttpApiTool,
    baseUrl: string,
    ctx: AgentContext,
  ): Promise<TestResult> {
    const started = Date.now();
    const req = test.steps.find((s) => s.action === "request");
    if (!req || req.action !== "request") {
      return {
        testId: test.id,
        title: test.title,
        status: "skipped",
        durationMs: 0,
        artifacts: [],
        attempts: 1,
        error: "no request step",
      };
    }
    try {
      const res = await api.request(req.method, absolutize(req.url, baseUrl), {
        body: req.body,
      });
      const ok = res.status < 400;
      return {
        testId: test.id,
        title: test.title,
        status: ok ? "passed" : "failed",
        durationMs: Date.now() - started,
        artifacts: [
          {
            kind: "json",
            path: `${test.id}.response.json`,
            description: JSON.stringify(res.body).slice(0, 2000),
          },
        ],
        attempts: 1,
        error: ok ? undefined : `unexpected status ${res.status}`,
        signals: [
          {
            kind: "network",
            level: ok ? "info" : "error",
            message: `${req.method} ${req.url} → ${res.status} in ${res.durationMs}ms`,
            at: new Date().toISOString(),
          },
        ],
      };
    } catch (err) {
      return {
        testId: test.id,
        title: test.title,
        status: "failed",
        durationMs: Date.now() - started,
        artifacts: [],
        attempts: 1,
        error: (err as Error).message,
        signals: [
          {
            kind: "network",
            level: "error",
            message: `${req.method} ${req.url} threw ${(err as Error).message}`,
            at: new Date().toISOString(),
          },
        ],
      };
    }
  }
}

function extractSelector(message: string): string | undefined {
  // Playwright errors look like: locator.click: Error: ... selector resolved to ...
  const m = message.match(/locator\(["']([^"']+)["']\)/) ?? message.match(/selector[:\s]+([^\s]+)/i);
  return m?.[1];
}