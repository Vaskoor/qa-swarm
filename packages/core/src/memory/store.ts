import { createHash } from "node:crypto";
import type { SwarmConfig } from "../types.js";

export interface MemoryDoc {
  id: string;
  text: string;
  vector: number[];
  metadata: Record<string, unknown>;
}

export interface MemoryHit {
  id: string;
  text: string;
  score: number;
  metadata: Record<string, unknown>;
}

export interface VectorStore {
  readonly kind: string;
  upsert(docs: MemoryDoc[]): Promise<void>;
  search(
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<MemoryHit[]>;
  count(): Promise<number>;
  clear(): Promise<void>;
}

/** Deterministic hashing embedder — no network, stable across runs. */
export class HashEmbedder {
  constructor(private dims = 256) {}

  embed(text: string): number[] {
    const vec = new Array<number>(this.dims).fill(0);
    const tokens = text.toLowerCase().match(/[a-z0-9_]+/g) ?? [];
    for (const tok of tokens) {
      const h = createHash("sha1").update(tok).digest();
      const idx = h.readUInt32BE(0) % this.dims;
      const sign = h[4]! % 2 === 0 ? 1 : -1;
      vec[idx] = (vec[idx] ?? 0) + sign;
    }
    return normalize(vec);
  }
}

function normalize(v: number[]): number[] {
  const mag = Math.sqrt(v.reduce((a, b) => a + b * b, 0)) || 1;
  return v.map((x) => x / mag);
}

export function cosine(a: number[], b: number[]): number {
  let dot = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) dot += a[i]! * b[i]!;
  return dot;
}

export function stableUuid(input: string): string {
  const h = createHash("sha1").update(input).digest("hex");
  // Format as a UUIDv5-ish string; Qdrant accepts string ids but UUIDs are
  // friendlier to dashboards.
  return [
    h.slice(0, 8),
    h.slice(8, 12),
    `5${h.slice(13, 16)}`,
    ((parseInt(h[16]!, 16) & 0x3) | 0x8).toString(16) + h.slice(17, 20),
    h.slice(20, 32),
  ].join("-");
}

/**
 * In-process brute-force vector store. Used for tests, CI, and demos where
 * standing up Qdrant is overkill. The interface is identical to the Qdrant
 * adapter so swapping is a one-line config change.
 */
export class EmbeddedVectorStore implements VectorStore {
  readonly kind = "embedded";
  private docs: MemoryDoc[] = [];

  async upsert(docs: MemoryDoc[]): Promise<void> {
    const byId = new Map(this.docs.map((d) => [d.id, d]));
    for (const d of docs) byId.set(d.id, d);
    this.docs = [...byId.values()];
  }

  async search(
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<MemoryHit[]> {
    let pool = this.docs;
    if (filter) {
      pool = pool.filter((d) =>
        Object.entries(filter).every(([k, v]) => d.metadata[k] === v),
      );
    }
    return pool
      .map((d) => ({
        id: d.id,
        text: d.text,
        score: cosine(vector, d.vector),
        metadata: d.metadata,
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  async count(): Promise<number> {
    return this.docs.length;
  }

  async clear(): Promise<void> {
    this.docs = [];
  }
}

/**
 * Qdrant adapter. Qdrant is the "real" backend; it is optional at runtime so
 * that `offline: true` demos work with zero infrastructure.
 */
export class QdrantVectorStore implements VectorStore {
  readonly kind = "qdrant";
  private client: unknown;

  constructor(
    private url: string,
    private collection: string,
    private dims = 256,
  ) {}

  private async getClient(): Promise<Record<string, CallableFunction>> {
    if (this.client) return this.client as Record<string, CallableFunction>;
    const { QdrantClient } = await import("@qdrant/js-client-rest");
    const c = new QdrantClient({ url: this.url });
    try {
      await c.getCollection(this.collection);
    } catch {
      await c.createCollection(this.collection, {
        vectors: { size: this.dims, distance: "Cosine" },
      });
    }
    this.client = c;
    return c as unknown as Record<string, CallableFunction>;
  }

  async upsert(docs: MemoryDoc[]): Promise<void> {
    const c = await this.getClient();
    await c.upsert!(this.collection, {
      wait: true,
      points: docs.map((d) => ({
        id: stableUuid(d.id),
        vector: d.vector,
        payload: { text: d.text, ...d.metadata },
      })),
    });
  }

  async search(
    vector: number[],
    limit: number,
    filter?: Record<string, unknown>,
  ): Promise<MemoryHit[]> {
    const c = await this.getClient();
    const must = filter
      ? Object.entries(filter).map(([k, v]) => ({ key: k, match: { value: v } }))
      : undefined;
    const res = (await c.search!(this.collection, {
      vector,
      limit,
      filter: must ? { must } : undefined,
      with_payload: true,
    })) as { id: string | number; score: number; payload?: Record<string, unknown> }[];
    return res.map((r) => ({
      id: String(r.id),
      text: String(r.payload?.text ?? ""),
      score: r.score,
      metadata: r.payload ?? {},
    }));
  }

  async count(): Promise<number> {
    const c = await this.getClient();
    const res = (await c.count!(this.collection)) as { count: number };
    return res.count;
  }

  async clear(): Promise<void> {
    const c = await this.getClient();
    await c.deleteCollection!(this.collection);
    await c.createCollection!(this.collection, {
      vectors: { size: this.dims, distance: "Cosine" },
    });
  }
}

export function createVectorStore(config: SwarmConfig): VectorStore {
  if (!config.memory.embedded && config.memory.qdrantUrl) {
    return new QdrantVectorStore(config.memory.qdrantUrl, config.memory.collection);
  }
  return new EmbeddedVectorStore();
}