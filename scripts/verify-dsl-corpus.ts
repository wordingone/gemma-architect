/**
 * Compile-check every DSL row in the demo corpus + run the lowered JS
 * through the same Tier 1 surface used at runtime. Surfaces: any DSL
 * regression that breaks .compileDsl() OR the lowered replicad chain.
 *
 * Why: the corpus is the ground truth the lexicon spec promises to
 * accept. If a corpus row stops compiling or executing, the spec
 * silently broke.
 */

import { readFile } from "node:fs/promises";
import { compileDsl } from "../web/src/commands/dsl-eval.js";
import { execute } from "../src/generate/execute.js";

const corpus = (await readFile("data/dsl-demo-corpus.jsonl", "utf8"))
  .trim()
  .split("\n")
  .filter(Boolean)
  .map((line) => JSON.parse(line));

let pass = 0;
let fail = 0;

for (const row of corpus) {
  const c = compileDsl(row.dsl);
  if (!c.ok) {
    console.log(`FAIL  ${row.id}  compile L${c.line}: ${c.message}`);
    fail++;
    continue;
  }
  const r = await execute(c.js);
  if (!r.ok) {
    console.log(`FAIL  ${row.id}  exec: ${r.error}`);
    fail++;
    continue;
  }
  console.log(`OK    ${row.id}  ${r.resultKind}  ${c.solids.length} solids`);
  pass++;
}

console.log(`\n${pass}/${pass + fail} corpus rows compile + execute`);
if (fail) process.exit(1);
