#!/usr/bin/env node
import { Command } from "commander";
import chalk from "chalk";
import { config as loadEnv } from "dotenv";
import path from "node:path";
import {
  DEFAULT_CONFIG,
  SwarmGraph,
  writeRunArtifacts,
  type AgentRole,
  type SwarmConfig,
} from "@qa-swarm/core";

loadEnv();

const program = new Command();

program
  .name("qa-swarm")
  .description("An open-source swarm of AI agents that explore, test, and triage your app.")
  .version("0.1.0");

program
  .command("run", { isDefault: true })
  .description("Run the full swarm against a URL or OpenAPI spec")
  .argument("<target>", "URL to explore, or path/URL to an OpenAPI spec")
  .option("--openapi", "treat the target as an OpenAPI spec")
  .option("--both", "explore the web app AND the API")
  .option("--base-url <url>", "base URL for resolving relative links")
  .option("--max-pages <n>", "max pages to explore", (v) => parseInt(v, 10))
  .option("--max-tests <n>", "max tests to generate", (v) => parseInt(v, 10))
  .option("--agents <list>", "comma-separated agent list", (v) => v.split(","))
  .option("--headed", "run browser in headed mode")
  .option("--serial", "run tests serially")
  .option("--offline", "use heuristic mock LLM (no API keys needed)")
  .option("--no-dry-run", "actually file issues to Jira/GitHub")
  .option("--out <dir>", "output directory", "./qa-swarm-out")
  .option("--llm <provider>", "openai | anthropic | mock")
  .option("--model <name>", "model name")
  .action(async (target: string, opts) => {
    const config = buildConfig(target, opts);
    printBanner(config);

    const graph = new SwarmGraph(config, {
      onLog: (e) => {
        const tag = colorForAgent(e.agent);
        const lvl =
          e.level === "error"
            ? chalk.red("x")
            : e.level === "warn"
              ? chalk.yellow("!")
              : chalk.green(".");
        console.log(`${lvl} ${tag} ${chalk.dim(e.message)}`);
      },
    });

    const t0 = Date.now();
    const state = await graph.run();
    const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

    const artifacts = await writeRunArtifacts(state);

    printSummary(state, elapsed, artifacts);
    process.exitCode = state.phase === "failed" ? 1 : 0;
  });

program
  .command("explore")
  .description("Only run the Explorer agent and dump discovered pages")
  .argument("<url>")
  .option("--max-pages <n>", "max pages", (v) => parseInt(v, 10))
  .action(async (url: string, opts) => {
    const config = buildConfig(url, { ...opts, agents: ["explorer"] });
    const graph = new SwarmGraph(config, {
      onLog: (e) => console.log(chalk.dim(`- ${e.agent} ${e.message}`)),
    });
    const state = await graph.run();
    console.log(
      JSON.stringify(
        state.pages.map((p) => ({
          url: p.url,
          title: p.title,
          role: p.role,
          elements: p.elements.length,
        })),
        null,
        2,
      ),
    );
  });

program
  .command("gen")
  .description("Explore + generate tests (no execution)")
  .argument("<url>")
  .action(async (url: string) => {
    const config = buildConfig(url, { agents: ["explorer", "test-generator"] });
    const graph = new SwarmGraph(config, {
      onLog: (e) => console.log(chalk.dim(`- ${e.agent} ${e.message}`)),
    });
    const state = await graph.run();
    await writeRunArtifacts(state);
    console.log(
      chalk.green(`generated ${state.tests.length} tests -> ${config.outputDir}/tests`),
    );
  });

program.parseAsync(process.argv).catch((err) => {
  console.error(chalk.red("fatal:"), err);
  process.exit(1);
});

