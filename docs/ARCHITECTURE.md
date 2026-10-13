# Architecture

QA-Swarm is a **state graph of specialised agents**. This document explains
the data model, the control flow, and the reasoning behind the key choices.

## The state object

Everything flows through a single typed object, `SwarmState`
(`packages/core/src/types.ts`). Each agent reads what it needs and returns a
`Partial<SwarmState>` patch. The orchestrator merges patches.

```ts
interface SwarmState {
  config: SwarmConfig;
  pages: DiscoveredPage[];        // explorer writes
  apiEndpoints: ApiEndpoint[];    // openapi loader writes
  tests: GeneratedTest[];         // generator writes
  results: TestResult[];          // executor writes
  verdicts: TriageVerdict[];      // triage writes
  bugs: BugReport[];              // triage + reporter write
  coverageGaps: CoverageGap[];    // reporter writes
  securityFindings: SecurityFinding[];
  performanceFindings: PerformanceFinding[];
  log: AgentLogEntry[];
  usage: { llmCalls: number; tokens: number };
  phase: SwarmPhase;
  runId: string;
}
```

### Merge semantics

Arrays **replace** by default. Agents that want to append spread the existing
value in explicitly (`[...state.tests, newTest]`). This is deliberate: it
makes append-vs-replace obvious at the call site instead of hiding it in a
framework reducer.

`log` is the one exception — it accumulates, because every agent wants to
add to it without clobbering.

## Control flow

```
init
  │  load OpenAPI spec if requested
  ▼
exploring        ExplorerAgent      → pages[]
  ▼
generating       TestGeneratorAgent → tests[]
  ▼
executing        ExecutorAgent      → results[]  (+ heals)
  ▼
triaging         TriageAgent        → verdicts[], bugs[]
  ▼
security         SecurityAgent      → securityFindings[]
  ▼
performance      PerformanceAgent   → performanceFindings[]
  ▼
reporting        ReporterAgent      → coverageGaps[], filed bugs
  ▼
done
```

The agent list is configurable (`config.agents`), so you can run just
`explorer` or skip security entirely.

## Why not just LangGraph?

LangGraph is excellent, but it is a dependency with its own release cadence.
The core graph here is ~120 lines of typed TypeScript with no runtime deps,
which means:

- It runs in any Node 20+ environment with zero setup.
- Offline demos and CI need no Python, no LangChain, no API keys.
- The semantics are visible and debuggable.

For teams that want LangGraph's tracing and Studio UI, `langgraph-adapter.ts`
exposes the same node shapes so the two orchestrators are interchangeable.

## Deterministic vs. LLM

This is the most important design axis. The rule:

> **If a check can be expressed as a fact, it must not be an LLM call.**

| Task | Mechanism | Why |
| --- | --- | --- |
| Security headers | Pure function | It's a header check, not an opinion |
| Performance budgets | Measured timings | Numbers must be measured |
| OpenAPI parsing | Parser | Schemas are structured data |
| Locator healing | Scoring function | Must be explainable + fast |
| Page classification | LLM + heuristic fallback | Genuinely fuzzy |
| Test authoring | LLM | Requires reasoning about intent |
| Failure triage | LLM + heuristic fallback | Requires judgement |
| Coverage gaps | LLM + set diff | Mix of both |

The payoff: low false-positive rate, and the system still works (degraded but
functional) with no LLM at all.

## Memory

Two backends behind one interface:

- **Embedded** (`EmbeddedVectorStore`) — brute-force cosine over an in-process
  array. Used for CI, tests, and offline demos.
- **Qdrant** — the production backend. Same interface, one config line.

Embeddings come from `HashEmbedder`, a deterministic bag-of-tokens hashing
embedder. It's not a neural embedding, and it doesn't need to be: for
deduplication and "have I seen this page" lookups, token overlap is enough,
and it has the enormous advantage of being free, offline, and stable.

Three memory kinds:

1. **Episodic** — pages/endpoints seen (`rememberPage`).
2. **Semantic** — tests that exist (`rememberTest`).
3. **Reinforcement** — feedback signals (`rememberFeedback`), which the
   generator reads via `feedbackBias()` to prioritise or deprioritise areas.

## Self-healing

When a locator fails, the executor re-snapshots the page and calls
`healLocator`, which scores every candidate element against the broken
selector's intent signals (tokens, role, structural type). A match above a
confidence floor is used for one retry.

Every heal produces a `HealRecord` with the strategy string, so the report
shows *why* a heal happened. Heals below the floor are reported as
alternatives rather than silently applied.

## Quarantine

`QuarantineManager` counts flakes per test. Past a threshold, the test is
quarantined: it still runs, but its failures don't block CI, and it appears
in the report with an expiry. Quarantines are snapshotted to
`quarantine.json` so they survive across runs.

## Budget guard

Every LLM call goes through `BudgetGuard`, which enforces `maxLlmCalls` and
`maxTokens`. When exhausted, agents stop calling the LLM and fall back to
heuristics. This makes cost predictable and prevents a runaway loop from
burning a budget overnight.