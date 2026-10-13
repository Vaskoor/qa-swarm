import { describe, expect, it } from "vitest";
import { checkHeaders } from "@qa-swarm/core";

describe("deterministic security header checks", () => {
  it("flags missing CSP and HSTS", () => {
    const findings = checkHeaders("https://app.example.com", {
      "content-type": "text/html",
    });
    const titles = findings.map((f) => f.title);
    expect(titles.some((t) => t.includes("content-security-policy"))).toBe(true);
    expect(titles.some((t) => t.includes("strict-transport-security"))).toBe(true);
  });

  it("flags wildcard CORS", () => {
    const findings = checkHeaders("https://api.example.com", {
      "access-control-allow-origin": "*",
      "content-security-policy": "default-src 'self'",
      "x-content-type-options": "nosniff",
      "x-frame-options": "DENY",
      "strict-transport-security": "max-age=63072000",
      "referrer-policy": "no-referrer",
    });
    expect(findings.some((f) => f.category === "cors")).toBe(true);
  });

  it("flags server version disclosure", () => {
    const findings = checkHeaders("https://api.example.com", {
      server: "nginx/1.25.3",
    });
    expect(findings.some((f) => f.title.includes("Server version"))).toBe(true);
  });
});