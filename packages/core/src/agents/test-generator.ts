import { createHash } from "node:crypto";
import type { Agent, AgentContext } from "./base.js";
import { askJson } from "./base.js";
import type {
  DiscoveredPage,
  GeneratedTest,
  SwarmState,
  TestStep,
} from "../types.js";
import { GENERATOR_SYSTEM, generatorPrompt } from "../llm/prompts.js";
import { renderPlaywright } from "../report/render-playwright.js";
import { buildRequest, sampleFor } from "../tools/openapi.js";

interface RawTest {
  title: string;
  kind?: string;
  intent?: string;
  steps?: TestStep[];
  expected?: string;
  tags?: string[];
  priority?: "P0" | "P1" | "P2";
}

/**
 * Test Generator agent.
 *
 * For each discovered page it derives intents deterministically, then asks
 * the LLM to expand them into concrete steps. API endpoints from an OpenAPI
 * spec are turned into contract tests without any LLM involvement.
 */
export class TestGeneratorAgent implements Agent {
  readonly role = "test-generator" as const;

  async run(state: SwarmState, ctx: AgentContext): Promise<Partial<SwarmState>> {
    const { config } = state;
    const tests: GeneratedTest[] = [...state.tests];

    for (const page of state.pages) {
      if (tests.length >= config.maxTests) break;
      const bias = await ctx.memory.feedbackBias(page.url);
      const intents = deriveIntents(page);
      if (bias < -0.5 && intents.length > 1) intents.pop();

      for (const intent of intents) {
        if (tests.length >= config.maxTests) break;
        const raw = await askJson<RawTest[]>(
          ctx,
          this.role,
          [
            { role: "system", content: GENERATOR_SYSTEM },
            { role: "user", content: generatorPrompt({ page, intent, count: 2 }) },
          ],
          [],
          2048,
        );

        const generated =
          Array.isArray(raw) && raw.length > 0 ? raw : [fallbackTest(page, intent)];

        for (const r of generated) {
          if (tests.length >= config.maxTests) break;
          const test = normalizeTest(r, page, intent);
          if (await this.isDuplicate(test, tests, ctx)) continue;
          test.code = renderPlaywright(test, config.baseUrl ?? "");
          tests.push(test);
          await ctx.memory.rememberTest(test);
        }
      }
    }

    for (const ep of state.apiEndpoints) {
      if (tests.length >= config.maxTests) break;
      const test = apiContractTest(ep, config.baseUrl ?? "");
      test.code = renderPlaywright(test, config.baseUrl ?? "");
      tests.push(test);
      await ctx.memory.rememberTest(test);
    }

    ctx.log(this.role, `generated ${tests.length} test(s)`);
    return { tests, phase: "executing" };
  }

  private async isDuplicate(
    candidate: GeneratedTest,
    existing: GeneratedTest[],
    ctx: AgentContext,
  ): Promise<boolean> {
    if (existing.some((t) => t.fingerprint === candidate.fingerprint)) return true;
    const similar = await ctx.memory.findSimilarTests(candidate.intent, 3);
    return similar.some((s) => s.score > 0.95);
  }
}

function deriveIntents(page: DiscoveredPage): string[] {
  const intents: string[] = [`smoke: page renders without console errors`];
  const formFields = page.elements.filter((e) => e.fillable);
  const buttons = page.elements.filter((e) => e.clickable);
  if (formFields.length > 0 && buttons.length > 0) {
    intents.push(`form: submit the primary form with valid data`);
    intents.push(`form-validation: submit the form empty and expect validation`);
  }
  if (page.role === "auth") {
    intents.push(`auth: reject invalid credentials`);
  }
  if (buttons.length > 2) {
    intents.push(`navigation: primary actions are reachable and respond`);
  }
  return intents.slice(0, 4);
}

function fallbackTest(page: DiscoveredPage, intent: string): RawTest {
  const steps: TestStep[] = [{ action: "goto", url: page.url }];
  const firstHeading = page.elements[0];
  if (firstHeading) {
    steps.push({
      action: "expect",
      assertion: `page has element "${firstHeading.name}"`,
      description: firstHeading.name,
    });
  }
  steps.push({
    action: "expect",
    assertion: "no page errors were emitted",
  });
  return {
    title: `${intent} — ${page.title || page.url}`,
    kind: "ui",
    intent,
    steps,
    expected: "page behaves as described without errors",
    tags: [page.role, "smoke"],
    priority: "P1",
  };
}

function normalizeTest(
  raw: RawTest,
  page: DiscoveredPage,
  intent: string,
): GeneratedTest {
  const id = `ui_${slug(page.url)}_${slug(raw.title).slice(0, 40)}`;
  const steps: TestStep[] =
    Array.isArray(raw.steps) && raw.steps.length
      ? raw.steps
      : [{ action: "goto", url: page.url }];
  if (steps[0]?.action !== "goto") steps.unshift({ action: "goto", url: page.url });
  const test: GeneratedTest = {
    id,
    title: raw.title || intent,
    kind: (raw.kind as GeneratedTest["kind"]) || "ui",
    origin: page.url,
    intent: raw.intent || intent,
    steps,
    expected: raw.expected || "no errors",
    tags: raw.tags?.length ? raw.tags : [page.role, "generated"],
    priority: raw.priority ?? "P1",
  };
  test.fingerprint = fingerprint(test);
  return test;
}

function apiContractTest(
  ep: SwarmState["apiEndpoints"][number],
  baseUrl: string,
): GeneratedTest {
  const sample: Record<string, string> = {};
  for (const p of ep.parameters) sample[p.name] = sampleFor(p.name, p.schema);
  const { url } = buildRequest(baseUrl, ep, sample);
  const okStatuses = Object.keys(ep.responses).filter((s) => Number(s) < 400);
  const test: GeneratedTest = {
    id: `api_${ep.method.toLowerCase()}_${slug(ep.path)}`,
    title: `API contract: ${ep.method} ${ep.path}`,
    kind: "api",
    origin: url,
    intent: `endpoint responds with documented status and schema`,
    steps: [
      { action: "request", method: ep.method, url },
      {
        action: "expect",
        assertion: `status is one of ${okStatuses.join(",") || "2xx"}`,
      },
    ],
    expected: `HTTP ${okStatuses[0] ?? "2xx"} with valid schema`,
    tags: ["api", "contract", ...ep.tags],
    priority: "P0",
  };
  test.fingerprint = fingerprint(test);
  return test;
}

export function fingerprint(test: GeneratedTest): string {
  const basis = `${test.kind}|${test.origin}|${test.intent}|${test.steps
    .map((s) => s.action)
    .join(",")}`;
  return createHash("sha1").update(basis).digest("hex").slice(0, 16);
}

function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "").slice(0, 60);
}