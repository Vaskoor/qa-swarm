import { promises as fs } from "node:fs";
import path from "node:path";
import type { SwarmState } from "../types.js";
import { renderJUnit, renderRunReport } from "./markdown.js";

/**
 * Persists every artifact a run produces:
 *   <outputDir>/
 *     report.md           — human-readable run report
 *     junit.xml           — CI-consumable results
 *     state.json          — full machine-readable state
 *     bugs/*.md           — one file per bug (when filed locally)
 *     tests/*.spec.ts     — the generated Playwright specs
 *     screenshots/        — page + failure screenshots
 */
export async function writeRunArtifacts(state: SwarmState): Promise<{
  reportPath: string;
  junitPath: string;
  statePath: string;
  testFiles: string[];
}> {
  const out = state.config.outputDir;
  await fs.mkdir(out, { recursive: true });
  await fs.mkdir(path.join(out, "tests"), { recursive: true });
  await fs.mkdir(path.join(out, "bugs"), { recursive: true });
  await fs.mkdir(path.join(out, "artifacts"), { recursive: true });
  await fs.mkdir(path.join(out, "screenshots"), { recursive: true });

  const reportPath = path.join(out, "report.md");
  const junitPath = path.join(out, "junit.xml");
  const statePath = path.join(out, "state.json");

  await fs.writeFile(reportPath, renderRunReport(state), "utf8");
  await fs.writeFile(junitPath, renderJUnit(state), "utf8");
  await fs.writeFile(
    statePath,
    JSON.stringify(
      {
        runId: state.runId,
        phase: state.phase,
        config: state.config,
        pages: state.pages.map((p) => ({ url: p.url, title: p.title, role: p.role })),
        apiEndpoints: state.apiEndpoints.length,
        tests: state.tests.map((t) => ({
          id: t.id,
          title: t.title,
          kind: t.kind,
          origin: t.origin,
          priority: t.priority,
          fingerprint: t.fingerprint,
        })),
        results: state.results,
        verdicts: state.verdicts,
        bugs: state.bugs,
        coverageGaps: state.coverageGaps,
        securityFindings: state.securityFindings,
        performanceFindings: state.performanceFindings,
        usage: state.usage,
        errors: state.errors,
      },
      null,
      2,
    ),
    "utf8",
  );

  // Write generated Playwright specs (one file per test for clean diffs).
  const testFiles: string[] = [];
  for (const t of state.tests) {
    if (!t.code) continue;
    const file = path.join(out, "tests", `${t.id}.spec.ts`);
    await fs.writeFile(file, t.code, "utf8");
    testFiles.push(file);
  }

  // Write the quarantine snapshot so the next run can restore it.
  await fs.writeFile(
    path.join(out, "quarantine.json"),
    JSON.stringify(
      {
        quarantined: state.results
          .filter((r) => r.status === "quarantined")
          .map((r) => ({ testId: r.testId, title: r.title })),
      },
      null,
      2,
    ),
    "utf8",
  );

  return { reportPath, junitPath, statePath, testFiles };
}