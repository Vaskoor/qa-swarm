import type { AgentRole, SwarmState } from "../types.js";
import type { LLMProvider, ChatMessage } from "../llm/provider.js";
import type { SwarmMemory } from "../memory/memory.js";

/**
 * Every agent gets the same toolbox and returns a partial state patch.
 * Agents are pure-ish: they read from state, call tools/LLM, and return the
 * slice they are responsible for. The graph merges patches into state.
 */
export interface AgentContext {
  llm: LLMProvider;
  memory: SwarmMemory;
  /** Structured logger that also appends to state.log. */
  log: (
    agent: AgentRole,
    message: string,
    level?: "info" | "warn" | "error" | "debug",
    data?: unknown,
  ) => void;
  /** Aborts the whole run when the token/step budget is exhausted. */
  budget: BudgetGuard;
}

export interface Agent {
  readonly role: AgentRole;
  run(state: SwarmState, ctx: AgentContext): Promise<Partial<SwarmState>>;
}

export class BudgetGuard {
  private calls = 0;
  private tokens = 0;
  constructor(
    private maxCalls: number,
    private maxTokens: number,
  ) {}

  spend(tokens: number): void {
    this.calls++;
    this.tokens += tokens;
  }

  get exhausted(): boolean {
    return this.calls >= this.maxCalls || this.tokens >= this.maxTokens;
  }

  get usage(): { llmCalls: number; tokens: number } {
    return { llmCalls: this.calls, tokens: this.tokens };
  }
}

/** Helper to ask the LLM for JSON and parse it defensively. */
export async function askJson<T = unknown>(
  ctx: AgentContext,
  agent: AgentRole,
  messages: ChatMessage[],
  fallback: T,
  maxTokens = 2048,
): Promise<T> {
  if (ctx.budget.exhausted) {
    ctx.log(agent, "budget exhausted — returning fallback", "warn");
    return fallback;
  }
  try {
    const res = await ctx.llm.complete(messages, { json: true, maxTokens });
    ctx.budget.spend(res.tokens);
    const json = extractJson(res.text);
    if (json === undefined) return fallback;
    return json as T;
  } catch (err) {
    ctx.log(agent, `LLM call failed: ${(err as Error).message}`, "warn");
    return fallback;
  }
}

/** LLMs sometimes wrap JSON in prose or fences. Dig it out. */
export function extractJson(text: string): unknown {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  const candidate = fenced ? fenced[1]! : text;
  const firstObj = candidate.indexOf("{");
  const firstArr = candidate.indexOf("[");
  const starts = [firstObj, firstArr].filter((i) => i >= 0);
  if (starts.length === 0) return undefined;
  const start = Math.min(...starts);
  const openCh = candidate[start];
  const closeCh = openCh === "{" ? "}" : "]";
  const end = candidate.lastIndexOf(closeCh);
  if (end <= start) return undefined;
  try {
    return JSON.parse(candidate.slice(start, end + 1));
  } catch {
    return undefined;
  }
}