import type { DiscoveredElement, DiscoveredPage, NetworkObservation } from "../types.js";

/**
 * Browser tool — a thin, swappable wrapper over Playwright.
 *
 * We deliberately keep the surface tiny (goto, snapshot, click, fill) so the
 * Explorer agent reasons about *intent*, not Playwright minutiae. That also
 * makes it trivial to mock in unit tests.
 */
export interface BrowserTool {
  launch(): Promise<void>;
  goto(url: string): Promise<{ status: number; url: string }>;
  snapshot(): Promise<DiscoveredPage>;
  click(selector: string): Promise<void>;
  fill(selector: string, value: string): Promise<void>;
  screenshot(path: string): Promise<void>;
  network(): NetworkObservation[];
  close(): Promise<void>;
}

export interface PlaywrightBrowserOptions {
  headless: boolean;
  baseUrl?: string;
  /** Capture a screenshot per page — useful evidence for bug reports. */
  screenshotDir?: string;
}

export class PlaywrightBrowserTool implements BrowserTool {
  private browser: any;
  private context: any;
  private page: any;
  private net: NetworkObservation[] = [];

  constructor(private opts: PlaywrightBrowserOptions) {}

  async launch(): Promise<void> {
    const { chromium } = await import("playwright");
    this.browser = await chromium.launch({ headless: this.opts.headless });
    this.context = await this.browser.newContext({
      viewport: { width: 1440, height: 900 },
      ignoreHTTPSErrors: true,
    });
    this.page = await this.context.newPage();
    this.page.on("response", (res: any) => {
      const req = res.request();
      if (["document", "xhr", "fetch"].includes(req.resourceType())) {
        this.net.push({
          method: req.method(),
          url: res.url(),
          status: res.status(),
          contentType: res.headers()["content-type"],
        });
      }
    });
    this.page.on("pageerror", (err: Error) => {
      this.net.push({
        method: "PAGEERROR",
        url: this.page.url(),
        status: 0,
        jsonShape: { message: err.message },
      });
    });
  }

  async goto(url: string): Promise<{ status: number; url: string }> {
    const res = await this.page.goto(url, {
      waitUntil: "domcontentloaded",
      timeout: 30_000,
    });
    await this.page.waitForLoadState("networkidle", { timeout: 5_000 }).catch(() => {});
    return { status: res?.status() ?? 0, url: this.page.url() };
  }

  async snapshot(): Promise<DiscoveredPage> {
    const url: string = this.page.url();
    const title: string = await this.page.title();
    const raw = await this.page.evaluate(() => {
      const els = Array.from(
        document.querySelectorAll(
          "a, button, input, select, textarea, [role=button], [role=link], [role=tab]",
        ),
      );
      const seen = new Set<string>();
      const out: any[] = [];
      for (const el of els) {
        const e = el as HTMLElement;
        const name =
          e.getAttribute("data-testid") ||
          e.getAttribute("name") ||
          e.getAttribute("aria-label") ||
          (e as HTMLInputElement).placeholder ||
          e.textContent?.trim().slice(0, 40) ||
          e.tagName.toLowerCase();
        if (!name || seen.has(name)) continue;
        seen.add(name);
        const selectors: string[] = [];
        if (e.getAttribute("data-testid"))
          selectors.push(`[data-testid="${e.getAttribute("data-testid")}"]`);
        if (e.getAttribute("name")) selectors.push(`[name="${e.getAttribute("name")}"]`);
        if (e.getAttribute("aria-label"))
          selectors.push(`[aria-label="${e.getAttribute("aria-label")}"]`);
        const text = e.textContent?.trim().slice(0, 40);
        if (text && (e.tagName === "BUTTON" || e.tagName === "A"))
          selectors.push(`text=${text}`);
        selectors.push(e.tagName.toLowerCase());
        out.push({
          name,
          selectors,
          tag: e.tagName.toLowerCase(),
          role: e.getAttribute("role") ?? undefined,
          label: e.getAttribute("aria-label") ?? undefined,
          placeholder: (e as HTMLInputElement).placeholder ?? undefined,
          fillable: ["input", "textarea", "select"].includes(e.tagName.toLowerCase()),
          clickable: ["button", "a"].includes(e.tagName.toLowerCase()) ||
            e.getAttribute("role") === "button",
          required: (e as HTMLInputElement).required ?? undefined,
          inputType: (e as HTMLInputElement).type ?? undefined,
        });
      }
      const links = Array.from(document.querySelectorAll("a[href]"))
        .map((a) => (a as HTMLAnchorElement).href)
        .filter((h) => h.startsWith("http"));
      return { els: out, links };
    });

    const links: string[] = raw.links
      .filter((l: string) => !l.includes("#"))
      .slice(0, 200);

    const screenshotDir = this.opts.screenshotDir;
    let screenshot: string | undefined;
    if (screenshotDir) {
      const safe = url.replace(/[^a-z0-9]/gi, "_").slice(0, 80);
      screenshot = `${screenshotDir}/${safe}.png`;
      await this.screenshot(screenshot).catch(() => undefined);
    }

    return {
      id: url,
      url,
      title,
      role: guessRole(url, title),
      elements: raw.els as DiscoveredElement[],
      network: [...this.net],
      links,
      screenshot,
      discoveredAt: new Date().toISOString(),
    };
  }

  async click(selector: string): Promise<void> {
    await this.page.locator(selector).first().click({ timeout: 10_000 });
  }

  async fill(selector: string, value: string): Promise<void> {
    await this.page.locator(selector).first().fill(value, { timeout: 10_000 });
  }

  async screenshot(path: string): Promise<void> {
    await this.page.screenshot({ path, fullPage: true });
  }

  network(): NetworkObservation[] {
    return [...this.net];
  }

  async close(): Promise<void> {
    await this.context?.close().catch(() => {});
    await this.browser?.close().catch(() => {});
  }
}

/** Heuristic page-role classifier — used when the LLM is offline. */
export function guessRole(url: string, title: string): string {
  const s = `${url} ${title}`.toLowerCase();
  if (/login|signin|sign-in|auth/.test(s)) return "auth";
  if (/register|signup|sign-up/.test(s)) return "registration";
  if (/dashboard|home|overview/.test(s)) return "dashboard";
  if (/checkout|cart|payment/.test(s)) return "checkout";
  if (/search|results/.test(s)) return "search";
  if (/profile|account|settings/.test(s)) return "account";
  if (/admin/.test(s)) return "admin";
  if (/docs|help|faq/.test(s)) return "docs";
  return "generic";
}