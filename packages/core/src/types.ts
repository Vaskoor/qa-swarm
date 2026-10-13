/**
 * QA-Swarm shared domain types.
 *
 * These types are the contract between every agent, tool, and reporter in the
 * swarm. Keeping them in one file is deliberate: the state graph is typed
 * against `SwarmState`, and every node reads from / writes to that state.
 */

export type AgentRole =
  | "explorer"
  | "test-generator"
  | "executor"
  | "triage"
  | "security"
  | "performance"
  | "reporter";

export interface DiscoveredPage {
  id: string;
  url: string;
  title: string;
  role: string;
  elements: DiscoveredElement[];
  network: NetworkObservation[];
  links: string[];
  screenshot?: string;
  discoveredAt: string;
}

export interface DiscoveredElement {
  name: string;
  selectors: string[];
  tag: string;
  role?: string;
  label?: string;
  placeholder?: string;
  fillable: boolean;
  clickable: boolean;
  required?: boolean;
  inputType?: string;
}

export interface NetworkObservation {
  method: string;
  url: string;
  status?: number;
  contentType?: string;
  jsonShape?: unknown;
}

export interface GeneratedTest {
  id: string;
  title: string;
  kind: "ui" | "api" | "security" | "performance";
  origin: string;
  intent: string;
  steps: TestStep[];
  expected: string;
  tags: string[];
  priority: "P0" | "P1" | "P2";
  code?: string;
  fingerprint?: string;
}

export type TestStep =
  | { action: "goto"; url: string }
  | { action: "click"; selector: string; description?: string }
  | { action: "fill"; selector: string; value: string; description?: string }
  | { action: "expect"; assertion: string; description?: string }
  | { action: "request"; method: string; url: string; body?: unknown }
  | { action: "wait"; ms: number }
  | { action: "custom"; code: string };

export interface TestResult {
  testId: string;
  title: string;
  status: "passed" | "failed" | "flaky" | "skipped" | "quarantined";
  durationMs: number;
  error?: string;
  stack?: string;
  artifacts: Artifact[];
  attempts: number;
  failedSelector?: string;
  signals?: RunSignal[];
}

export interface Artifact {
  kind: "screenshot" | "trace" | "video" | "log" | "har" | "json";
  path: string;
  description?: string;
}

export interface RunSignal {
  kind: "console" | "network" | "dom";
  level?: "error" | "warn" | "info";
  message: string;
  at: string;
}

export interface TriageVerdict {
  testId: string;
  classification:
    | "product-bug"
    | "test-bug"
    | "flaky"
    | "environment"
    | "unknown";
  confidence: number;
  rootCause: string;
  evidence: string[];
  reproducible: boolean;
  recommendation: string;
  quarantined?: boolean;
}

export type Severity = "blocker" | "critical" | "major" | "minor" | "trivial";

export interface BugReport {
  id: string;
  title: string;
  summary: string;
  severity: Severity;
  stepsToReproduce: string[];
  expected: string;
  actual: string;
  evidence: Artifact[];
  environment: Record<string, string>;
  target: "jira" | "github" | "local";
  externalRef?: string;
  fingerprint: string;
  createdAt: string;
}

export interface CoverageGap {
  area: string;
  description: string;
  confidence: number;
  suggestion: string;
}

export interface SecurityFinding {
  id: string;
  title: string;
  category:
    | "xss"
    | "sqli"
    | "csrf"
    | "authz"
    | "secrets"
    | "headers"
    | "cors"
    | "other";
  severity: Severity;
  url: string;
  evidence: string;
  remediation: string;
  cwe?: string;
}

export interface PerformanceFinding {
  id: string;
  url: string;
  metric: "ttfb" | "lcp" | "fcp" | "cls" | "tbt" | "request-count" | "payload";
  value: number;
  unit: string;
  budget: number;
  passed: boolean;
  recommendation: string;
}

export interface SwarmConfig {
  target: string;
  targetKind: "web" | "openapi" | "both";
  maxPages: number;
  maxTests: number;
  agents: AgentRole[];
  baseUrl?: string;
  headless: boolean;
  serial: boolean;
  flakeThreshold: number;
  dryRun: boolean;
  outputDir: string;
  llm: {
    provider: "openai" | "anthropic" | "mock";
    model: string;
    temperature: number;
    offline: boolean;
  };
  memory: {
    qdrantUrl?: string;
    collection: string;
    embedded: boolean;
  };
  budget: {
    maxLlmCalls: number;
    maxTokens: number;
  };
}

export const DEFAULT_CONFIG: SwarmConfig = {
  target: "http://localhost:3000",
  targetKind: "web",
  maxPages: 25,
  maxTests: 80,
  agents: [
    "explorer",
    "test-generator",
    "executor",
    "triage",
    "security",
    "performance",
    "reporter",
  ],
  headless: true,
  serial: false,
  flakeThreshold: 2,
  dryRun: true,
  outputDir: "./qa-swarm-out",
  llm: {
    provider: "openai",
    model: "gpt-4o-mini",
    temperature: 0.2,
    offline: false,
  },
  memory: {
    collection: "qa-swarm",
    embedded: true,
  },
  budget: {
    maxLlmCalls: 400,
    maxTokens: 600_000,
  },
};

export interface SwarmState {
  config: SwarmConfig;
  pages: DiscoveredPage[];
  apiEndpoints: ApiEndpoint[];
  tests: GeneratedTest[];
  results: TestResult[];
  verdicts: TriageVerdict[];
  bugs: BugReport[];
  coverageGaps: CoverageGap[];
  securityFindings: SecurityFinding[];
  performanceFindings: PerformanceFinding[];
  log: AgentLogEntry[];
  feedback: FeedbackSignal[];
  usage: { llmCalls: number; tokens: number };
  errors: string[];
  phase: SwarmPhase;
  runId: string;
}

export type SwarmPhase =
  | "init"
  | "exploring"
  | "generating"
  | "executing"
  | "triaging"
  | "security"
  | "performance"
  | "reporting"
  | "done"
  | "failed";

export interface AgentLogEntry {
  at: string;
  agent: AgentRole;
  message: string;
  level: "info" | "warn" | "error" | "debug";
  data?: unknown;
}

export interface FeedbackSignal {
  target: string;
  weight: number;
  note: string;
  at: string;
}

export interface ApiEndpoint {
  method: string;
  path: string;
  summary?: string;
  operationId?: string;
  parameters: { name: string; in: string; required: boolean; schema?: unknown }[];
  requestBodySchema?: unknown;
  responses: Record<string, { description?: string; schema?: unknown }>;
  tags: string[];
}

export interface HealRecord {
  testId: string;
  brokenSelector: string;
  healedSelector: string;
  strategy: string;
  confidence: number;
  at: string;
}

export interface QuarantineRecord {
  testId: string;
  title: string;
  reason: string;
  flakeCount: number;
  quarantinedAt: string;
  expiresAt?: string;
}