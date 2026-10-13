import { describe, expect, it } from "vitest";
import { QuarantineManager } from "@qa-swarm/core";
import type { TestResult } from "@qa-swarm/core";

const flaky = (id: string): TestResult => ({
  testId: id,
  title: id,
  status: "flaky",
  durationMs: 10,
  artifacts: [],
  attempts: 2,
});

describe("quarantine manager", () => {
  it("quarantines after the threshold", () => {
    const q = new QuarantineManager(2);
    expect(q.observe(flaky("t1"))).toBe(false);
    expect(q.observe(flaky("t1"))).toBe(true);
    expect(q.isQuarantined("t1")).toBe(true);
    expect(q.list()).toHaveLength(1);
  });

  it("does not quarantine below threshold", () => {
    const q = new QuarantineManager(3);
    q.observe(flaky("t2"));
    expect(q.isQuarantined("t2")).toBe(false);
  });

  it("releases on demand", () => {
    const q = new QuarantineManager(1);
    q.observe(flaky("t3"));
    expect(q.isQuarantined("t3")).toBe(true);
    q.release("t3");
    expect(q.isQuarantined("t3")).toBe(false);
  });

  it("snapshots and restores", () => {
    const q = new QuarantineManager(1);
    q.observe(flaky("t4"));
    const snap = q.snapshot();
    const q2 = new QuarantineManager(1);
    q2.restore(snap);
    expect(q2.isQuarantined("t4")).toBe(true);
  });
});