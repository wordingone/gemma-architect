#!/usr/bin/env bun
// Kill every node/vite process listening on a TCP port EXCEPT :5847 from master clone.
// Idempotent. Safe — leaves :5847 alone.

import { execSync } from "node:child_process";

const KEEP_PORT = 5847;
const KEEP_CWD_FRAGMENT = "gemma-architect-master"; // only the master clone keeps :5847

// Note: $_ and $p are PS automatic/local variables — NOT template placeholders.
// They appear as literal $_ in the PS script (not ${...}, so JS template does not expand them).
const ps = `
Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue |
Where-Object { $_.LocalPort -ge 3000 -and $_.LocalPort -le 9000 } |
ForEach-Object {
  $p = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $_.OwningProcess) -ErrorAction SilentlyContinue;
  if ($p -and $p.CommandLine -match 'vite') {
    [PSCustomObject]@{ Port=$_.LocalPort; PID=$_.OwningProcess; Cmd=$p.CommandLine }
  }
} | ConvertTo-Json -Compress
`;

const raw = execSync(
  `powershell -NoProfile -Command "${ps.replace(/\r?\n\s*/g, " ").trim()}"`,
  { encoding: "utf8" },
).trim();
if (!raw || raw === "null") { console.log("no vite processes found"); process.exit(0); }
const procs = JSON.parse(raw.startsWith("[") ? raw : `[${raw}]`);

const stale = procs.filter((p: { Port: number; Cmd: string }) =>
  !(p.Port === KEEP_PORT && p.Cmd.includes(KEEP_CWD_FRAGMENT))
);

if (stale.length === 0) {
  console.log(`clean — only :${KEEP_PORT} (${KEEP_CWD_FRAGMENT}) running`);
  process.exit(0);
}

console.log(`killing ${stale.length} stale vite process(es):`);
for (const p of stale) {
  console.log(`  port=${p.Port} pid=${p.PID}`);
  execSync(`powershell -NoProfile -Command "Stop-Process -Id ${p.PID} -Force -ErrorAction SilentlyContinue"`);
}
console.log("done");
