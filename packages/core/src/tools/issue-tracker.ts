import type { BugReport } from "../types.js";

export interface IssueTracker {
  readonly kind: "jira" | "github" | "local";
  readonly enabled: boolean;
  file(bug: BugReport): Promise<{ ref: string; url?: string }>;
}

/** Writes bug reports as markdown to disk — always works, never spams. */
export class LocalIssueTracker implements IssueTracker {
  readonly kind = "local" as const;
  readonly enabled = true;

  constructor(private outputDir: string) {}

  async file(bug: BugReport): Promise<{ ref: string }> {
    const fs = await import("node:fs/promises");
    const path = await import("node:path");
    await fs.mkdir(this.outputDir, { recursive: true });
    const file = path.join(this.outputDir, `${bug.id}.md`);
    await fs.writeFile(file, renderMarkdown(bug), "utf8");
    return { ref: file };
  }
}

export class GitHubIssueTracker implements IssueTracker {
  readonly kind = "github" as const;
  readonly enabled: boolean;

  constructor(
    private repo: string | undefined,
    private token: string | undefined,
    private dryRun: boolean,
  ) {
    this.enabled = Boolean(repo && token);
  }

  async file(bug: BugReport): Promise<{ ref: string; url?: string }> {
    if (!this.enabled) throw new Error("GitHub tracker not configured");
    if (this.dryRun) return { ref: `dry-run://github/${this.repo}/${bug.id}` };

    const res = await fetch(`https://api.github.com/repos/${this.repo}/issues`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.token}`,
        accept: "application/vnd.github+json",
        "content-type": "application/json",
        "user-agent": "qa-swarm",
      },
      body: JSON.stringify({
        title: `[QA-Swarm] ${bug.title}`,
        body: renderMarkdown(bug),
        labels: ["qa-swarm", `severity:${bug.severity}`, "bug"],
      }),
    });
    if (!res.ok) throw new Error(`github ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { number: number; html_url: string };
    return { ref: `#${data.number}`, url: data.html_url };
  }
}

export class JiraIssueTracker implements IssueTracker {
  readonly kind = "jira" as const;
  readonly enabled: boolean;

  constructor(
    private baseUrl: string | undefined,
    private projectKey: string | undefined,
    private email: string | undefined,
    private token: string | undefined,
    private dryRun: boolean,
  ) {
    this.enabled = Boolean(baseUrl && projectKey && email && token);
  }

  async file(bug: BugReport): Promise<{ ref: string; url?: string }> {
    if (!this.enabled) throw new Error("Jira tracker not configured");
    if (this.dryRun) return { ref: `dry-run://jira/${this.projectKey}/${bug.id}` };

    const auth = Buffer.from(`${this.email}:${this.token}`).toString("base64");
    const res = await fetch(`${this.baseUrl}/rest/api/3/issue`, {
      method: "POST",
      headers: {
        authorization: `Basic ${auth}`,
        accept: "application/json",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        fields: {
          project: { key: this.projectKey },
          summary: `[QA-Swarm] ${bug.title}`,
          description: {
            type: "doc",
            version: 1,
            content: [
              {
                type: "paragraph",
                content: [{ type: "text", text: bug.summary }],
              },
            ],
          },
          issuetype: { name: "Bug" },
          labels: ["qa-swarm", `severity-${bug.severity}`],
        },
      }),
    });
    if (!res.ok) throw new Error(`jira ${res.status}: ${await res.text()}`);
    const data = (await res.json()) as { key: string; self: string };
    return { ref: data.key, url: `${this.baseUrl}/browse/${data.key}` };
  }
}

/** Tries trackers in priority order and falls back to local files. */
export class CompositeIssueTracker implements IssueTracker {
  readonly kind: "jira" | "github" | "local";
  readonly enabled = true;

  constructor(private trackers: IssueTracker[]) {
    const first = trackers.find((t) => t.enabled);
    this.kind = first?.kind ?? "local";
  }

  async file(bug: BugReport): Promise<{ ref: string; url?: string }> {
    for (const t of this.trackers) {
      if (!t.enabled) continue;
      try {
        return await t.file(bug);
      } catch {
        // fall through to next tracker
      }
    }
    const local = this.trackers.find((t) => t.kind === "local")!;
    return local.file(bug);
  }
}

export function renderMarkdown(bug: BugReport): string {
  return [
    `# ${bug.title}`,
    "",
    `**Severity:** ${bug.severity}  `,
    `**Fingerprint:** \`${bug.fingerprint}\``,
    "",
    "## Summary",
    bug.summary,
    "",
    "## Steps to reproduce",
    ...bug.stepsToReproduce.map((s, i) => `${i + 1}. ${s}`),
    "",
    "## Expected",
    bug.expected,
    "",
    "## Actual",
    bug.actual,
    "",
    "## Evidence",
    ...(bug.evidence.length
      ? bug.evidence.map(
          (a) =>
            `- \`${a.kind}\`: ${a.path}${a.description ? ` — ${a.description}` : ""}`,
        )
      : ["_(none captured)_"]),
    "",
    "## Environment",
    ...Object.entries(bug.environment).map(([k, v]) => `- **${k}**: ${v}`),
    "",
    "---",
    "_Filed automatically by QA-Swarm._",
  ].join("\n");
}

export function createIssueTracker(opts: {
  outputDir: string;
  dryRun: boolean;
}): IssueTracker {
  const trackers: IssueTracker[] = [];
  if (process.env.JIRA_BASE_URL && process.env.JIRA_API_TOKEN) {
    trackers.push(
      new JiraIssueTracker(
        process.env.JIRA_BASE_URL,
        process.env.JIRA_PROJECT_KEY,
        process.env.JIRA_EMAIL,
        process.env.JIRA_API_TOKEN,
        opts.dryRun,
      ),
    );
  }
  if (process.env.GITHUB_TOKEN && process.env.GITHUB_REPO) {
    trackers.push(
      new GitHubIssueTracker(
        process.env.GITHUB_REPO,
        process.env.GITHUB_TOKEN,
        opts.dryRun,
      ),
    );
  }
  trackers.push(new LocalIssueTracker(opts.outputDir));
  return new CompositeIssueTracker(trackers);
}