function buildConfig(target: string, opts: any): SwarmConfig {
  const agents: AgentRole[] = opts.agents ? (opts.agents as AgentRole[]) : DEFAULT_CONFIG.agents;
  const targetKind = opts.openapi ? "openapi" : opts.both ? "both" : "web";

  return {
    ...DEFAULT_CONFIG,
    target,
    targetKind,
    baseUrl: opts.baseUrl ?? (targetKind === "openapi" ? undefined : target),
    maxPages: opts.maxPages ?? DEFAULT_CONFIG.maxPages,
    maxTests: opts.maxTests ?? DEFAULT_CONFIG.maxTests,
    agents,
    headless: !opts.headed,
    serial: Boolean(opts.serial),
    dryRun: opts.dryRun !== false,
    outputDir: path.resolve(opts.out ?? DEFAULT_CONFIG.outputDir),
    llm: {
      ...DEFAULT_CONFIG.llm,
      provider: (opts.llm as SwarmConfig["llm"]["provider"]) ?? inferProvider(),
      model: opts.model ?? defaultModel(inferProvider()),
      offline: Boolean(opts.offline),
    },
    memory: {
      ...DEFAULT_CONFIG.memory,
      qdrantUrl: process.env.QDRANT_URL,
      embedded: !process.env.QDRANT_URL,
    },
  };
}

function inferProvider(): SwarmConfig["llm"]["provider"] {
  if (process.env.ANTHROPIC_API_KEY && !process.env.OPENAI_API_KEY) return "anthropic";
  if (process.env.OPENAI_API_KEY) return "openai";
  return "mock";
}

function defaultModel(p: SwarmConfig["llm"]["provider"]): string {
  if (p === "anthropic") return "claude-3-5-sonnet-20241022";
  if (p === "openai") return "gpt-4o-mini";
  return "mock";
}

function colorForAgent(agent: string): string {
  const colors: Record<string, (s: string) => string> = {
    explorer: chalk.cyan,
    "test-generator": chalk.magenta,
    executor: chalk.blue,
    triage: chalk.yellow,
    security: chalk.red,
    performance: chalk.green,
    reporter: chalk.white,
  };
  const fn = colors[agent] ?? chalk.gray;
  return fn(`[${agent}]`.padEnd(18));
}

function printBanner(config: SwarmConfig): void {
  console.log("");
  console.log(chalk.bold.cyan("  +---------------------------------------------+"));
  console.log(chalk.bold.cyan("  |  QA-SWARM  -  Devin for QA                  |"));
  console.log(chalk.bold.cyan("  +---------------------------------------------+"));
  console.log(`  target   ${chalk.underline(config.target)}`);
  console.log(`  kind     ${config.targetKind}`);
  console.log(`  agents   ${config.agents.join(", ")}`);
  console.log(
    `  llm      ${config.llm.provider}${config.llm.offline ? chalk.dim(" (offline)") : ""} - ${config.llm.model}`,
  );
  console.log(`  memory   ${config.memory.embedded ? "embedded" : config.memory.qdrantUrl}`);
  console.log(`  dry-run  ${config.dryRun}`);
  console.log("");
}

function printSummary(
  state: Awaited<ReturnType<SwarmGraph["run"]>>,
  elapsed: string,
  artifacts: { reportPath: string; testFiles: string[] },
): void {
  const passed = state.results.filter((r) => r.status === "passed").length;
  const failed = state.results.filter((r) => r.status === "failed").length;
  const bugs = state.bugs.length;

  console.log("");
  console.log(chalk.bold("  -- run summary ------------------------------"));
  console.log(`  duration          ${elapsed}s`);
  console.log(`  pages explored    ${state.pages.length}`);
  console.log(`  api endpoints     ${state.apiEndpoints.length}`);
  console.log(`  tests generated   ${state.tests.length}`);
  console.log(`  tests executed    ${state.results.length}`);
  console.log(`  passed            ${chalk.green(String(passed))}`);
  console.log(`  failed            ${failed ? chalk.red(String(failed)) : "0"}`);
  console.log(`  bugs filed        ${bugs ? chalk.red(String(bugs)) : "0"}`);
  console.log(`  security findings ${state.securityFindings.length}`);
  console.log(`  coverage gaps     ${state.coverageGaps.length}`);
  console.log(`  llm calls         ${state.usage.llmCalls} (${state.usage.tokens} tokens)`);
  console.log("");
  console.log(chalk.bold("  artifacts"));
  console.log(`    report  ${artifacts.reportPath}`);
  console.log(
    `    tests   ${artifacts.testFiles.length} file(s) in ${state.config.outputDir}/tests`,
  );
  console.log("");

  if (bugs > 0) {
    console.log(chalk.bold.red(`  ${bugs} bug(s) found - see the report for evidence.`));
  }
}