import { describe, expect, it } from "vitest";
import { EmbeddedVectorStore, HashEmbedder, cosine } from "@qa-swarm/core";

describe("hash embedder", () => {
  it("is deterministic", () => {
    const e = new HashEmbedder(128);
    expect(e.embed("login form submit")).toEqual(e.embed("login form submit"));
  });

  it("gives higher similarity to related text", () => {
    const e = new HashEmbedder(256);
    const a = e.embed("login form submit button");
    const b = e.embed("login form password field");
    const c = e.embed("shopping cart checkout payment");
    expect(cosine(a, b)).toBeGreaterThan(cosine(a, c));
  });
});

describe("embedded vector store", () => {
  it("upserts and searches", async () => {
    const store = new EmbeddedVectorStore();
    const e = new HashEmbedder(64);
    await store.upsert([
      { id: "1", text: "login page", vector: e.embed("login page"), metadata: { kind: "page" } },
      { id: "2", text: "cart page", vector: e.embed("cart page"), metadata: { kind: "page" } },
    ]);
    expect(await store.count()).toBe(2);
    const hits = await store.search(e.embed("login"), 1);
    expect(hits[0]?.id).toBe("1");
  });

  it("filters by metadata", async () => {
    const store = new EmbeddedVectorStore();
    const e = new HashEmbedder(64);
    await store.upsert([
      { id: "1", text: "x", vector: e.embed("x"), metadata: { kind: "test" } },
      { id: "2", text: "x", vector: e.embed("x"), metadata: { kind: "page" } },
    ]);
    const hits = await store.search(e.embed("x"), 10, { kind: "test" });
    expect(hits).toHaveLength(1);
    expect(hits[0]?.id).toBe("1");
  });

  it("replaces on upsert with the same id", async () => {
    const store = new EmbeddedVectorStore();
    const e = new HashEmbedder(32);
    await store.upsert([{ id: "1", text: "a", vector: e.embed("a"), metadata: {} }]);
    await store.upsert([{ id: "1", text: "b", vector: e.embed("b"), metadata: {} }]);
    expect(await store.count()).toBe(1);
  });
});