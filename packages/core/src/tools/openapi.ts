import type { ApiEndpoint } from "../types.js";

/**
 * Minimal OpenAPI 3.x / Swagger 2.x parser.
 *
 * We avoid a heavyweight dependency (and its transitive type issues) by
 * walking the spec ourselves. Both JSON and YAML specs are supported; YAML
 * is parsed with `js-yaml`.
 */
export async function loadOpenApi(source: string): Promise<ApiEndpoint[]> {
  const raw = await readSource(source);
  const spec = parseSpec(raw);
  return extractEndpoints(spec);
}

async function readSource(source: string): Promise<string> {
  if (/^https?:\/\//i.test(source)) {
    const res = await fetch(source);
    if (!res.ok) throw new Error(`failed to fetch OpenAPI: ${res.status}`);
    return res.text();
  }
  const fs = await import("node:fs/promises");
  return fs.readFile(source, "utf8");
}

function parseSpec(raw: string): unknown {
  const trimmed = raw.trim();
  if (trimmed.startsWith("{")) return JSON.parse(trimmed);
  const yaml = require("js-yaml");
  return yaml.load(trimmed);
}

const HTTP_METHODS = ["get", "post", "put", "patch", "delete", "head", "options"];

export function extractEndpoints(spec: unknown): ApiEndpoint[] {
  const endpoints: ApiEndpoint[] = [];
  const s = spec as {
    paths?: Record<string, Record<string, unknown>>;
  };
  const paths = s?.paths ?? {};

  for (const [path, item] of Object.entries(paths)) {
    for (const method of HTTP_METHODS) {
      const op = item[method] as Record<string, unknown> | undefined;
      if (!op) continue;
      const parameters = ((op.parameters ?? []) as any[]).map((p) => ({
        name: String(p.name ?? ""),
        in: String(p.in ?? "query"),
        required: Boolean(p.required),
        schema: p.schema,
      }));
      endpoints.push({
        method: method.toUpperCase(),
        path,
        summary: op.summary as string | undefined,
        operationId: op.operationId as string | undefined,
        parameters,
        requestBodySchema: (op.requestBody as any)?.content?.["application/json"]?.schema,
        responses: (op.responses ?? {}) as Record<
          string,
          { description?: string; schema?: unknown }
        >,
        tags: (op.tags as string[]) ?? [],
      });
    }
  }
  return endpoints;
}

/** Build a concrete request URL for an endpoint, filling path params. */
export function buildRequest(
  baseUrl: string,
  endpoint: ApiEndpoint,
  sampleValues: Record<string, string> = {},
): { url: string; query: Record<string, string> } {
  let url = endpoint.path;
  const query: Record<string, string> = {};
  for (const p of endpoint.parameters) {
    const value = sampleValues[p.name] ?? sampleFor(p.name, p.schema);
    if (p.in === "path") {
      url = url.replace(`{${p.name}}`, encodeURIComponent(value));
    } else if (p.in === "query") {
      query[p.name] = value;
    }
  }
  const qs = new URLSearchParams(query).toString();
  const full = `${baseUrl.replace(/\/$/, "")}${url}${qs ? `?${qs}` : ""}`;
  return { url: full, query };
}

/** Generate a plausible sample value for a parameter. */
export function sampleFor(name: string, schema?: unknown): string {
  const type = (schema as { type?: string } | undefined)?.type ?? "string";
  const n = name.toLowerCase();
  if (n.includes("id")) return "1";
  if (n.includes("page")) return "1";
  if (n.includes("limit") || n.includes("size")) return "10";
  if (n.includes("email")) return "qa-swarm@example.com";
  if (n.includes("slug") || n.includes("name")) return "example";
  if (type === "integer" || type === "number") return "1";
  if (type === "boolean") return "true";
  return "test";
}