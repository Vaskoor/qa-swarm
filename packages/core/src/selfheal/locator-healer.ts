import type { DiscoveredElement, HealRecord } from "../types.js";

/**
 * Self-healing locators.
 *
 * When a test fails because a selector no longer resolves, the healer:
 *  1. Re-snapshots the live page.
 *  2. Scores every candidate element against the broken selector's
 *     *intent signals* (name, label, role, placeholder, text).
 *  3. Returns the best match above a confidence floor.
 *
 * The scoring is intentionally explainable — every heal record carries the
 * strategy string that produced it, which the reporter surfaces so humans
 * can audit (and reject) auto-heals.
 */
export interface HealContext {
  brokenSelector: string;
  /** The element name the test author used, if known. */
  expectedName?: string;
  /** Live elements from a fresh DOM snapshot. */
  candidates: DiscoveredElement[];
}

export interface HealResult {
  healed: boolean;
  selector?: string;
  confidence: number;
  strategy: string;
  alternatives: { selector: string; score: number }[];
}

const FLOOR = 0.45;

export function healLocator(ctx: HealContext): HealResult {
  const signals = extractSignals(ctx.brokenSelector, ctx.expectedName);
  if (ctx.candidates.length === 0) {
    return {
      healed: false,
      confidence: 0,
      strategy: "no-candidates",
      alternatives: [],
    };
  }

  const scored = ctx.candidates
    .map((el) => {
      const { score, strategy } = scoreElement(el, signals);
      const selector = bestSelectorFor(el);
      return { el, score, strategy, selector };
    })
    .filter((s) => s.selector)
    .sort((a, b) => b.score - a.score);

  const best = scored[0];
  if (!best || best.score < FLOOR) {
    return {
      healed: false,
      confidence: best?.score ?? 0,
      strategy: "below-floor",
      alternatives: scored.slice(0, 3).map((s) => ({ selector: s.selector!, score: s.score })),
    };
  }

  return {
    healed: true,
    selector: best.selector,
    confidence: best.score,
    strategy: best.strategy,
    alternatives: scored.slice(1, 4).map((s) => ({ selector: s.selector!, score: s.score })),
  };
}

export function toHealRecord(testId: string, ctx: HealContext, res: HealResult): HealRecord | undefined {
  if (!res.healed || !res.selector) return undefined;
  return {
    testId,
    brokenSelector: ctx.brokenSelector,
    healedSelector: res.selector,
    strategy: res.strategy,
    confidence: res.confidence,
    at: new Date().toISOString(),
  };
}

// --- internals -----------------------------------------------------------

interface Signals {
  tokens: string[];
  role?: string;
  kind: "css" | "text" | "role" | "data-testid" | "unknown";
}

function extractSignals(selector: string, expectedName?: string): Signals {
  const raw = `${selector} ${expectedName ?? ""}`.toLowerCase();
  let kind: Signals["kind"] = "unknown";
  let role: string | undefined;

  const roleMatch = selector.match(/\[role=["']?([\w-]+)/i);
  if (roleMatch) {
    kind = "role";
    role = roleMatch[1]!.toLowerCase();
  } else if (selector.includes("data-testid")) {
    kind = "data-testid";
  } else if (/^text=/i.test(selector) || selector.includes(":has-text")) {
    kind = "text";
  } else if (/^[.#\[]/.test(selector)) {
    kind = "css";
  }

  const tokens = (raw.match(/[a-z0-9]+/g) ?? []).filter(
    (t) => t.length > 2 && !STOP.has(t),
  );
  return { tokens, role, kind };
}

const STOP = new Set([
  "the", "and", "for", "with", "test", "data", "testid", "class", "button",
  "input", "div", "span", "aria", "label",
]);

function scoreElement(
  el: DiscoveredElement,
  sig: Signals,
): { score: number; strategy: string } {
  let score = 0;
  const strategies: string[] = [];

  // Exact data-testid match is the strongest possible signal. Normalise both
  // sides (strip non-alphanumerics) so "login-submit" and "loginsubmit" match.
  if (sig.kind === "data-testid" && el.selectors.some((s) => s.includes("data-testid"))) {
    const norm = (v: string) => v.toLowerCase().replace(/[^a-z0-9]/g, "");
    const sigId = norm(sig.tokens.join(""));
    const elId = norm(el.name);
    const elTestIds = el.selectors
      .filter((s) => s.includes("data-testid"))
      .map((s) => norm(s));
    if (sigId && (elId === sigId || elTestIds.some((id) => id.includes(sigId)))) {
      score += 0.5;
      strategies.push("testid-name");
    }
  }

  // Text/label token overlap.
  const haystack = [
    el.name,
    el.label ?? "",
    el.placeholder ?? "",
  ]
    .join(" ")
    .toLowerCase();
  const hayTokens = new Set(haystack.match(/[a-z0-9]+/g) ?? []);
  let overlap = 0;
  for (const t of sig.tokens) if (hayTokens.has(t)) overlap++;
  const tokenScore = sig.tokens.length ? overlap / sig.tokens.length : 0;
  score += tokenScore * 0.35;
  if (tokenScore > 0.4) strategies.push("token-overlap");

  // Role match.
  if (sig.role && el.role?.toLowerCase() === sig.role) {
    score += 0.2;
    strategies.push("role-match");
  }

  // Structural compatibility: if the broken selector referenced a button/input
  // and the candidate is the same kind, that's a small positive signal.
  if (
    (sig.tokens.includes("button") && el.clickable) ||
    (sig.tokens.includes("input") && el.fillable)
  ) {
    score += 0.15;
    strategies.push("structural");
  }

  return {
    score: Math.min(score, 1),
    strategy: strategies.length ? strategies.join("+") : "weak",
  };
}

function bestSelectorFor(el: DiscoveredElement): string | undefined {
  // Prefer data-testid > role/name > aria-label > text > tag.
  const byTestId = el.selectors.find((s) => s.includes("data-testid"));
  if (byTestId) return byTestId;
  const byName = el.selectors.find((s) => s.startsWith("[name="));
  if (byName) return byName;
  const byAria = el.selectors.find((s) => s.startsWith("[aria-label="));
  if (byAria) return byAria;
  const byText = el.selectors.find((s) => s.startsWith("text="));
  if (byText) return byText;
  return el.selectors[0];
}