#!/usr/bin/env node
// transform-args-to-json-schema.mjs
// Transforms spatial-api.yaml args: list blocks → JSON Schema parameters: blocks.
//
// Input format per arg:
//   - {name: x, type: y, required: true/false, unit?: m, default?: v, description?: "..."}
//   OR block style (for enum_choice args with options):
//   - name: x
//     type: enum_choice
//     required: false
//     default: val
//     description: "..."
//     options:
//       - {value: ..., label: ..., description: ...}
//
// Output format (JSON Schema):
//   parameters:
//     type: object
//     properties:
//       x:
//         type: y
//         description: "..."     # if present
//         unit: m                 # if present
//         default: v              # if present
//         options:                # if present (block style preserved)
//           - {value: ..., ...}
//     required: [a, b]           # only required:true args; [] if none

import fs from "fs";
import path from "path";

const YAML_PATH = path.join(import.meta.dirname, "../web/src/commands/spatial-api.yaml");
const text = fs.readFileSync(YAML_PATH, "utf8");
const lines = text.split("\n");

// Parse an inline map string "{k: v, k: v, ...}" → plain object.
// Handles quoted string values and bracketed arrays for default values.
function parseInlineMap(s) {
  s = s.trim();
  if (!s.startsWith("{") || !s.endsWith("}")) return null;
  s = s.slice(1, -1);
  const out = {};
  // Tokenise: respect quotes and brackets
  let key = null, buf = "", depth = 0, inQ = false, qChar = "";
  for (let i = 0; i <= s.length; i++) {
    const ch = i < s.length ? s[i] : ",";
    if (inQ) {
      if (ch === qChar) { inQ = false; }
      buf += ch;
    } else if (ch === '"' || ch === "'") {
      inQ = true; qChar = ch; buf += ch;
    } else if (ch === "[" || ch === "{") {
      depth++; buf += ch;
    } else if (ch === "]" || ch === "}") {
      depth--; buf += ch;
    } else if (ch === ":" && key === null && depth === 0) {
      key = buf.trim(); buf = "";
    } else if (ch === "," && depth === 0) {
      if (key !== null) {
        out[key] = coerceScalar(buf.trim());
        key = null;
      }
      buf = "";
    } else {
      buf += ch;
    }
  }
  if (key !== null) out[key] = coerceScalar(buf.trim());
  return out;
}

function coerceScalar(v) {
  if (v === "true") return true;
  if (v === "false") return false;
  if (v === "null" || v === "~" || v === "") return null;
  if (/^-?\d+(\.\d+)?$/.test(v)) return Number(v);
  // Strip surrounding quotes
  if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
    return v.slice(1, -1);
  }
  return v;
}

// Indent a multiline string by N spaces (prepend to each line)
function indent(str, n) {
  const pad = " ".repeat(n);
  return str.split("\n").map(l => l.length ? pad + l : l).join("\n");
}

// Format a scalar value as YAML inline
function fmtVal(v) {
  if (v === null) return "~";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  const s = String(v);
  if (s.includes(":") || s.includes("#") || s.includes('"') || s.startsWith("{") || s.startsWith("[")) {
    return JSON.stringify(s);
  }
  return s;
}

// Main transformation state machine
let output = [];
let i = 0;

while (i < lines.length) {
  const line = lines[i];
  const trimmed = line.trim();

  // Detect start of an args: block (exactly 2-space indented, under an entry)
  if (/^  args:/.test(line)) {
    // Collect all arg lines until we hit a non-arg continuation (dedent to 2-space level)
    // Args items are at 4-space indent level: "    - ..."
    const args = [];
    i++;

    while (i < lines.length) {
      const al = lines[i];
      const at = al.trim();

      // Empty line or comment — skip (might be between entries, stop)
      if (at === "" || at.startsWith("#")) break;

      // Non-arg continuation: back at 2-space indent (sibling field)
      if (/^  \w/.test(al) && !/^    /.test(al)) break;

      // Arg item start: "    - {inline}" or "    - name: x" (block style)
      if (/^    - /.test(al)) {
        const rest = al.replace(/^    - /, "").trim();
        if (rest.startsWith("{")) {
          // Inline map
          const obj = parseInlineMap(rest);
          if (obj) args.push({ kind: "inline", ...obj });
          i++;
        } else {
          // Block style arg (name: x\n type: y\n ...)
          const blockArg = {};
          // First line "name: x" or "type: x" etc.
          const [k, ...vp] = rest.split(":");
          if (k && vp.length) blockArg[k.trim()] = coerceScalar(vp.join(":").trim());
          i++;
          // Continue reading block fields at 6-space indent
          const optionLines = [];
          let inOptions = false;
          while (i < lines.length) {
            const bl = lines[i];
            const bt = bl.trim();
            if (bt === "" || bt.startsWith("#")) break;
            if (/^      options:/.test(bl)) {
              inOptions = true;
              optionLines.push(bl);
              i++;
              continue;
            }
            if (inOptions) {
              if (/^        /.test(bl)) {
                optionLines.push(bl);
                i++;
                continue;
              } else {
                inOptions = false;
              }
            }
            if (!/^      /.test(bl)) break;
            const [bk, ...bvp] = bt.split(":");
            if (bk && bvp.length) blockArg[bk.trim()] = coerceScalar(bvp.join(":").trim());
            i++;
          }
          if (optionLines.length) blockArg._optionLines = optionLines;
          args.push({ kind: "block", ...blockArg });
        }
        continue;
      }

      // Anything else at 4+ indent that isn't "    - " might be continuation — skip
      i++;
    }

    // Now emit parameters: block
    const required = args.filter(a => a.required === true).map(a => String(a.name));
    output.push("  parameters:");
    output.push("    type: object");
    output.push("    properties:");
    for (const arg of args) {
      const argName = String(arg.name);
      output.push(`      ${argName}:`);
      output.push(`        type: ${fmtVal(arg.type)}`);
      if (arg.description !== undefined && arg.description !== null) {
        output.push(`        description: ${JSON.stringify(String(arg.description))}`);
      }
      if (arg.unit !== undefined && arg.unit !== null) {
        output.push(`        unit: ${fmtVal(arg.unit)}`);
      }
      if (arg.default !== undefined && arg.default !== null) {
        output.push(`        default: ${fmtVal(arg.default)}`);
      }
      if (arg._optionLines) {
        // Re-emit options block with adjusted indent (6-space → 8-space)
        for (const ol of arg._optionLines) {
          output.push("  " + ol); // shift 2 spaces right
        }
      }
    }
    if (required.length > 0) {
      output.push(`    required: [${required.join(", ")}]`);
    } else {
      output.push("    required: []");
    }
    continue; // already advanced i
  }

  // Pass through everything else unchanged
  output.push(line);
  i++;
}

const result = output.join("\n");

// Verify: no "  args:" lines remain
const remaining = (result.match(/^  args:/mg) || []).length;
if (remaining > 0) {
  console.error(`ERROR: ${remaining} args: blocks remain after transformation`);
  process.exit(1);
}

// Verify: parameters: count matches expected entries
const paramCount = (result.match(/^  parameters:/mg) || []).length;
console.log(`Transformed ${paramCount} entries (expected 118 total, some may have no args).`);
const argsEntries = (text.match(/^  args:/mg) || []).length;
console.log(`Original args: blocks: ${argsEntries}`);

fs.writeFileSync(YAML_PATH, result, "utf8");
console.log("Done. Written to", YAML_PATH);
