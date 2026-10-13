import type { Agent, AgentContext } from "./base.js";
import { askJson } from "./base.js";
import type { CoverageGap, SwarmState } from "../types.js";
import { createIssueTracker } from "../tools/issue-tracker.js";
import { COVERAGE_SYSTEM, coveragePrompt } from "../llm/prompts.js";

/**
 * Reporter agent.
 *
 * Responsibilities:
 *  - detect coverage gaps (pages explored but not tested)
 *  - file bugs to the configured issue tracker
 *  - produce the run manifest consumed by CI
 */
export class ReporterAgent implements Agent {
  readonly role = "reporter" as const;

  async run(state: SwarmState, ctx: AgentContext): Promise<Partial<SwarmState>> {
    const testedOrigins = new Set(state.tests.map((t) => t.origin));
    const untested = state.pages.filter((p) => !testedOrigins.has(p.url));

    let gaps: CoverageGap[] = untested.map((p) => ({
      area: p.url,
      description: `Page "${p.title || p.url}" (role: ${p.role}) was explored but has no generated test.`,
      confidence: 0.8,
      suggestion: `Add a smoke test for ${p.url} covering ${
        p.elements
          .slice(0, 3)
          .map((e) => e.name)
          .join(", ") || "page load"
      }.`,
    }));

    if (!ctx.budget.exhausted && state.pages.length > 0) {
      const llmGaps = await askJson<CoverageGap[]>(
        ctx,
        this.role,
        [
          { role: "system", content: COVERAGE_SYSTEM },
          {
            role: "user",
            content: coveragePrompt({ pages: state.pages, tests: state.tests }),
          },
        ],
        [],
        1024,
      );
      if (Array.isArray(llmGaps)) gaps = dedupeGaps([...gaps, ...llmGaps]);
    }

    const tracker = createIssueTracker({
      outputDir: `${state.config.outputDir}/bugs`,
      dryRun: state.config.dryRun,
    });
    const bugs = [...state.bugs];
    for (const bug of bugs) {
      if (bug.externalRef) continue;
      try {
        const { ref, url } = await tracker.file(bug);
        bug.externalRef = url ?? ref;
        ctx.log(this.role, `filed ${bug.id} → ${bug.externalRef}`, "info");
      } catch (err) {
        ctx.log(
          this.role,
          `failed to file ${bug.id}: ${(err as Error).message}`,
          "warn",
        );
      }
    }

    ctx.log(
      this.role,
      `report ready: ${bugs.length} bug(s), ${gaps.length} coverage gap(s)`,
    );
    return { coverageGaps: gaps, bugs, phase: "done" };
  }
}

function dedupeGaps(gaps: CoverageGap[]): CoverageGap[] {
  const byArea = new Map<string, CoverageGap>();
  for (const g of gaps) {
    const existing = byArea.get(g.area);
    if (!existing || g.confidence > existing.confidence) byArea.set(g.area, g);
  }
  return [...byArea.values()];
}