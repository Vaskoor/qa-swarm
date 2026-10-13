import type { SwarmState } from "../types.js";

/**
 * Optional LangGraph adapter.
 *
 * QA-Swarm's core graph is dependency-free so it runs anywhere. Teams that
 * want LangGraph's tracing, checkpointing, and Studio UI can build an
 * equivalent graph here. The node names match the AgentRole values so the
 * two orchestrators are interchangeable.
 *
 * Usage:
 *   import { buildLangGraph } from "@qa-swarm/core/graph/langgraph-adapter";
 *   const app = await buildLangGraph();
 *   const out = await app.invoke(initialState);
 *
 * `@langchain/langgraph` is an optional dependency — install it only if you
 * use this adapter.
 */
export interface LangGraphNodeSpec {
  name: string;
  run: (state: SwarmState) => Promise<Partial<SwarmState>>;
}

export function nodeSpecsFromAgents(
  agents: { role: string; run: (s: SwarmState, ctx: any) => Promise<Partial<SwarmState>> }[],
  ctx: unknown,
): LangGraphNodeSpec[] {
  return agents.map((a) => ({
    name: a.role,
    run: (state: SwarmState) => a.run(state, ctx),
  }));
}

/**
 * Build a LangGraph StateGraph if the package is installed. Throws a clear
 * error otherwise so consumers know exactly what to install.
 */
export async function buildLangGraph(): Promise<unknown> {
  let mod: any;
  try {
    mod = await import("@langchain/langgraph");
  } catch {
    throw new Error(
      "LangGraph adapter requires @langchain/langgraph. Install it with: npm i @langchain/langgraph",
    );
  }
  const { StateGraph, Annotation } = mod;

  const SwarmAnnotation = Annotation.Root({
    config: Annotation(),
    pages: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => [] }),
    apiEndpoints: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => [] }),
    tests: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => [] }),
    results: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => [] }),
    verdicts: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => [] }),
    bugs: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => [] }),
    coverageGaps: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => [] }),
    securityFindings: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => [] }),
    performanceFindings: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => [] }),
    log: Annotation({
      reducer: (a: unknown[], b: unknown[]) => [...(a ?? []), ...(b ?? [])],
      default: () => [],
    }),
    feedback: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => [] }),
    usage: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => ({ llmCalls: 0, tokens: 0 }) }),
    errors: Annotation({ reducer: (a: unknown[], b: unknown[]) => [...(a ?? []), ...(b ?? [])], default: () => [] }),
    phase: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => "init" }),
    runId: Annotation({ reducer: (_a: unknown, b: unknown) => b, default: () => "" }),
  });

  // The actual node wiring is left to the caller so they can inject their
  // own AgentContext (LLM provider, memory backend, budget).
  const graph = new StateGraph(SwarmAnnotation);
  return { graph, Annotation: SwarmAnnotation };
}