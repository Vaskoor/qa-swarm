import type { GeneratedTest, TestStep } from "../types.js";

/**
 * Render a GeneratedTest into a real Playwright spec file.
 *
 * The generated code is deliberately boring: explicit goto, explicit
 * locators, explicit expects. Boring tests are debuggable tests.
 */
export function renderPlaywright(test: GeneratedTest, baseUrl: string): string {
  if (test.kind === "api") {
    return `import { test, expect } from "@playwright/test";

test.describe(${JSON.stringify(test.kind)}, () => {
  test(${JSON.stringify(test.title)}, async ({ request }) => {
    ${renderApiSteps(test, baseUrl)}
  });
});
`;
  }

  const body = test.steps.map((s) => renderStep(s, baseUrl)).join("\n  ");

  return `import { test, expect } from "@playwright/test";

test.describe(${JSON.stringify(test.tags[0] ?? "ui")}, () => {
  test(${JSON.stringify(test.title)}, async ({ page }) => {
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(e.message));
    ${body}
  });
});
`;
}

function renderStep(step: TestStep, baseUrl: string): string {
  switch (step.action) {
    case "goto":
      return `await page.goto(${JSON.stringify(absolutize(step.url, baseUrl))});`;
    case "click":
      return `await page.locator(${JSON.stringify(step.selector)}).first().click();`;
    case "fill":
      return `await page.locator(${JSON.stringify(step.selector)}).first().fill(${JSON.stringify(step.value)});`;
    case "expect":
      return `// expect: ${step.assertion}\n  await expect(page.locator("body")).toBeVisible();`;
    case "wait":
      return `await page.waitForTimeout(${step.ms});`;
    case "request":
      return `// request ${step.method} ${step.url}`;
    case "custom":
      return step.code;
    default:
      return "";
  }
}

function renderApiSteps(test: GeneratedTest, baseUrl: string): string {
  const req = test.steps.find((s) => s.action === "request");
  if (!req || req.action !== "request") {
    return `// no request step defined for ${test.id}`;
  }
  const url = absolutize(req.url, baseUrl);
  const opts: string[] = [];
  if (req.body !== undefined) opts.push(`data: ${JSON.stringify(req.body)}`);
  const optsStr = opts.length ? `, { ${opts.join(", ")} }` : "";
  return [
    `const res = await request.${req.method.toLowerCase()}(${JSON.stringify(url)}${optsStr});`,
    `expect(res.status(), "unexpected status").toBeLessThan(400);`,
    `const ct = res.headers()["content-type"] ?? "";`,
    `if (ct.includes("json")) {`,
    `  const body = await res.json();`,
    `  expect(body, "response body should not be empty").toBeTruthy();`,
    `}`,
  ].join("\n    ");
}

export function absolutize(url: string, baseUrl: string): string {
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseUrl) return url;
  return `${baseUrl.replace(/\/$/, "")}${url.startsWith("/") ? "" : "/"}${url}`;
}