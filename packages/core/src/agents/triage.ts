import { createHash } from "node:crypto";
import type { Agent, AgentContext } from "./base.js";
import { askJson } from "./base.js";
import type {
  BugReport,
  GeneratedTest,
  Severity,
  SwarmState,
  TestResult,
  TriageVerdict,
} from "../types.js";
import { TRIAGE_SYSTEM, triagePrompt } from "../llm/prompts.js";

interface RawVerdict {
  classification?: TriageVerdict["classification"];
  confidence?: number;
  rootCause?: string;
  evidence?: string[];
  reproducible?: boolean;
  recommendation?: string;
}

/**
 * Triage agent.
 *
 * Reads failures, classifies each one, and — when the verdict is
 * `product-bug` — produces a BugReport with evidence and a stable
 * fingerprint (so re-runs dedupe instead of re-filing).
 */
export class TriageAgent implements Agent {
  readonly role = "triage" as const;

  async run(state: SwarmState, ctx: AgentContext): Promise<Partial<SwarmState>> {
    const failures = state.results.filter(
      (r) => r.status === "failed" || r.status === "flaky",
    );
    const verdicts: TriageVerdict[] = [...state.verdicts];
    const bugs: BugReport[] = [...state.bugs];
    const testById = new Map(state.tests.map((t) => [t.id, t]));

    for (const result of failures) {
      const test = testById.get(result.testId);
      const raw = await askJson<RawVerdict>(
        ctx,
        this.role,
        [
          { role: "system", content: TRIAGE_SYSTEM },
          { role: "user", content: triagePrompt(result, test) },
        ],
        heuristicVerdict(result),
        1024,
      );

      const verdict = normalizeVerdict(result.testId, raw);
      verdicts.push(verdict);
      await ctx.memory.rememberVerdict(verdict);

      if (verdict.classification === "product-bug" && test) {
        const bug = buildBug(result, test, verdict, state);
        // dedupe against existing bugs by fingerprint
        if (!bugs.some((b) => b.fingerprint === bug.fingerprint)) {
          bugs.push(bug);
          await ctx.memory.rememberBug(bug);
        }
      }

      ctx.log(
        this.role,
        `${result.testId}: ${verdict.classification} (${verdict.confidence.toFixed(2)})`,
        verdict.classification === "product-bug" ? "warn" : "info",
      );
    }

    ctx.log(this.role, `triaged ${failures.length} failure(s), ${bugs.length} bug(s)`);
    return { verdicts, bugs, phase: "security" };
  }
}

function heuristicVerdict(result: TestResult): RawVerdict {
  const err = (result.error ?? "").toLowerCase();
  let classification: TriageVerdict["classification"] = "unknown";
  let confidence = 0.4;
  let rootCause = "insufficient evidence";

  if (/timeout|econnrefused|enotfound|net::/.test(err)) {
    classification = "environment";
    confidence = 0.7;
    rootCause = "network or service unavailable";
  } else if (/expected|tobe|assert/i.test(err)) {
    classification = "product-bug";
    confidence = 0.55;
    rootCause = "assertion failed — behaviour differs from expectation";
  } else if (/locator|selector|strict mode/i.test(err)) {
    classification = "test-bug";
    confidence = 0.6;
    rootCause = "selector no longer matches the DOM";
  } else if (result.attempts > 1 && result.status === "flaky") {
    classification = "flaky";
    confidence = 0.6;
    rootCause = "passed on retry — non-deterministic";
  }

  return {
    classification,
    confidence,
    rootCause,
    evidence: (result.signals ?? []).map((s) => `${s.kind}: ${s.message}`).slice(0, 5),
    reproducible: result.attempts > 1 && result.status === "failed",
    recommendation:
      classification === "product-bug"
        ? "investigate application logic; attach trace to issue"
        : classification === "flaky"
          ? "quarantine and investigate timing dependency"
          : "review test or environment",
  };
}

function normalizeVerdict(testId: string, raw: RawVerdict): TriageVerdict {
  const valid = new Set([
    "product-bug",
    "test-bug",
    "flaky",
    "environment",
    "unknown",
  ]);
  const classification = valid.has(raw.classification ?? "")
    ? (raw.classification as TriageVerdict["classification"])
    : "unknown";
  return {
    testId,
    classification,
    confidence: clamp(raw.confidence ?? 0.5, 0, 1),
    rootCause: raw.rootCause ?? "unspecified",
    evidence: Array.isArray(raw.evidence) ? raw.evidence : [],
    reproducible: Boolean(raw.reproducible),
    recommendation: raw.recommendation ?? "manual review",
  };
}

export function buildBug(
  result: TestResult,
  test: GeneratedTest,
  verdict: TriageVerdict,
  state: SwarmState,
): BugReport {
  const fingerprint = createHash("sha1")
    .update(`${test.origin}|${test.intent}|${result.error ?? ""}`)
    .digest("hex")
    .slice(0, 16);

  const steps = test.steps.map((s) => {
    switch (s.action) {
      case "goto":
        return `Navigate to ${s.url}`;
      case "click":
        return `Click ${s.selector}`;
      case "fill":
        return `Fill ${s.selector} with "${s.value}"`;
      case "expect":
        return `Assert: ${s.assertion}`;
      case "request":
        return `Send ${s.method} ${s.url}`;
      case "wait":
        return `Wait ${s.ms}ms`;
      default:
        return "Custom step";
    }
  });

  const severity = severityFor(test, verdict);

  return {
    id: `BUG-${fingerprint.slice(0, 8)}`,
    title: `${test.title} — ${verdict.rootCause}`,
    summary: [
      `Automated test "${test.title}" failed.`,
      `Triage classified this as **${verdict.classification}** with ${(verdict.confidence * 100).toFixed(0)}% confidence.`,
      `Root cause: ${verdict.rootCause}`,
      verdict.evidence.length ? `Evidence:\n${verdict.evidence.map((e) => `- ${e}`).join("\n")}` : "",
    ]
      .filter(Boolean)
      .join("\n\n"),
    severity,
    stepsToReproduce: steps,
    expected: test.expected,
    actual: result.error ?? "test failed without a captured error",
    evidence: result.artifacts,
    environment: {
      target: state.config.target,
      baseUrl: state.config.baseUrl ?? state.config.target,
      headless: String(state.config.headless),
      runId: state.runId,
      node: process.version,
      platform: process.platform,
    },
    target: process.env.JIRA_BASE_URL ? "jira" : process.env.GITHUB_TOKEN ? "github" : "local",
    fingerprint,
    createdAt: new Date().toISOString(),
  };
}

function severityFor(test: GeneratedTest, verdict: TriageVerdict): Severity {
  if (test.priority === "P0" && verdict.confidence > 0.7) return "critical";
  if (test.priority === "P0") return "major";
  if (test.priority === "P1" && verdict.confidence > 0.7) return "major";
  if (verdict.reproducible) return "major";
  return "minor";
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}