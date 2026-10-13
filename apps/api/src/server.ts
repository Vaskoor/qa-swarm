import express from "express";
import path from "path";
import fs from "fs";
import { fileURLToPath } from "url";
import {
  DEFAULT_CONFIG,
  SwarmGraph,
  writeRunArtifacts,
  type AgentLogEntry,
  type SwarmConfig,
  type SwarmState,
} from "@qa-swarm/core";

/**
 * Thin HTTP API around the swarm + a static dashboard.
 *
 *   GET  /health        — liveness + run count
 *   GET  /              — the dashboard UI (apps/web/index.html)
 *   GET  /ui            — alias for /
 *   POST /runs          — start a swarm run (fire-and-forget)
 *   GET  /runs          — list all runs (summary)
 *   GET  /runs/:id      — full run state (summary, bugs, results, logs)
 *
 * Runs are kept in memory — this is a control plane for demos and small
 * teams, not a durable job queue. Swap in Redis/Postgres for multi-node.
 */
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEB_DIR = path.resolve(__dirname, "../../web");

const app = express();
app.use(express.json({ limit: "1mb" }));

interface Run {
  id: string;
  status: "running" | "done" | "failed";
  startedAt: string;
  finishedAt?: string;
  state?: SwarmState;
  logs: AgentLogEntry[];
  error?: string;
}

const runs = new Map<string, Run>();
const startedAt = Date.now();

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    runs: runs.size,
    version: "0.1.0",
    uptime: Math.round((Date.now() - startedAt) / 1000),
  });
});

// serve the dashboard
const indexHtml = path.join(WEB_DIR, "index.html");
app.get(["/", "/ui"], (_req, res) => {
  if (fs.existsSync(indexHtml)) return res.sendFile(indexHtml);
  res.status(404).type("text").send("dashboard not built — apps/web/index.html missing");
});

app.post("/runs", async (req, res) => {
  const body = req.body as Partial<SwarmConfig> & { target?: string };
  if (!body.target) {
    res.status(400).json({ error: "target is required" });
    return;
  }

  const config: SwarmConfig = { ...DEFAULT_CONFIG, ...body, target: body.target };
  const id = `run-${Date.now().toString(36)}`;
  const run: Run = {
    id,
    status: "running",
    startedAt: new Date().toISOString(),
    logs: [],
  };
  runs.set(id, run);

  // Fire and forget — the client polls /runs/:id.
  void (async () => {
    try {
      const graph = new SwarmGraph(config, {
        onLog: (e) => {
          run.logs.push(e);
          if (run.logs.length > 5000) run.logs.splice(0, run.logs.length - 5000);
        },
      });
      const state = await graph.run();
      run.state = state;
      run.status = state.phase === "failed" ? "failed" : "done";
      run.finishedAt = new Date().toISOString();
      await writeRunArtifacts(state);
    } catch (err) {
      run.status = "failed";
      run.error = (err as Error).message;
      run.finishedAt = new Date().toISOString();
    }
  })();

  res.status(202).json({ id, status: "running", poll: `/runs/${id}` });
});

app.get("/runs", (_req, res) => {
  res.json(
    [...runs.values()].map((r) => ({
      id: r.id,
      status: r.status,
      startedAt: r.startedAt,
      finishedAt: r.finishedAt,
      tests: r.state?.tests.length ?? 0,
      bugs: r.state?.bugs.length ?? 0,
    })),
  );
});

app.get("/runs/:id", (req, res) => {
  const run = runs.get(req.params.id);
  if (!run) {
    res.status(404).json({ error: "run not found" });
    return;
  }
  res.json({
    id: run.id,
    status: run.status,
    startedAt: run.startedAt,
    finishedAt: run.finishedAt,
    error: run.error,
    summary: run.state
      ? {
          phase: run.state.phase,
          pages: run.state.pages.length,
          endpoints: run.state.apiEndpoints.length,
          tests: run.state.tests.length,
          results: run.state.results.length,
          passed: run.state.results.filter((r) => r.status === "passed").length,
          failed: run.state.results.filter((r) => r.status === "failed").length,
          bugs: run.state.bugs.length,
          securityFindings: run.state.securityFindings.length,
          performanceFindings: run.state.performanceFindings.length,
          coverageGaps: run.state.coverageGaps.length,
          usage: run.state.usage,
        }
      : undefined,
    bugs: run.state?.bugs ?? [],
    results: run.state?.results ?? [],
    logs: run.logs.slice(-200),
  });
});

const port = Number(process.env.PORT ?? 4317);
app.listen(port, () => {
  console.log(`qa-swarm api + dashboard → http://localhost:${port}`);
  console.log(`  health:  http://localhost:${port}/health`);
  console.log(`  dashboard: http://localhost:${port}/`);
});
