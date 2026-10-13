import type { DiscoveredPage, GeneratedTest, TestResult } from "../types.js";

export const PLANNER_SYSTEM = `You are the Explorer agent inside QA-Swarm.
You are given the DOM summary of a web page. Decide which interactive elements
are worth exercising to uncover bugs, and give each element a short, stable name.

Rules:
- Prefer elements that mutate state: forms, submit buttons, filters, nav.
- Ignore purely decorative links and cookie banners unless they block flow.
- If the page looks like a login, say so and list credential fields first.
- Return STRICT JSON. No prose, no markdown fences.`;

export function explorerPrompt(page: DiscoveredPage): string {
  const els = page.elements
    .slice(0, 40)
    .map(
      (e) =>
        `- ${e.tag}${e.role ? `[role=${e.role}]` : ""} name="${e.name}" label="${e.label ?? ""}" placeholder="${e.placeholder ?? ""}" fillable=${e.fillable} clickable=${e.clickable}`,
    )
    .join("\n");
  return `URL: ${page.url}
Title: ${page.title}
Guessed role: ${page.role}

Elements:
${els || "(none)"}

Return JSON: { "role": string, "priorityElements": string[], "notes": string }`;
}

export const GENERATOR_SYSTEM = `You are the Test Generator agent inside QA-Swarm.
You write Playwright tests in TypeScript that are:
- Deterministic and independent (no shared state between tests).
- Assertion-rich but not brittle (prefer role/text locators over CSS).
- Small: one behaviour per test.

Return STRICT JSON only.`;

export function generatorPrompt(input: {
  page: DiscoveredPage;
  intent: string;
  count: number;
}): string {
  return `Page: ${input.page.url} (${input.page.title})
Intent to cover: ${input.intent}
Produce ${input.count} test case(s).

Return JSON array where each item is:
{
  "title": string,
  "kind": "ui",
  "intent": string,
  "steps": [
    { "action": "goto", "url": string },
    { "action": "click", "selector": string },
    { "action": "fill", "selector": string, "value": string },
    { "action": "expect", "assertion": string }
  ],
  "expected": string,
  "tags": string[],
  "priority": "P0" | "P1" | "P2"
}`;
}

export const TRIAGE_SYSTEM = `You are the Triage agent inside QA-Swarm.
You receive a failed test plus its captured signals (console, network, stack).
Classify the failure and justify it with concrete evidence.

Classifications:
- product-bug: the application is wrong.
- test-bug: the test is wrong / asserted the wrong thing.
- flaky: non-deterministic, timing or ordering dependent.
- environment: infra, DNS, missing service, auth expiry.
- unknown: not enough evidence.

Return STRICT JSON only.`;

export function triagePrompt(result: TestResult, test?: GeneratedTest): string {
  const signals = (result.signals ?? [])
    .map((s) => `  [${s.kind}/${s.level ?? "-"}] ${s.message}`)
    .join("\n");
  return `Test: ${result.title}
Status: ${result.status} (attempts=${result.attempts}, ${result.durationMs}ms)
Error: ${result.error ?? "(none)"}
Stack:
${(result.stack ?? "").split("\n").slice(0, 12).join("\n")}
Failed selector: ${result.failedSelector ?? "(none)"}
Signals:
${signals || "(none)"}
Original intent: ${test?.intent ?? "(unknown)"}

Return JSON: {
  "classification": "...",
  "confidence": 0..1,
  "rootCause": string,
  "evidence": string[],
  "reproducible": boolean,
  "recommendation": string
}`;
}

export const SECURITY_SYSTEM = `You are the Security agent inside QA-Swarm.
Reason about HTTP responses and DOM for common web weaknesses.
Only report findings you can back with the evidence provided. Never invent
vulnerabilities. Return STRICT JSON only.`;

export function securityPrompt(input: {
  url: string;
  headers: Record<string, string>;
  bodySnippet: string;
}): string {
  return `URL: ${input.url}
Response headers:
${JSON.stringify(input.headers, null, 2)}
Body snippet:
${input.bodySnippet.slice(0, 2000)}

Return JSON array of {
  "title": string,
  "category": "xss"|"sqli"|"csrf"|"authz"|"secrets"|"headers"|"cors"|"other",
  "severity": "blocker"|"critical"|"major"|"minor"|"trivial",
  "evidence": string,
  "remediation": string,
  "cwe": string
}`;
}

export const COVERAGE_SYSTEM = `You are the Reporter agent inside QA-Swarm.
Given the list of pages explored and tests generated, identify coverage gaps —
user journeys or pages that were discovered but not exercised.
Return STRICT JSON only.`;

export function coveragePrompt(input: {
  pages: DiscoveredPage[];
  tests: GeneratedTest[];
}): string {
  const tested = new Set(input.tests.map((t) => t.origin));
  const untested = input.pages.filter((p) => !tested.has(p.url));
  return `Explored pages (${input.pages.length}), tested origins (${tested.size}).
Untested pages:
${untested.map((p) => `- ${p.url} (${p.role})`).join("\n") || "(none)"}

Return JSON array of {
  "area": string,
  "description": string,
  "confidence": 0..1,
  "suggestion": string
}`;
}