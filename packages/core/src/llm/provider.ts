import type { SwarmConfig } from "../types.js";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface CompletionResult {
  text: string;
  tokens: number;
  model: string;
  synthetic: boolean;
}

export interface LLMProvider {
  readonly name: string;
  complete(
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number; json?: boolean },
  ): Promise<CompletionResult>;
}

/**
 * Deterministic "LLM" used when `config.llm.offline` is true or no API key
 * is present. It returns structured placeholders so the whole pipeline can
 * run in CI and on airplanes without burning tokens.
 */
export class MockProvider implements LLMProvider {
  readonly name = "mock";

  async complete(
    messages: ChatMessage[],
    opts?: { json?: boolean },
  ): Promise<CompletionResult> {
    const last = messages[messages.length - 1]?.content ?? "";
    const text = opts?.json
      ? JSON.stringify(this.synthesizeJson(last))
      : this.synthesizeText(last);
    return { text, tokens: Math.ceil(text.length / 4), model: "mock", synthetic: true };
  }

  private synthesizeText(prompt: string): string {
    const head = prompt.split("\n").find((l) => l.trim().length > 0) ?? "task";
    return `[offline] ${head.slice(0, 160)}`;
  }

  private synthesizeJson(prompt: string): unknown {
    if (/array|list|\[/i.test(prompt)) return [];
    return {};
  }
}

export function createProvider(config: SwarmConfig): LLMProvider {
  const wantOffline =
    config.llm.offline ||
    (config.llm.provider === "openai" && !process.env.OPENAI_API_KEY) ||
    (config.llm.provider === "anthropic" && !process.env.ANTHROPIC_API_KEY);
  if (wantOffline) return new MockProvider();
  return new LazyProvider(config);
}

class LazyProvider implements LLMProvider {
  readonly name: string;
  constructor(private config: SwarmConfig) {
    this.name = config.llm.provider;
  }

  async complete(
    messages: ChatMessage[],
    opts?: { temperature?: number; maxTokens?: number; json?: boolean },
  ): Promise<CompletionResult> {
    if (this.config.llm.provider === "openai") {
      const { default: OpenAI } = await import("openai");
      const client = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });
      const res = await client.chat.completions.create({
        model: this.config.llm.model,
        temperature: opts?.temperature ?? this.config.llm.temperature,
        max_tokens: opts?.maxTokens,
        response_format: opts?.json ? { type: "json_object" } : undefined,
        messages,
      });
      const text = res.choices[0]?.message?.content ?? "";
      return {
        text,
        tokens: res.usage?.total_tokens ?? Math.ceil(text.length / 4),
        model: this.config.llm.model,
        synthetic: false,
      };
    }

    if (this.config.llm.provider === "anthropic") {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-api-key": process.env.ANTHROPIC_API_KEY ?? "",
          "anthropic-version": "2023-06-01",
        },
        body: JSON.stringify({
          model: this.config.llm.model,
          max_tokens: opts?.maxTokens ?? 2048,
          temperature: opts?.temperature ?? this.config.llm.temperature,
          system: messages.find((m) => m.role === "system")?.content,
          messages: messages
            .filter((m) => m.role !== "system")
            .map((m) => ({ role: m.role, content: m.content })),
        }),
      });
      if (!res.ok) throw new Error(`anthropic ${res.status}: ${await res.text()}`);
      const data = (await res.json()) as {
        content: { text: string }[];
        usage?: { input_tokens: number; output_tokens: number };
      };
      const text = data.content.map((c) => c.text).join("\n");
      return {
        text,
        tokens:
          (data.usage?.input_tokens ?? 0) + (data.usage?.output_tokens ?? 0),
        model: this.config.llm.model,
        synthetic: false,
      };
    }

    return new MockProvider().complete(messages, opts);
  }
}