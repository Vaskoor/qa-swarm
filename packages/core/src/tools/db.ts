/**
 * DB tool — read-only access for verifying application state after UI/API
 * actions. Deliberately SELECT-only: QA agents should never mutate prod.
 *
 * When no DATABASE_URL is configured the tool reports itself unavailable and
 * agents skip DB assertions rather than fail.
 */
export interface QueryResult {
  rows: Record<string, unknown>[];
  rowCount: number;
  durationMs: number;
}

export interface DbTool {
  readonly available: boolean;
  query(sql: string, params?: unknown[]): Promise<QueryResult>;
  close(): Promise<void>;
}

export class PostgresDbTool implements DbTool {
  private pool: unknown;
  readonly available: boolean;

  constructor(private connectionString?: string) {
    this.available = Boolean(connectionString);
  }

  private async getPool(): Promise<{
    query: (sql: string, params?: unknown[]) => Promise<{
      rows: Record<string, unknown>[];
      rowCount: number | null;
    }>;
    end: () => Promise<void>;
  }> {
    if (this.pool) return this.pool as never;
    if (!this.connectionString) throw new Error("DATABASE_URL not configured");
    const pg = await import("pg");
    const Pool = (pg.default ?? pg).Pool;
    this.pool = new Pool({ connectionString: this.connectionString, max: 4 });
    return this.pool as never;
  }

  async query(sql: string, params: unknown[] = []): Promise<QueryResult> {
    if (!this.available) throw new Error("DB tool unavailable");
    if (!/^\s*(select|with)\b/i.test(sql)) {
      throw new Error("DB tool is read-only: only SELECT/WITH allowed");
    }
    const started = Date.now();
    const pool = await this.getPool();
    const res = await pool.query(sql, params);
    return {
      rows: res.rows,
      rowCount: res.rowCount ?? 0,
      durationMs: Date.now() - started,
    };
  }

  async close(): Promise<void> {
    const pool = this.pool as { end?: () => Promise<void> } | undefined;
    await pool?.end?.().catch(() => {});
  }
}

export class NoopDbTool implements DbTool {
  readonly available = false;
  async query(): Promise<QueryResult> {
    throw new Error("DB tool unavailable — set DATABASE_URL to enable");
  }
  async close(): Promise<void> {}
}

export function createDbTool(): DbTool {
  const url = process.env.DATABASE_URL;
  return url ? new PostgresDbTool(url) : new NoopDbTool();
}