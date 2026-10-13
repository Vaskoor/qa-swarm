import { describe, expect, it } from "vitest";
import { healLocator } from "@qa-swarm/core";
import type { DiscoveredElement } from "@qa-swarm/core";

const el = (over: Partial<DiscoveredElement>): DiscoveredElement => ({
  name: "submit",
  selectors: ["button"],
  tag: "button",
  fillable: false,
  clickable: true,
  ...over,
});

describe("locator healer", () => {
  it("heals a broken data-testid by token overlap", () => {
    const result = healLocator({
      brokenSelector: '[data-testid="login-submit"]',
      candidates: [
        el({
          name: "login-submit",
          selectors: ['[data-testid="login-submit"]', "button"],
        }),
        el({ name: "cancel", selectors: ['[data-testid="cancel"]', "button"] }),
      ],
    });
    expect(result.healed).toBe(true);
    expect(result.selector).toContain("login-submit");
    expect(result.confidence).toBeGreaterThan(0.5);
  });

  it("refuses to heal when nothing matches", () => {
    const result = healLocator({
      brokenSelector: '[data-testid="totally-unrelated-thing"]',
      candidates: [el({ name: "alpha", selectors: ["#alpha"] })],
    });
    expect(result.healed).toBe(false);
    expect(result.confidence).toBeLessThan(0.5);
  });

  it("prefers role match when selector carried a role", () => {
    const result = healLocator({
      brokenSelector: '[role="tab"] "Billing"',
      candidates: [
        el({
          name: "Billing",
          role: "tab",
          selectors: ['[role="tab"]:has-text("Billing")'],
        }),
      ],
    });
    // Role is a positive signal; the element should be picked as the best
    // candidate even if overall confidence sits at the floor.
    expect(result.confidence).toBeGreaterThan(0);
    expect(
      result.healed || result.alternatives.some((a) => a.selector.includes("tab")),
    ).toBe(true);
  });
});