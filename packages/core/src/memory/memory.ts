import type {
  DiscoveredPage,
  FeedbackSignal,
  GeneratedTest,
  TriageVerdict,
  BugReport,
  SwarmConfig,
} from "../types.js";
import {
  HashEmbedder,
  createVectorStore,
  type MemoryDoc,
  type MemoryHit,
  type VectorStore,
} from "./store.js";

/**
 * Long-term swarm memory.
 *
 * Three things live here:
 *  1. Episodic memory of pages/endpoints seen (so exploration doesn't repeat).
 *  2. Semantic memory of tests that exist (so the generator doesn't duplicate).
 *  3. Reinforcement memory of human/CI feedback (so the swarm gets better).
 */
export class SwarmMemory {
  private embedder = new HashEmbedder();
  private store: VectorStore;

  constructor(private config: SwarmConfig) {
    this.store = createVectorStore(config);
  }

  get backend(): string {
    return this.store.kind;
  }

  async rememberPage(page: DiscoveredPage): Promise<void> {
    await this.upsert("page", page.id, pageSummary(page), {
      url: page.url,
      role: page.role,
      title: page.title,
    });
  }

  async rememberTest(test: GeneratedTest): Promise<void> {
    await this.upsert("test", test.id, testSummary(test), {
      kind: test.kind,
      origin: test.origin,
      priority: test.priority,
      fingerprint: test.fingerprint ?? "",
    });
  }

  async rememberVerdict(verdict: TriageVerdict): Promise<void> {
    await this.upsert("verdict", verdict.testId, verdictText(verdict), {
      classification: verdict.classification,
      confidence: verdict.confidence,
    });
  }

  async rememberBug(bug: BugReport): Promise<void> {
    await this.upsert("bug", bug.id, `${bug.title}\n${bug.summary}`, {
      severity: bug.severity,
      fingerprint: bug.fingerprint,
      target: bug.target,
    });
  }

  async rememberFeedback(signal: FeedbackSignal): Promise<void> {
    await this.upsert(
      "feedback",
      `${signal.target}:${signal.at}`,
      `${signal.note} (weight=${signal.weight})`,
      { target: signal.target, weight: signal.weight, at: signal.at },
    );
  }

  /** Has this page already been explored in a previous run? */
  async wasExplored(url: string): Promise<MemoryHit | undefined> {
    const hits = await this.search(`page ${url}`, 1, { url });
    return hits[0]?.score && hits[0].score > 0.6 ? hits[0] : undefined;
  }

  /** Find existing tests that likely cover the same intent. */
  async findSimilarTests(intent: string, limit = 5): Promise<MemoryHit[]> {
    return this.search(intent, limit);
  }

  /** Retrieve feedback relevant to a test/area and fold into a bias score. */
  async feedbackBias(target: string): Promise<number> {
    const hits = await this.search(target, 10, undefined);
    let bias = 0;
    for (const h of hits) {
      if (typeof h.metadata.weight === "number" && h.score > 0.5) {
        bias += (h.metadata.weight as number) * h.score;
      }
    }
    return clamp(bias / 5, -1, 1);
  }

  async stats(): Promise<Record<string, number>> {
    const all = await this.store.count();
    return { total: all };
  }

  async reset(): Promise<void> {
    await this.store.clear();
  }

  // --- internals ---------------------------------------------------------

  private async upsert(
    kind: string,
    id: string,
    text: string,
    metadata: Record<string, unknown>,
  ): Promise<void> {
    const doc: MemoryDoc = {
      id: `${kind}:${id}`,
      text,
      vector: this.embedder.embed(text),
      metadata: { kind, ...metadata },
    };
    await this.store.upsert([doc]);
  }

  private async search(
    text: string,
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<MemoryHit[]> {
    return this.store.search(this.embedder.embed(text), limit, filter);
  }
}

function pageSummary(p: DiscoveredPage): string {
  return [
    `page ${p.url}`,
    `title ${p.title}`,
    `role ${p.role}`,
    `elements ${p.elements.map((e) => e.name).join(", ")}`,
  ].join("\n");
}

function testSummary(t: GeneratedTest): string {
  return `${t.title}\n${t.intent}\n${t.steps.map((s) => s.action).join(" ")}`;
}

function verdictText(v: TriageVerdict): string {
  return `${v.classification} ${v.rootCause} ${v.recommendation}`;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}