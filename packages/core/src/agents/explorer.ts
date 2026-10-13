import type { Agent, AgentContext } from "./base.js";
import { askJson } from "./base.js";
import type { DiscoveredPage, SwarmState } from "../types.js";
import { PlaywrightBrowserTool } from "../tools/browser.js";
import { explorerPrompt, PLANNER_SYSTEM } from "../llm/prompts.js";

interface ExplorerPlan {
  role?: string;
  priorityElements?: string[];
  notes?: string;
}

/**
 * Explorer agent.
 *
 * Crawls the target breadth-first, respecting maxPages, and asks the LLM to
 * classify each page + rank its elements. Everything is written to vector
 * memory so subsequent runs skip pages already understood.
 */
export class ExplorerAgent implements Agent {
  readonly role = "explorer" as const;

  async run(state: SwarmState, ctx: AgentContext): Promise<Partial<SwarmState>> {
    const { config } = state;
    if (config.targetKind === "openapi") {
      ctx.log(this.role, "openapi-only target — skipping browser crawl");
      return { phase: "generating" };
    }

    const browser = new PlaywrightBrowserTool({
      headless: config.headless,
      baseUrl: config.baseUrl,
      screenshotDir: `${config.outputDir}/screenshots`,
    });

    const pages: DiscoveredPage[] = [...state.pages];
    const visited = new Set(pages.map((p) => p.url));
    const queue: string[] = [config.baseUrl ?? config.target];
    const origin = safeOrigin(config.baseUrl ?? config.target);

    try {
      await browser.launch();
      while (queue.length > 0 && pages.length < config.maxPages) {
        const url = queue.shift()!;
        if (visited.has(url)) continue;
        if (origin && !url.startsWith(origin)) continue;
        visited.add(url);

        ctx.log(this.role, `visiting ${url}`);
        let status = 0;
        try {
          const res = await browser.goto(url);
          status = res.status;
        } catch (err) {
          ctx.log(this.role, `navigation failed: ${(err as Error).message}`, "warn");
          continue;
        }

        const page = await browser.snapshot();
        if (status >= 400) {
          ctx.log(this.role, `HTTP ${status} at ${url}`, "warn", { status, url });
          page.role = "error-page";
        }

        const plan = await askJson<ExplorerPlan>(
          ctx,
          this.role,
          [
            { role: "system", content: PLANNER_SYSTEM },
            { role: "user", content: explorerPrompt(page) },
          ],
          {},
          512,
        );
        if (plan.role) page.role = plan.role;

        pages.push(page);
        await ctx.memory.rememberPage(page);

        for (const link of page.links) {
          if (!visited.has(link) && queue.length + pages.length < config.maxPages * 2) {
            queue.push(link);
          }
        }
      }
    } finally {
      await browser.close();
    }

    ctx.log(this.role, `explored ${pages.length} page(s)`);
    return { pages, phase: "generating" };
  }
}

function safeOrigin(url: string): string | undefined {
  try {
    return new URL(url).origin;
  } catch {
    return undefined;
  }
}