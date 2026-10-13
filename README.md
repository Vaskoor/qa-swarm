<div align="center">

# 🐝 QA-Swarm

**An open-source "Devin for QA" — a swarm of AI agents that explore your app, write tests, run them, triage failures, file bugs, and build regression suites with minimal human input.**

Give it a URL or an OpenAPI spec. It comes back with tests, bugs, and evidence.

[![license](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)
[![node](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![typescript](https://img.shields.io/badge/TypeScript-5.7-3178c6.svg)](https://www.typescriptlang.org/)
[![playwright](https://img.shields.io/badge/Playwright-1.49-2EAD33.svg)](https://playwright.dev)
[![langgraph](https://img.shields.io/badge/LangGraph-0.2-1C3C3C.svg)](https://github.com/langchain-ai/langgraph)

</div>

---

## 📋 Table of Contents

- [What it does](#-what-it-does)
- [Why QA-Swarm](#-why-qa-swarm)
- [Architecture](#-architecture)
- [Quick start](#-quick-start)
- [The agents](#-the-agents)
- [The dashboard](#-the-dashboard)
- [CLI reference](#-cli-reference)
- [HTTP API](#-http-api)
- [Configuration](#-configuration)
- [Docker (Qdrant + Postgres)](#-docker-qdrant--postgres)
- [Self-healing & quarantine](#-self-healing--quarantine)
- [Testing the platform itself](#-testing-the-platform-itself)
- [Project structure](#-project-structure)
- [Roadmap](#-roadmap)
- [Contributing](#-contributing)
- [License](#-license)

---

## 🎯 What it does

```
$ qa-swarm run https://staging.example.com --both

  ┌─────────────────────────────────────────────────────┐
  │  QA-SWARM  ·  Devin for QA                          │
  └─────────────────────────────────────────────────────┘
  • [explorer]       visited 7 page(s), 12 endpoint(s)
  • [test-generator] generated 41 test(s) from the exploration map
  • [executor]       executed 41 test(s): 36 passed, 5 failed, 2 healed
  • [triage]         ui_login_…: product-bug (0.82 confidence)
  • [triage]         triaged 5 failure(s), 3 bug(s) filed
  • [security]       found 6 security finding(s) (2 high)
  • [performance]    9 metric(s), 2 over budget (p95 > 800ms)
  • [reporter]       report ready → ./qa-swarm-out/report.md
                    + regression suite → ./tests/regression/

  ── run summary ──────────────────────────────────────
  tests generated   41
  passed            36
  failed            5
  bugs filed        3
  security findings 6
  coverage gaps     4
  llm calls        118
```

QA-Swarm is a **multi-agent system** built on [LangGraph](https://github.com/langchain-ai/langgraph) that automates the full QA loop:

1. **Explore** — an agent crawls your web app and/or reads your OpenAPI spec, building a map of pages, flows, and endpoints.
2. **Generate** — a test-generator agent (powered by GPT-4o / Claude / any OpenAI-compatible LLM) writes Playwright test specs for what it found.
3. **Execute** — an executor agent runs those tests in a real browser, with **self-healing locators** that fix broken selectors mid-run.
4. **Triage** — a triage agent classifies every failure as `product-bug`, `test-bug`, `flaky`, or `environment` — so you don't waste time on flaky tests.
5. **Security & Performance** — parallel agents run OWASP-style header checks and p95/p99 budget gates.
6. **Report** — a reporter agent writes a markdown report, a JUnit XML, files bugs to your tracker, and **promotes passing tests into a regression suite**.

The whole thing is a state machine: agents hand off to each other through a shared `SwarmState`, with vector memory (Qdrant) for semantic dedup and Postgres for durable run history.

---

## 🤔 Why QA-Swarm

| Traditional QA | QA-Swarm |
|----------------|----------|
| Humans write every test | Agents generate tests from what they explore |
| Flaky tests waste CI time | Triage classifies each failure; flaky ones get quarantined, not blocked |
| Broken selectors = red builds | Self-healing locators auto-fix + open a PR |
| Security/perf are separate tools | One swarm, parallel agents, one report |
| Regression suites rot | Passing tests auto-promote into the suite |
| Bugs filed manually with vague repro | Bugs filed with a trace, a screenshot, and a confidence score |

It's not a replacement for your QA engineers — it's a **force multiplier** that takes the boilerplate off their plate so they can focus on the hard, exploratory work.

---

## 🏗 Architecture

```
                          ┌─────────────────┐
                          │   SwarmGraph    │  (LangGraph state machine)
                          └────────┬────────┘
                                   │
        ┌──────────────┬───────────┼───────────┬──────────────┐
        ▼              ▼           ▼           ▼              ▼
  ┌──────────┐  ┌────────────┐  ┌─────────┐  ┌──────────┐  ┌──────────┐
  │ Explorer │─▶│ TestGen    │─▶│Executor │─▶│ Triage   │  │ Security │
  └────┬─────┘  └────────────┘  └────┬────┘  └────┬─────┘  └──────────┘
       │              ▲                │            │              │
       │              │            (self-heal)      │              │
       │              │                │            ▼              ▼
       │         ┌────────┐        ┌─────────┐  ┌──────────┐  ┌──────────┐
       │         │Qdrant  │        │Quarantn │  │ Issue    │  │ Perf     │
       │         │(memory)│        └─────────┘  │ Tracker  │  │ budgets  │
       │         └────────┘                     └──────────┘  └──────────┘
       │
       ▼
  ┌──────────┐
  │ Reporter │ ──▶ markdown report + JUnit + regression suite
  └──────────┘
```

**Shared state** (`SwarmState`) flows through the graph: each agent reads what it needs and writes what it produced. The graph orchestrates ordering, retries, and parallel branches (security + performance run concurrently with triage).

**Tooling layer**: each agent has access to a toolbox (`packages/core/src/tools/`): a headless browser, an HTTP client, an OpenAPI parser, a DB client, and an issue-tracker adapter.

**Memory**: Qdrant stores semantic embeddings of explored pages + generated tests so the swarm doesn't re-explore or re-generate duplicates across runs. Postgres stores durable run history.

---

## 🚀 Quick start

### Prerequisites
- **Node.js ≥ 20**
- An **LLM API key** — either `OPENAI_API_KEY` or `ANTHROPIC_API_KEY` (set in `.env` or the environment). Without a key, the swarm runs in a degraded "mock LLM" mode that still exercises the graph + tools, useful for demos.
- (Optional, for full memory) **Docker** to run Qdrant + Postgres — see [Docker](#-docker-qdrant--postgres).

### Install + run

```bash
git clone https://github.com/Vaskoor/qa-swarm.git
cd qa-swarm
npm install            # installs all workspaces (core, cli, api, web)
npm run build          # tsc -b packages/core packages/cli

# 1. Start the dashboard + API
npm run api            # → http://localhost:4317  (open it in a browser)

# 2. (in another terminal) run the CLI against a target
npm run swarm -- run https://example.com --both --offline
```

Open **http://localhost:4317** for the live dashboard, or watch the CLI stream in your terminal.

### One-shot via the API

```bash
# start a run
curl -X POST http://localhost:4317/runs \
  -H 'content-type: application/json' \
  -d '{"target":"https://example.com","targetKind":"both","dryRun":true}'

# → {"id":"run-lz0f3k","status":"running","poll":"/runs/run-lz0f3k"}

# poll for progress
curl http://localhost:4317/runs/run-lz0f3k
```

---

## 🐝 The agents

| Agent | File | Role |
|-------|------|------|
| 🧭 **Explorer** | `packages/core/src/agents/explorer.ts` | Crawls web pages (Playwright) + reads OpenAPI specs. Builds the exploration map (pages, flows, endpoints). |
| ✨ **Test Generator** | `packages/core/src/agents/test-generator.ts` | Uses the LLM to write Playwright specs from the map. Dedups against Qdrant so it doesn't regenerate known tests. |
| ▶ **Executor** | `packages/core/src/agents/executor.ts` | Runs the generated specs in a real browser. Invokes the **self-healer** on broken locators. |
| 🔬 **Triage** | `packages/core/src/agents/triage.ts` | Classifies each failure (`product-bug` / `test-bug` / `flaky` / `environment`) with a confidence score + a short rationale. |
| 🔒 **Security** | `packages/core/src/agents/security.ts` | OWASP-style checks: security headers, cookie flags, TLS, info-leak. |
| ⚡ **Performance** | `packages/core/src/agents/performance.ts` | Collects p50/p95/p99 + LCP/CLS and gates against your budgets. |
| 📋 **Reporter** | `packages/core/src/agents/reporter.ts` | Writes markdown report + JUnit XML, files bugs, promotes passing tests to the regression suite. |

Every agent extends `BaseAgent` (`packages/core/src/agents/base.ts`) which gives it: the shared `SwarmState`, the LLM provider, the tool registry, structured logging, and a retry/backoff wrapper.

---

## 🖥 The dashboard

A single-page control plane at `apps/web/index.html`, served by the API at `http://localhost:4317/`. It shows:

- **API health badge** (live, pulses green/red)
- **7-agent status bar** — each agent lights up `active` (blue) or `done` (green) as the swarm progresses
- **New Run form** — target URL/spec + kind (web / openapi / both)
- **Live metrics grid** — pages, endpoints, tests, passed, failed, bugs, security, perf, coverage gaps, LLM calls
- **Agent log** — terminal-style streaming of every agent message
- **Bugs table** — severity pills + titles + where they were filed
- **Test results table** — status pills (passed/failed/flaky/quarantined) + duration + error
- **Run history** — click any past run to re-view its results

The dashboard polls `/runs/:id` every 1.5s while a run is active — no WebSocket needed.

---

## 🖥 CLI reference

```bash
qa-swarm <command> [options]

Commands:
  run <target>            Run the full swarm against a URL or OpenAPI spec
  inspect <spec>          Parse an OpenAPI spec + print the endpoint map
  report <run-id>         Re-render the report for a past run
  list                    List recent runs (from the API)

Options for `run`:
  --kind <web|openapi|both>   What to explore (default: both)
  --offline                   Use the mock LLM (no API key needed)
  --dry-run                   Generate tests but don't execute (default: true)
  --budget-p95 <ms>           Performance p95 budget (default: 800)
  --max-pages <n>             Crawler page cap (default: 50)
  --no-security               Skip the security agent
  --no-performance            Skip the performance agent
```

Run `qa-swarm run --help` for the full list.

---

## 🌐 HTTP API

| Method | Path | Body / Query | Returns |
|--------|------|--------------|---------|
| `GET` | `/health` | — | `{ ok, runs, version, uptime }` |
| `GET` | `/` | — | the dashboard HTML |
| `GET` | `/ui` | — | alias for `/` |
| `POST` | `/runs` | `{ target, targetKind, baseUrl?, dryRun? }` | `{ id, status, poll }` (202) |
| `GET` | `/runs` | — | `[{ id, status, startedAt, tests, bugs }]` |
| `GET` | `/runs/:id` | — | full run state (summary, bugs, results, logs) |

The API is a thin control plane — runs are fire-and-forget and kept in memory. For multi-node durability, swap the `runs` Map for Redis or Postgres.

---

## ⚙ Configuration

Configuration is a `SwarmConfig` (`packages/core/src/types.ts`). Defaults live in `DEFAULT_CONFIG`. Override via the CLI flags, the API body, or environment variables:

| Env var | Default | Purpose |
|---------|---------|---------|
| `OPENAI_API_KEY` | — | LLM provider (OpenAI / GPT-4o) |
| `ANTHROPIC_API_KEY` | — | LLM provider (Anthropic / Claude) |
| `QA_LLM_PROVIDER` | `openai` | `openai` \| `anthropic` \| `mock` |
| `QA_QDRANT_URL` | `http://localhost:6333` | Qdrant for semantic memory |
| `QA_PG_URL` | `postgres://localhost/qa-swarm` | Postgres for run history |
| `PORT` | `4317` | API + dashboard port |
| `QA_BUDGET_P95` | `800` | Performance p95 budget (ms) |
| `QA_MAX_PAGES` | `50` | Crawler page cap |

Copy `.env.example` to `.env` and fill in your keys.

---

## 🐳 Docker (Qdrant + Postgres)

The full memory stack runs in Docker:

```bash
npm run docker:up    # docker compose -f docker/docker-compose.yml up -d
npm run docker:down # tear it down
```

This starts Qdrant (vector memory) + Postgres (run history) + Grafana + Prometheus (optional observability). Without Docker, the swarm falls back to in-memory stores — fine for a demo, not for multi-node.

---

## 🔄 Self-healing & quarantine

Two features make the swarm **robust to UI churn**:

- **Self-healing locators** (`packages/core/src/selfheal/locator-healer.ts`) — when a Playwright selector breaks, the healer asks the LLM to propose a new one from the page's live DOM, re-runs the test, and (on success) opens a diff so you can commit the fix.
- **Quarantine** (`packages/core/src/selfheal/quarantine.ts`) — tests that fail N times in a row as `flaky` are quarantined: they still run but no longer fail CI. They get a purple pill in the dashboard and a `@quarantine` tag in the spec.

---

## 🧪 Testing the platform itself

QA-Swarm eats its own dog food — the platform is tested with Playwright:

```bash
npm test               # all tests
npm run test:e2e       # end-to-end (the demo app)
npm run test:regression # regression (memory, healer, quarantine, security headers)
```

The regression suite covers: the memory API, the locator healer, the quarantine flow, and the security-headers check.

---

## 📁 Project structure

```
qa-swarm/
├── apps/
│   ├── api/                 # Express API + dashboard server (port 4317)
│   └── web/                 # the dashboard (single index.html)
├── packages/
│   ├── core/                # the swarm engine
│   │   └── src/
│   │       ├── agents/      # 7 agents + base
│   │       ├── graph/        # swarm-graph + langgraph adapter
│   │       ├── llm/          # provider + prompts
│   │       ├── memory/       # qdrant + store
│   │       ├── report/       # markdown, playwright, writer
│   │       ├── selfheal/     # locator-healer + quarantine
│   │       ├── tools/        # browser, api, db, issue-tracker, openapi
│   │       └── types.ts
│   └── cli/                 # the qa-swarm CLI
├── docker/                  # docker-compose for qdrant + postgres
├── docs/                    # ARCHITECTURE.md, AGENTS.md
├── examples/demo-app/       # a sample app to swarm against
├── openapi/                 # sample OpenAPI specs
└── tests/                   # e2e + regression suites
```

---

## 🗺 Roadmap

- [ ] **GitHub PR integration** — file bugs as PR comments + open self-heal fixes as PRs
- [ ] **Visual regression** — screenshot diffing agent
- [ ] **Accessibility agent** — axe-core + LLM remediation
- [ ] **Multi-model routing** — cheap model for exploration, strong model for test-gen
- [ ] **Run diffing** — "what changed since the last green run"
- [ ] **Slack/Teams notifications** — run-complete + bug-filed webhooks

---

## 🤝 Contributing

PRs welcome. The agent layer is the most extensible part — a new agent is just a class extending `BaseAgent` + a node in `SwarmGraph`. See `docs/AGENTS.md` for the authoring guide and `docs/ARCHITECTURE.md` for the state-flow contract.

```bash
npm install
npm run build
npm run lint
npm test
```

---

## 📄 License

Apache-2.0 — see [LICENSE](LICENSE). Build cool things with it.

<div align="center">

**[Quick start](#-quick-start) · [Architecture](#-architecture) · [Dashboard](#-the-dashboard) · [API](#-http-api)**

Made with 🐝 by the QA-Swarm community.

</div>
