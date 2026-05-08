#!/usr/bin/env bun
// audit-aliases — verify spatial-api.yaml synonyms[] do not contain
// vendor-trademarked tokens. Run in pre-commit + CI. Exits non-zero on
// any match. See web/src/spatial-api.LICENSE.md for the legal
// analysis backing this audit.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

interface DenylistFile {
  brands: string[];
  compoundTokens: string[];
  regex: string[];
}

interface AuditHit {
  canonical: string;
  synonym: string;
  matched: string;
  matchType: "brand" | "compoundToken" | "regex";
}

// Minimal YAML extractor — just enough for synonyms parsing. Same shape
// as the parser in web/src/dictionary.ts but standalone (no Vite import).
function extractAliases(yamlText: string): { canonical: string; synonyms: string[] }[] {
  const out: { canonical: string; synonyms: string[] }[] = [];
  const lines = yamlText.split(/\r?\n/);
  let currentCanonical: string | null = null;
  let currentSynonyms: string[] | null = null;
  let inSynonymsBlock = false;

  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    const line = raw.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;

    const dashMatch = /^(\s*)-\s+canonical_name:\s*(\S+)/.exec(line);
    if (dashMatch) {
      // flush previous
      if (currentCanonical && currentSynonyms) {
        out.push({ canonical: currentCanonical, synonyms: currentSynonyms });
      }
      currentCanonical = dashMatch[2].replace(/['"]/g, "");
      currentSynonyms = [];
      inSynonymsBlock = false;
      continue;
    }

    // inline synonyms: [ ... ]
    const inlineMatch = /^\s+synonyms:\s*\[(.+)\]\s*$/.exec(line);
    if (inlineMatch && currentSynonyms !== null) {
      const tokens = inlineMatch[1]
        .split(",")
        .map((t) => t.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      currentSynonyms.push(...tokens);
      inSynonymsBlock = false;
      continue;
    }

    // block synonyms:
    if (/^\s+synonyms:\s*$/.test(line) && currentSynonyms !== null) {
      inSynonymsBlock = true;
      continue;
    }

    if (inSynonymsBlock) {
      const itemMatch = /^\s+-\s+(.+)$/.exec(line);
      if (itemMatch && currentSynonyms !== null) {
        currentSynonyms.push(itemMatch[1].trim().replace(/^['"]|['"]$/g, ""));
        continue;
      }
      // any non-list line ends the block
      inSynonymsBlock = false;
    }
  }

  // flush last
  if (currentCanonical && currentSynonyms) {
    out.push({ canonical: currentCanonical, synonyms: currentSynonyms });
  }
  return out;
}

function audit(): { hits: AuditHit[]; rowCount: number; tokenCount: number } {
  const repoRoot = resolve(import.meta.dir, "..");
  const yamlPath = resolve(repoRoot, "web/src/commands/spatial-api.yaml");
  const denylistPath = resolve(repoRoot, "web/src/trademark-denylist.json");

  const yamlText = readFileSync(yamlPath, "utf8");
  const denylist: DenylistFile = JSON.parse(readFileSync(denylistPath, "utf8"));

  const aliases = extractAliases(yamlText);

  const hits: AuditHit[] = [];
  let tokenCount = 0;

  const brandSet = new Set(denylist.brands.map((b) => b.toLowerCase()));
  const compoundSet = new Set(denylist.compoundTokens.map((c) => c.toLowerCase()));
  const regexes = denylist.regex.map((r) => {
    // strip leading flags like (?i) — JS uses /flag, not inline groups
    const ci = r.startsWith("(?i)") ? "i" : "";
    const pattern = r.replace(/^\(\?i\)/, "");
    return new RegExp(pattern, ci);
  });

  for (const row of aliases) {
    for (const syn of row.synonyms) {
      tokenCount++;
      const lower = syn.toLowerCase();

      for (const brand of brandSet) {
        if (lower.includes(brand)) {
          hits.push({ canonical: row.canonical, synonym: syn, matched: brand, matchType: "brand" });
        }
      }
      for (const compound of compoundSet) {
        if (lower.includes(compound)) {
          hits.push({ canonical: row.canonical, synonym: syn, matched: compound, matchType: "compoundToken" });
        }
      }
      for (const re of regexes) {
        if (re.test(syn)) {
          hits.push({ canonical: row.canonical, synonym: syn, matched: re.source, matchType: "regex" });
        }
      }
    }
  }

  return { hits, rowCount: aliases.length, tokenCount };
}

const { hits, rowCount, tokenCount } = audit();

if (hits.length === 0) {
  console.log(`audit-aliases: 0 trademark matches across ${rowCount} rows / ${tokenCount} synonyms — OK`);
  process.exit(0);
}

for (const hit of hits) {
  console.error(`TRADEMARK MATCH: row=${hit.canonical}, synonym="${hit.synonym}", matched=${hit.matched} (${hit.matchType})`);
}
console.error(`audit-aliases: ${hits.length} matches across ${rowCount} rows / ${tokenCount} synonyms`);
process.exit(1);
