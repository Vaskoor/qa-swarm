# Agents

Each agent implements the `Agent` interface:

```ts
interface Agent {
  readonly role: AgentRole;
  run(state: SwarmState, ctx: AgentContext): Promise<Partial<SwarmState>>;
}
```

`AgentContext` gives every agent the LLM provider, vector memory, a scoped
logger, and the budget guard.

---

## Explorer

`packages/core/src/agents/explorer.ts`

Breadth-first crawl from the target URL, staying on-origin, up to
`maxPages`. For each page it:

1. Navigates with Playwright and records status.
2. Extracts interactive elements with best-first selector candidates.
3. Records network traffic (XHR/fetch/document).
4. Asks the LLM to classify the page role and rank elements.
5. Writes the page to vector memory.

Pages already in memory can be skipped on subsequent runs.

## Test Generator

`packages/core/src/agents/test-generator.ts`

Two paths:

- **UI tests** — derives intents per page (smoke, form submit,
  form-validation, auth-reject, navigation), asks the LLM to expand each into
  concrete steps, deduplicates against memory, and renders Playwright source.
- **API tests** — pure logic. Each OpenAPI endpoint becomes a contract test
  with a sample request and a status assertion. No LLM.

Every test gets a `fingerprint` (SHA-1 of kind+origin+intent+step-actions)
used for cross-run deduplication.

## Executor

`packages/core/src/agents/executor.ts`

Runs tests for real:

- UI tests drive a shared headless browser, executing each step. On selector
  failure it re-snapshots, calls the healer, and retries once.
- API tests hit the endpoint and assert status < 400.
- Flaky tests (passed only on retry) are fed to the quarantine manager.
- Screenshots are captured as evidence on both success and failure.

## Triage

`packages/core/src/agents/triage.ts`

For each failure, asks the LLM (with a heuristic fallback) to classify:

- `product-bug` — the app is wrong
- `test-bug` — the test is wrong
- `flaky` — non-deterministic
- `environment` — infra failure
- `unknown` — not enough evidence

Product bugs become `BugReport`s with steps-to-reproduce derived from the
test, evidence artifacts, and a stable fingerprint for deduplication.

## Security

`packages/core/src/agents/security.ts`

Deterministic first:

- Missing security headers (CSP, HSTS, X-Frame-Options, etc.)
- Wildcard CORS (`Access-Control-Allow-Origin: *`)
- Server version disclosure

Then an LLM pass over response bodies for anything the heuristics miss. The
deterministic findings always win, which keeps false positives near zero.

## Performance

`packages/core/src/agents/performance.ts`

Pure measurement — no LLM:

- TTFB (median of 3 samples) against `QA_TTFB_BUDGET_MS`
- Payload size against `QA_PAYLOAD_BUDGET_KB`
- Request count per page against `QA_REQUEST_BUDGET`

## Reporter

`packages/core/src/agents/reporter.ts`

- Detects coverage gaps (pages explored but not tested) — set diff + LLM.
- Files bugs to Jira → GitHub → local markdown, in priority order.
- Produces the run manifest consumed by the reporter/markdown renderer.