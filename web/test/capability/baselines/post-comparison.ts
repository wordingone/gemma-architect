#!/usr/bin/env bun
// web/test/capability/baselines/post-comparison.ts — P8c comparison table
//
// Reads the latest receipt files for gemma-architect, bare-gemma, and blender-mcp,
// builds a K/N comparison table, and posts it as a comment on GitHub issue #100.
//
// Usage:
//   bun web/test/capability/baselines/post-comparison.ts
//   bun web/test/capability/baselines/post-comparison.ts --dry-run  # print table, no post

import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execSync } from "node:child_process";

const REPO = resolve(import.meta.dir, "../../../../");
const STATE_DIR = join(REPO, "state");
const ISSUE = 100;

const DRY_RUN = process.argv.includes("--dry-run");

type Receipt = {
  runner: string;
  sha?: string;
  timestamp: string;
  k: number;
  n: number;
  results: Array<{
    id: string;
    pass: boolean;
    score: number;
    checks_passed: number;
    checks_total: number;
  }>;
};

async function latestReceipt(prefix: string): Promise<Receipt | null> {
  const files = await readdir(STATE_DIR);
  const matches = files
    .filter(f => f.startsWith(prefix) && f.endsWith(".json"))
    .sort()
    .reverse();
  if (matches.length === 0) return null;
  const raw = await readFile(join(STATE_DIR, matches[0]), "utf-8");
  return JSON.parse(raw) as Receipt;
}

async function main() {
  const [appReceipt, bareReceipt, blenderReceipt] = await Promise.all([
    latestReceipt("capability-bench-"),
    latestReceipt("capability-bench-baseline-bare-gemma-"),
    latestReceipt("capability-bench-baseline-blender-mcp-"),
  ]);

  if (!appReceipt) {
    console.error("No gemma-architect receipt found. Run: bun run capability-bench");
    process.exit(1);
  }

  const sha = execSync("git rev-parse --short HEAD", { cwd: REPO }).toString().trim();

  // Build per-prompt table
  const prompts = appReceipt.results.map(r => r.id);

  function fmt(receipt: Receipt | null, promptId: string): string {
    if (!receipt) return "—";
    const r = receipt.results.find(x => x.id === promptId);
    if (!r) return "—";
    return `${r.checks_passed}/${r.checks_total}`;
  }

  function kRow(receipt: Receipt | null): string {
    if (!receipt) return "not run";
    return `**${receipt.k}/${receipt.n}**`;
  }

  const rows = prompts.map(id => {
    const app = appReceipt.results.find(r => r.id === id)!;
    return `| ${id} | ${app.checks_passed}/${app.checks_total} ${app.pass ? "✓" : "✗"} | ${fmt(bareReceipt, id)} | ${fmt(blenderReceipt, id)} |`;
  }).join("\n");

  const table = `## P8c — Capability Comparison Table

| Prompt | gemma-architect | bare-Gemma 4 E2B | Blender MCP + Bonsai |
|--------|:--------------:|:----------------:|:-------------------:|
${rows}
| **TOTAL K/N** | ${kRow(appReceipt)} | ${kRow(bareReceipt)} | ${kRow(blenderReceipt)} |

**SHA:** \`${sha}\`
**gemma-architect receipt:** \`${appReceipt.timestamp}\`
**bare-Gemma receipt:** \`${bareReceipt?.timestamp ?? "not run"}\`
**Blender MCP receipt:** \`${blenderReceipt?.timestamp ?? "not run"}\`

> Scoring: checks_passed / checks_total per prompt. K = prompts meeting min_pass_threshold.
> bare-Gemma baseline uses Gemma 4 E2B-it with no IFC/architecture orchestration layer.
> Blender MCP baseline uses blender-mcp + Bonsai IFC export driven by LLM-generated Python.
`;

  console.log(table);

  if (DRY_RUN) {
    console.log("\n[dry-run] skipping GitHub post");
    return;
  }

  try {
    execSync(
      `gh issue comment ${ISSUE} --body ${JSON.stringify(table)}`,
      { cwd: REPO, stdio: "inherit" }
    );
    console.log(`\nPosted to issue #${ISSUE}`);
  } catch (e: any) {
    console.error(`Failed to post: ${e.message}`);
    process.exit(1);
  }
}

main().catch(e => { console.error(e); process.exit(1); });
