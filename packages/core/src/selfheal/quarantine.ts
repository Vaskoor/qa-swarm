import type { QuarantineRecord, TestResult } from "../types.js";

/**
 * Flaky-test quarantine.
 *
 * Tests that fail non-deterministically poison CI trust. Rather than deleting
 * them (losing coverage) or ignoring them (losing signal), we quarantine:
 * the test keeps running, but its failures no longer block, and it is
 * surfaced in the report with an expiry so it gets fixed or removed.
 */
export class QuarantineManager {
  private records = new Map<string, QuarantineRecord>();
  private flakeCounts = new Map<string, number>();

  constructor(
    private threshold: number,
    private ttlDays = 14,
  ) {}

  /** Record an attempt outcome; returns true if the test should be quarantined. */
  observe(result: TestResult): boolean {
    if (result.status === "flaky") {
      const n = (this.flakeCounts.get(result.testId) ?? 0) + 1;
      this.flakeCounts.set(result.testId, n);
      if (n >= this.threshold && !this.records.has(result.testId)) {
        this.quarantine(result.testId, result.title, `flaked ${n}x`);
        return true;
      }
    }
    return false;
  }

  quarantine(testId: string, title: string, reason: string): QuarantineRecord {
    const rec: QuarantineRecord = {
      testId,
      title,
      reason,
      flakeCount: this.flakeCounts.get(testId) ?? 0,
      quarantinedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + this.ttlDays * 86_400_000).toISOString(),
    };
    this.records.set(testId, rec);
    return rec;
  }

  isQuarantined(testId: string): boolean {
    const rec = this.records.get(testId);
    if (!rec) return false;
    if (rec.expiresAt && new Date(rec.expiresAt) < new Date()) {
      this.records.delete(testId);
      return false;
    }
    return true;
  }

  /** Mark a test as promoted back to blocking (it passed reliably). */
  release(testId: string): void {
    this.records.delete(testId);
    this.flakeCounts.delete(testId);
  }

  list(): QuarantineRecord[] {
    // Purge expired on read.
    for (const [id, rec] of this.records) {
      if (rec.expiresAt && new Date(rec.expiresAt) < new Date()) {
        this.records.delete(id);
      }
    }
    return [...this.records.values()];
  }

  snapshot(): { records: QuarantineRecord[]; flakeCounts: Record<string, number> } {
    return {
      records: this.list(),
      flakeCounts: Object.fromEntries(this.flakeCounts),
    };
  }

  restore(data: { records: QuarantineRecord[]; flakeCounts: Record<string, number> }): void {
    for (const r of data.records) this.records.set(r.testId, r);
    for (const [k, v] of Object.entries(data.flakeCounts)) this.flakeCounts.set(k, v);
  }
}