import type { ApiEndpoint } from "../types.js";

export interface ApiResponse {
  status: number;
  headers: Record<string, string>;
  body: unknown;
  bodyText: string;
  durationMs: number;
}

export interface ApiTool {
  request(
    method: string,
    url: string,
    opts?: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<ApiResponse>;
  validateSchema(endpoint: ApiEndpoint, response: unknown): { valid: boolean; errors: string[] };
}

export class HttpApiTool implements ApiTool {
  constructor(private defaultHeaders: Record<string, string> = {}) {}

  async request(
    method: string,
    url: string,
    opts?: { body?: unknown; headers?: Record<string, string>; timeoutMs?: number },
  ): Promise<ApiResponse> {
    const started = Date.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), opts?.timeoutMs ?? 15_000);
    try {
      const res = await fetch(url, {
        method,
        headers: {
          "content-type": "application/json",
          accept: "application/json, text/plain, */*",
          ...this.defaultHeaders,
          ...opts?.headers,
        },
        body: opts?.body !== undefined ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal,
      });
      const bodyText = await res.text();
      let body: unknown = bodyText;
      const ct = res.headers.get("content-type") ?? "";
      if (ct.includes("json")) {
        try {
          body = JSON.parse(bodyText);
        } catch {
          /* keep as text */
        }
      }
      return {
        status: res.status,
        headers: headersToObject(res.headers),
        body,
        bodyText,
        durationMs: Date.now() - started,
      };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Very small structural validator. This is intentionally not full JSON
   * Schema — it checks types on the top-level properties declared in the
   * OpenAPI response schema, which catches the most common contract drift.
   */
  validateSchema(
    endpoint: ApiEndpoint,
    response: unknown,
  ): { valid: boolean; errors: string[] } {
    const errors: string[] = [];
    const ok =
      typeof response === "object" &&
      response !== null &&
      !Array.isArray(response);
    if (!ok) {
      return { valid: false, errors: [`expected object, got ${typeof response}`] };
    }
    for (const [code, spec] of Object.entries(endpoint.responses)) {
      if (code !== "200" && code !== "201") continue;
      const schema = spec.schema as { properties?: Record<string, { type?: string }> } | undefined;
      if (!schema?.properties) continue;
      for (const [prop, def] of Object.entries(schema.properties)) {
        const val = (response as Record<string, unknown>)[prop];
        if (val === undefined) continue; // optional fields tolerated
        const expected = def.type;
        if (expected && !typeMatches(val, expected)) {
          errors.push(`property "${prop}" expected ${expected}, got ${typeof val}`);
        }
      }
    }
    return { valid: errors.length === 0, errors };
  }
}

function typeMatches(val: unknown, expected: string): boolean {
  switch (expected) {
    case "string":
      return typeof val === "string";
    case "number":
    case "integer":
      return typeof val === "number";
    case "boolean":
      return typeof val === "boolean";
    case "array":
      return Array.isArray(val);
    case "object":
      return typeof val === "object" && val !== null && !Array.isArray(val);
    default:
      return true;
  }
}
/** Convert a fetch Headers object to a plain record without relying on .entries(). */
function headersToObject(headers: Headers): Record<string, string> {
  const out: Record<string, string> = {};
  headers.forEach((value, key) => {
    out[key] = value;
  });
  return out;
}
