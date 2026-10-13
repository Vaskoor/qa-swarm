import type { Agent, AgentContext } from "../agents/base.js";
import { BudgetGuard } from "../agents/base.js";
import { ExplorerAgent } from "../agents/explorer.js";
import { TestGeneratorAgent } from "../agents/test-generator.js";
import { ExecutorAgent } from "../agents/executor.js";
import { TriageAgent } from "../agents/triage.js";
import { SecurityAgent } from "../agents/security.js";
import { PerformanceAgent } from "../agents/performance.js";
import { ReporterAgent } from "../agents/reporter.js";
import { createProvider } from "../llm/provider.js";
import { SwarmMemory } from "../memory/memory.js";
import { loadOpenApi } from "../tools/openapi.js";
import type {
  AgentLogEntry,
  AgentRole,
  SwarmConfig,
  SwarmState,
} from "../types.js";
import { DEFAULT_CONFIG } from "../types.js";

/**
 * QA-Swarm orchestrator.
 *
 * A state graph that runs the configured agents in order, merging each
 * agent's partial state patch. It intentionally avoids a hard dependency on
 * @langchain/langgraph so the core is runnable in any Node 20+ environment;
 * `langgraph-adapter.ts` exposes the same nodes to LangGraph for teams that
 * want its tracing/UI.
 */
export class SwarmGraph {
  private ctx: AgentContext;
  private agents: Map<AgentRole, Agent>;
  private memory: SwarmMemory;

  constructor(
    private config: SwarmConfig,
    opts?: { onLog?: (e: AgentLogEntry) => void },
  ) {
    const llm = createProvider(config);
    this.memory = new SwarmMemory(config);
    const memory = this.memory;
    const budget = new BudgetGuard(config.budget.maxLlmCalls, config.budget.maxTokens);

    this.ctx = {
      llm,
      memory,
      budget,
      log: (agent, message, level = "info", data) => {
        const entry: AgentLogEntry = {
          at: new Date().toISOString(),
          agent,
          message,
          level,
          data,
        };
        opts?.onLog?.(entry);
      },
    };

    const registry: Agent[] = [
      new ExplorerAgent(),
      new TestGeneratorAgent(),
      new ExecutorAgent(),
      new TriageAgent(),
      new SecurityAgent(),
      new PerformanceAgent(),
      new ReporterAgent(),
    ];
    this.agents = new Map(registry.map((a) => [a.role, a]));
  }

  async run(partial?: Partial<SwarmConfig>): Promise<SwarmState> {
    const config: SwarmConfig = { ...DEFAULT_CONFIG, ...this.config, ...partial };
    const runId = `run-${Date.now().toString(36)}`;

    let state: SwarmState = {
      config,
      pages: [],
      apiEndpoints: [],
      tests: [],
      results: [],
      verdicts: [],
      bugs: [],
      coverageGaps: [],
      securityFindings: [],
      performanceFindings: [],
      log: [],
      feedback: [],
      usage: { llmCalls: 0, tokens: 0 },
      errors: [],
      phase: "init",
      runId,
    };

    this.ctx.log("explorer", `QA-Swarm run ${runId} starting — target ${config.target}`);
    this.ctx.log("explorer", `memory backend: ${this.memory.backend}`);

    // Pre-load OpenAPI endpoints if requested.
    if (config.targetKind === "openapi" || config.targetKind === "both") {
      try {
        const endpoints = await loadOpenApi(config.target);
        state.apiEndpoints = endpoints;
        this.ctx.log("explorer", `loaded ${endpoints.length} API endpoint(s) from spec`);
      } catch (err) {
        state.errors.push(`openapi load failed: ${(err as Error).message}`);
        this.ctx.log("explorer", `openapi load failed: ${(err as Error).message}`, "error");
      }
    }

    for (const role of config.agents) {
      if (this.ctx.budget.exhausted) {
        this.ctx.log(role, "budget exhausted — stopping", "warn");
        break;
      }
      const agent = this.agents.get(role);
      if (!agent) {
        state.errors.push(`unknown agent: ${role}`);
        continue;
      }
      try {
        const patch = await agent.run(state, this.ctx);
        state = mergeState(state, patch);
      } catch (err) {
        const msg = `${role} failed: ${(err as Error).message}`;
        state.errors.push(msg);
        this.ctx.log(role, msg, "error");
      }
    }

    state.usage = this.ctx.budget.usage;
    state.phase = state.errors.length && state.tests.length === 0 ? "failed" : "done";
    this.ctx.log(
      "reporter",
      `run complete in phase=${state.phase}: ${state.tests.length} tests, ${state.results.filter((r) => r.status === "failed").length} failures, ${state.bugs.length} bugs`,
    );

    // Mirror the log produced during the run into state.
    return state;
  }

  get memoryStore(): SwarmMemory {
    return this.memory;
  }
}

/**
 * Merge an agent's partial patch into state. Arrays are the tricky part:
 * some agents append (results, bugs) and some replace (pages). We follow the
 * convention that a patch array REPLACES the field — agents that want to
 * append explicitly spread the existing value in, which keeps semantics
 * obvious at the call site.
 */
export function mergeState(state: SwarmState, patch: Partial<SwarmState>): SwarmState {
  const next: SwarmState = { ...state, ...patch };
  // `log` is special: it accumulates across patches unless the patch is a
  // superset that already contains the prior entries.
  if (patch.log && patch.log.length >= state.log.length) {
    next.log = patch.log;
  } else if (patch.log) {
    next.log = [...state.log, ...patch.log];
  }
  return next;
}