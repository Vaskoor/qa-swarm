import type { Agent, AgentContext } from "./base.js";
import type { PerformanceFinding, SwarmState } from "../types.js";
import { HttpApiTool } from "../tools/api.js";

/**
 * Performance agent.
 *
 * Runs deterministic budget checks (TTFB, payload size, request count) using
 * real HTTP timings. No LLM involved: performance numbers must be measured,
 * not guessed. Budgets are configurable via env so teams can tune CI.
 */
const BUDGETS = {
  ttfbMs: Number(process.env.QA_TTFB_BUDGET_MS ?? 800),
  payloadKb: Number(process.env.QA_PAYLOAD_BUDGET_KB ?? 2048),
  requestCount: Number(process.env.QA_REQUEST_BUDGET ?? 60),
};

export class PerformanceAgent implements Agent {
  readonly role = "performance" as const;

  async run(state: SwarmState, ctx: AgentContext): Promise<Partial<SwarmState>> {
    const findings: PerformanceFinding[] = [...state.performanceFindings];
    const api = new HttpApiTool();
    const urls = [
      state.config.baseUrl ?? state.config.target,
      ...state.pages.slice(0, 5).map((p) => p.url),
    ].filter((u) => /^https?:\/\//.test(u));

    const seen = new Set<string>();
    for (const url of urls) {
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const samples: number[] = [];
        let last = await api.request("GET", url);
        for (let i = 0; i < 3; i++) {
          const r = await api.request("GET", url);
          samples.push(r.durationMs);
          last = r;
        }
        const p50 = median(samples);

        findings.push({
          id: `PERF-${slug(url)}-ttfb`,
          url,
          metric: "ttfb",
          value: p50,
          unit: "ms",
          budget: BUDGETS.ttfbMs,
          passed: p50 <= BUDGETS.ttfbMs,
          recommendation:
            p50 <= BUDGETS.ttfbMs
              ? "within budget"
              : `TTFB p50 ${p50}ms exceeds ${BUDGETS.ttfbMs}ms — check server-side caching and DB queries.`,
        });

        const bytes = Buffer.byteLength(last.bodyText ?? "", "utf8");
        const kb = bytes / 1024;
        findings.push({
          id: `PERF-${slug(url)}-payload`,
          url,
          metric: "payload",
          value: Math.round(kb),
          unit: "KB",
          budget: BUDGETS.payloadKb,
          passed: kb <= BUDGETS.payloadKb,
          recommendation:
            kb <= BUDGETS.payloadKb
              ? "within budget"
              : `Payload ${Math.round(kb)}KB exceeds ${BUDGETS.payloadKb}KB — enable compression or trim response.`,
        });
      } catch (err) {
        ctx.log(this.role, `perf probe failed for ${url}: ${(err as Error).message}`, "warn");
      }
    }

    // Browser-side metrics for pages that were explored.
    for (const page of state.pages.slice(0, 3)) {
      const reqCount = page.network.length;
      findings.push({
        id: `PERF-${slug(page.url)}-requests`,
        url: page.url,
        metric: "request-count",
        value: reqCount,
        unit: "requests",
        budget: BUDGETS.requestCount,
        passed: reqCount <= BUDGETS.requestCount,
        recommendation:
          reqCount <= BUDGETS.requestCount
            ? "within budget"
            : `${reqCount} requests exceeds budget of ${BUDGETS.requestCount} — consider bundling or lazy-loading.`,
      });
    }

    const failed = findings.filter((f) => !f.passed).length;
    ctx.log(this.role, `${findings.length} metric(s), ${failed} over budget`);
    return { performanceFindings: findings, phase: "reporting" };
  }
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid]! : Math.round((s[mid - 1]! + s[mid]!) / 2);
}

function slug(s: string): string {
  return s.replace(/[^a-z0-9]/gi, "_").slice(0, 40);
}