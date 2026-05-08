// Verify the DSL examples shown in the CONSOLE-tab placeholder compile cleanly.
// If a future placeholder change drifts away from valid DSL, this catches it.

import { compileDsl } from "../web/src/commands/dsl-eval.js";
import { execute } from "../src/generate/execute.js";

const placeholderExamples = [
  "wall (0 0) (5 0) height=3 thickness=0.2",
  "column (0 0) height=3 profile=square(0.3)",
];

let pass = 0;
let fail = 0;
for (const src of placeholderExamples) {
  const c = compileDsl(src);
  if (!c.ok) {
    console.log(`FAIL  ${src}\n  compile: line ${c.line} ${c.message}`);
    fail++;
    continue;
  }
  const r = await execute(c.js);
  if (!r.ok) {
    console.log(`FAIL  ${src}\n  exec: ${r.error}`);
    fail++;
    continue;
  }
  console.log(`OK    ${src}\n  → ${r.resultKind} (${c.solids.length} solid${c.solids.length === 1 ? "" : "s"})`);
  pass++;
}

console.log(`\n${pass}/${pass + fail} placeholder examples valid`);
if (fail > 0) process.exit(1);
