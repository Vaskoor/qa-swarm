import type { Agent, AgentContext } from "./base.js";
import { askJson } from "./base.js";
import type { SecurityFinding, SwarmState } from "../types.js";
import { HttpApiTool } from "../tools/api.js";
import { SECURITY_SYSTEM, securityPrompt } from "../llm/prompts.js";

/**
 * Security agent.
 *
 * Runs a *deterministic* header/CORS/secrets audit first (these are facts,
 * not opinions), then asks the LLM to reason about the response body for
 * anything the heuristics can't classify. Deterministic checks always win,
 * which keeps the false-positive rate low.
 */
export class SecurityAgent implements Agent {
  readonly role = "security" as const;

  async run(state: SwarmState, ctx: AgentContext): Promise<Partial<SwarmState>> {
    const findings: SecurityFinding[] = [...state.securityFindings];
    const api = new HttpApiTool();
    const targets = [
      state.config.baseUrl ?? state.config.target,
      ...state.pages.slice(0, 5).map((p) => p.url),
      ...state.apiEndpoints.slice(0, 5).map((e) => `${state.config.baseUrl ?? ""}${e.path}`),
    ].filter((t) => /^https?:\/\//.test(t));

    const seen = new Set<string>();
    for (const url of targets) {
      if (seen.has(url)) continue;
      seen.add(url);
      try {
        const res = await api.request("GET", url);
        // Deterministic header checks.
        findings.push(...checkHeaders(url, res.headers));

        // LLM pass for body-level issues (only when budget allows).
        if (!ctx.budget.exhausted) {
          const raw = await askJson<Partial<SecurityFinding>[]>(
            ctx,
            this.role,
            [
              { role: "system", content: SECURITY_SYSTEM },
              {
                role: "user",
                content: securityPrompt({
                  url,
                  headers: res.headers,
                  bodySnippet: String(res.bodyText ?? ""),
                }),
              },
            ],
            [],
            1024,
          );
          for (const f of raw) {
            if (!f.title) continue;
            findings.push({
              id: `SEC-${hash(url + f.title).slice(0, 8)}`,
              title: f.title,
              category: f.category ?? "other",
              severity: f.severity ?? "minor",
              url,
              evidence: f.evidence ?? "reported by LLM analysis",
              remediation: f.remediation ?? "review and remediate",
              cwe: f.cwe,
            });
          }
        }
      } catch (err) {
        ctx.log(this.role, `security probe failed for ${url}: ${(err as Error).message}`, "warn");
      }
    }

    ctx.log(this.role, `found ${findings.length} security finding(s)`);
    return { securityFindings: findings, phase: "performance" };
  }
}

const RECOMMENDED_HEADERS: { name: string; severity: SecurityFinding["severity"]; cwe: string }[] = [
  { name: "content-security-policy", severity: "major", cwe: "CWE-1021" },
  { name: "x-content-type-options", severity: "minor", cwe: "CWE-693" },
  { name: "x-frame-options", severity: "major", cwe: "CWE-1021" },
  { name: "strict-transport-security", severity: "major", cwe: "CWE-319" },
  { name: "referrer-policy", severity: "minor", cwe: "CWE-200" },
];

export function checkHeaders(
  url: string,
  headers: Record<string, string>,
): SecurityFinding[] {
  const out: SecurityFinding[] = [];
  const lower = Object.fromEntries(
    Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]),
  );

  for (const rec of RECOMMENDED_HEADERS) {
    if (!lower[rec.name]) {
      out.push({
        id: `SEC-${hash(url + rec.name).slice(0, 8)}`,
        title: `Missing security header: ${rec.name}`,
        category: "headers",
        severity: rec.severity,
        url,
        evidence: `Response did not include the ${rec.name} header.`,
        remediation: `Add the ${rec.name} header to server responses.`,
        cwe: rec.cwe,
      });
    }
  }

  const acao = lower["access-control-allow-origin"];
  if (acao === "*") {
    out.push({
      id: `SEC-${hash(url + "cors").slice(0, 8)}`,
      title: "Permissive CORS: Access-Control-Allow-Origin is *",
      category: "cors",
      severity: "major",
      url,
      evidence: `Access-Control-Allow-Origin: *`,
      remediation:
        "Restrict allowed origins to a trusted allow-list; never use * with credentials.",
      cwe: "CWE-942",
    });
  }

  const server = lower["server"];
  if (server && /\d/.test(server)) {
    out.push({
      id: `SEC-${hash(url + "server").slice(0, 8)}`,
      title: "Server version disclosed in headers",
      category: "secrets",
      severity: "minor",
      url,
      evidence: `Server: ${server}`,
      remediation: "Suppress or genericise the Server header to avoid version fingerprinting.",
      cwe: "CWE-200",
    });
  }

  return out;
}

function hash(s: string): string {
  // tiny non-crypto hash for stable ids
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return Math.abs(h).toString(16);
}