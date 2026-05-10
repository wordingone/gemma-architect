// Spatial Dictionary loader + alias index — T5.
//
// Source-of-truth: web/src/spatial-api.yaml.
// Loaded at module init via Vite's ?raw import; parsed once.
//
// The parser is a *minimal* YAML subset implementation, sufficient for the
// rigid schema we ship. It does NOT attempt to handle every YAML feature —
// only the constructs we actually use:
//   - top-level list of maps (`- key: value`)
//   - scalar key:value pairs
//   - inline lists `[a, b, c]` (with optional quoting on commas-or-spaces)
//   - inline maps `{key: value, key: value, key: [a, b]}`
//   - nested list-of-maps under `args:` and similar fields
//   - line comments (`#`) and blank lines
//
// If the YAML grows new constructs (anchors, multi-line strings, etc.)
// add the case here rather than reaching for a heavyweight YAML lib.

// Vite raw import — bundler reads spatial-api.yaml as a string at
// build time. Type assertion needed because TS doesn't know the ?raw query.
// (vite/client types declare the suffix, included via tsconfig.)
import yamlText from "./spatial-api.yaml?raw";

export type SdArgType =
  | "number" | "integer" | "string" | "boolean"
  | "point2" | "point3" | "vector3" | "plane3" | "line3"
  | "polyline" | "polyline_or_circle"
  | "edge" | "list_edge" | "edge_or_surface" | "list_edge_or_surface"
  | "curve" | "surface" | "surface_or_face" | "list_face"
  | "solid" | "solid_or_edge"
  | "any" | "list_any"
  | "number_or_vector3"
  | "list_point2"
  | "arraybuffer" | "enum_format"
  | "enum_choice";

export type ChoiceOption = {
  value: string;
  label: string;
  description: string;
};

export type SdArg = {
  name: string;
  type: SdArgType | string;
  required: boolean;
  unit?: string;
  default?: unknown;
  description?: string;
  options?: ChoiceOption[];
};

export type SdTopologyRole =
  | "host" | "hosted" | "void"
  | "face" | "edge" | "solid" | "compound"
  | "curve" | "surface"
  | "annotation" | "transform" | "view" | "selection" | "system";

export type SdKernel = "replicad" | "nurbs-webgpu";

export type SpatialDictionaryEntry = {
  canonical_name: string;
  ifc4_class?: string;
  kernel_op: string;
  args: SdArg[];
  topology_role: SdTopologyRole | string;
  kg_predicates: string[];
  synonyms: string[];
  hotkey?: string;
  kernel: SdKernel | string;
  alias_source: string;
};

// ============================================================
// Parser
// ============================================================

interface ParsedScalar { kind: "scalar"; value: string | number | boolean | null; }
interface ParsedList { kind: "list"; items: ParsedNode[]; }
interface ParsedMap { kind: "map"; entries: Record<string, ParsedNode>; }
type ParsedNode = ParsedScalar | ParsedList | ParsedMap;

function unquote(s: string): string {
  s = s.trim();
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}

function parseScalar(raw: string): ParsedScalar {
  const v = raw.trim();
  if (v === "" || v === "~" || v === "null") return { kind: "scalar", value: null };
  if (v === "true") return { kind: "scalar", value: true };
  if (v === "false") return { kind: "scalar", value: false };
  if (/^-?\d+(\.\d+)?$/.test(v)) return { kind: "scalar", value: Number(v) };
  return { kind: "scalar", value: unquote(v) };
}

// Parse an inline value: `[a, b]` | `{k: v, k: v}` | scalar
function parseInline(raw: string): ParsedNode {
  const v = raw.trim();
  if (v.startsWith("[") && v.endsWith("]")) {
    const inner = v.slice(1, -1).trim();
    if (inner === "") return { kind: "list", items: [] };
    return { kind: "list", items: splitCommaTopLevel(inner).map((s) => parseInline(s)) };
  }
  if (v.startsWith("{") && v.endsWith("}")) {
    const inner = v.slice(1, -1).trim();
    const entries: Record<string, ParsedNode> = {};
    for (const pair of splitCommaTopLevel(inner)) {
      const colon = findTopLevelColon(pair);
      if (colon < 0) continue;
      const key = unquote(pair.slice(0, colon).trim());
      const val = pair.slice(colon + 1).trim();
      entries[key] = parseInline(val);
    }
    return { kind: "map", entries };
  }
  return parseScalar(v);
}

// Split on commas that are NOT inside [], {}, or quotes.
function splitCommaTopLevel(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let inStr: string | null = null;
  let buf = "";
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      buf += c;
      if (c === inStr && s[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; buf += c; continue; }
    if (c === "[" || c === "{") { depth++; buf += c; continue; }
    if (c === "]" || c === "}") { depth--; buf += c; continue; }
    if (c === "," && depth === 0) { out.push(buf); buf = ""; continue; }
    buf += c;
  }
  if (buf.trim() !== "") out.push(buf);
  return out;
}

// Find the position of `:` that's at depth 0 and not inside quotes.
function findTopLevelColon(s: string): number {
  let depth = 0;
  let inStr: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (c === inStr && s[i - 1] !== "\\") inStr = null;
      continue;
    }
    if (c === '"' || c === "'") { inStr = c; continue; }
    if (c === "[" || c === "{") { depth++; continue; }
    if (c === "]" || c === "}") { depth--; continue; }
    if (c === ":" && depth === 0) return i;
  }
  return -1;
}

interface Line { indent: number; raw: string; text: string; }

function tokenize(text: string): Line[] {
  const out: Line[] = [];
  for (const raw of text.split(/\r?\n/)) {
    const stripped = raw.replace(/^(\s*)/, "");
    const indent = raw.length - stripped.length;
    // Strip line comments (# starts a comment unless inside [] / {}).
    let body = stripped;
    if (body !== "" && body[0] !== "#") {
      let depth = 0; let inStr: string | null = null;
      for (let i = 0; i < body.length; i++) {
        const c = body[i];
        if (inStr) {
          if (c === inStr && body[i - 1] !== "\\") inStr = null;
          continue;
        }
        if (c === '"' || c === "'") { inStr = c; continue; }
        if (c === "[" || c === "{") depth++;
        else if (c === "]" || c === "}") depth--;
        else if (c === "#" && depth === 0 && (i === 0 || /\s/.test(body[i - 1]))) {
          body = body.slice(0, i).replace(/\s+$/, "");
          break;
        }
      }
    } else if (body[0] === "#") {
      body = "";
    }
    if (body === "") continue;
    out.push({ indent, raw, text: body });
  }
  return out;
}

// Parse a sequence of lines starting at `start`, all sharing or exceeding
// `baseIndent`. Returns the parsed list (top-level YAML doc IS a list).
function parseList(lines: Line[], start: number, baseIndent: number): { node: ParsedList; end: number } {
  const items: ParsedNode[] = [];
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < baseIndent) break;
    if (!line.text.startsWith("- ") && line.text !== "-") {
      // Not a list item at this indent — caller's responsibility.
      break;
    }
    // Eat the "- " and treat the rest as the start of either a scalar or map.
    const rest = line.text.startsWith("- ") ? line.text.slice(2) : "";
    const itemBaseIndent = line.indent + 2;
    if (rest === "") {
      // Multi-line list item with body on following lines.
      const body = parseMap(lines, i + 1, itemBaseIndent);
      items.push(body.node);
      i = body.end;
    } else if (rest.startsWith("{") && rest.endsWith("}")) {
      // Inline map item.
      items.push(parseInline(rest));
      i++;
    } else {
      // First key:value of a map; following lines may continue the map.
      const colon = findTopLevelColon(rest);
      if (colon < 0) {
        // Pure scalar item.
        items.push(parseInline(rest));
        i++;
      } else {
        // Synthesise a virtual map starting on this line.
        const key = unquote(rest.slice(0, colon).trim());
        const val = rest.slice(colon + 1).trim();
        const entries: Record<string, ParsedNode> = {};
        if (val !== "") entries[key] = parseInline(val);
        else {
          // Block continues; defer until parseMap below
        }
        // Continue parsing keys at itemBaseIndent (line.indent + 2).
        let j = i + 1;
        while (j < lines.length && lines[j].indent >= itemBaseIndent) {
          const next = lines[j];
          if (next.indent !== itemBaseIndent) break;
          if (next.text.startsWith("- ")) break;
          const c2 = findTopLevelColon(next.text);
          if (c2 < 0) break;
          const k2 = unquote(next.text.slice(0, c2).trim());
          const v2 = next.text.slice(c2 + 1).trim();
          if (v2 === "") {
            // Block-style nested value (list or map) — read children at deeper indent.
            const childIndent = next.indent + 2;
            // Detect list-of-maps vs map-of-keys by peeking at the next line.
            if (j + 1 < lines.length && lines[j + 1].indent >= childIndent && lines[j + 1].text.startsWith("- ")) {
              const sub = parseList(lines, j + 1, childIndent);
              entries[k2] = sub.node;
              j = sub.end;
              continue;
            }
            // Otherwise treat as nested map.
            const sub = parseMap(lines, j + 1, childIndent);
            entries[k2] = sub.node;
            j = sub.end;
            continue;
          } else {
            entries[k2] = parseInline(v2);
            j++;
          }
        }
        items.push({ kind: "map", entries });
        i = j;
      }
    }
  }
  return { node: { kind: "list", items }, end: i };
}

function parseMap(lines: Line[], start: number, baseIndent: number): { node: ParsedMap; end: number } {
  const entries: Record<string, ParsedNode> = {};
  let i = start;
  while (i < lines.length) {
    const line = lines[i];
    if (line.indent < baseIndent) break;
    if (line.indent > baseIndent) break;
    if (line.text.startsWith("- ")) break;
    const colon = findTopLevelColon(line.text);
    if (colon < 0) break;
    const key = unquote(line.text.slice(0, colon).trim());
    const val = line.text.slice(colon + 1).trim();
    if (val !== "") {
      entries[key] = parseInline(val);
      i++;
    } else {
      // Block-style nested value.
      const childIndent = line.indent + 2;
      if (i + 1 < lines.length && lines[i + 1].indent >= childIndent && lines[i + 1].text.startsWith("- ")) {
        const sub = parseList(lines, i + 1, childIndent);
        entries[key] = sub.node;
        i = sub.end;
      } else {
        const sub = parseMap(lines, i + 1, childIndent);
        entries[key] = sub.node;
        i = sub.end;
      }
    }
  }
  return { node: { kind: "map", entries }, end: i };
}

function parseYaml(text: string): ParsedNode {
  const lines = tokenize(text);
  if (lines.length === 0) return { kind: "list", items: [] };
  // Top-level document is a list of maps.
  if (lines[0].text.startsWith("- ")) {
    return parseList(lines, 0, lines[0].indent).node;
  }
  return parseMap(lines, 0, lines[0].indent).node;
}

// ============================================================
// Coercion to typed entries
// ============================================================

function asString(n: ParsedNode | undefined, fallback = ""): string {
  if (!n) return fallback;
  if (n.kind === "scalar") return n.value === null ? fallback : String(n.value);
  return fallback;
}
function asStringList(n: ParsedNode | undefined): string[] {
  if (!n) return [];
  if (n.kind === "list") return n.items.map((it) => asString(it));
  return [];
}
function asArgList(n: ParsedNode | undefined): SdArg[] {
  if (!n || n.kind !== "list") return [];
  const out: SdArg[] = [];
  for (const it of n.items) {
    if (it.kind !== "map") continue;
    const e = it.entries;
    const arg: SdArg = {
      name: asString(e.name),
      type: asString(e.type),
      required: e.required && e.required.kind === "scalar" ? e.required.value === true : false,
    };
    if (e.unit) arg.unit = asString(e.unit);
    if (e.description) arg.description = asString(e.description);
    if (e.default !== undefined) {
      const d = e.default;
      if (d.kind === "scalar") arg.default = d.value;
      else if (d.kind === "list") arg.default = d.items.map((x) => x.kind === "scalar" ? x.value : null);
    }
    if (e.options && e.options.kind === "list") {
      arg.options = e.options.items
        .filter((o): o is ParsedMap => o.kind === "map")
        .map((o) => ({
          value: asString(o.entries.value),
          label: asString(o.entries.label),
          description: asString(o.entries.description),
        }));
    }
    out.push(arg);
  }
  return out;
}

function coerceEntry(node: ParsedNode): SpatialDictionaryEntry | null {
  if (node.kind !== "map") return null;
  const e = node.entries;
  const canonical_name = asString(e.canonical_name);
  const kernel_op = asString(e.kernel_op);
  if (!canonical_name || !kernel_op) return null;
  const entry: SpatialDictionaryEntry = {
    canonical_name,
    kernel_op,
    args: asArgList(e.args),
    topology_role: asString(e.topology_role),
    kg_predicates: asStringList(e.kg_predicates),
    synonyms: asStringList(e.synonyms),
    kernel: asString(e.kernel) || "replicad",
    alias_source: asString(e.alias_source) || "generic_cad_vocabulary",
  };
  if (e.ifc4_class) entry.ifc4_class = asString(e.ifc4_class);
  if (e.hotkey) entry.hotkey = asString(e.hotkey);
  return entry;
}

// ============================================================
// Public API
// ============================================================

let cachedEntries: SpatialDictionaryEntry[] | null = null;
let cachedAliasIndex: Map<string, string> | null = null;
let cachedHotkeyIndex: Map<string, string> | null = null;

export function getDictionary(): SpatialDictionaryEntry[] {
  if (cachedEntries) return cachedEntries;
  const root = parseYaml(yamlText as string);
  if (root.kind !== "list") {
    cachedEntries = [];
    return cachedEntries;
  }
  cachedEntries = root.items
    .map((n) => coerceEntry(n))
    .filter((e): e is SpatialDictionaryEntry => e !== null);
  return cachedEntries;
}

// synonym (lowercased) → canonical_name. O(1) lookup for dispatch.
export function getAliasIndex(): Map<string, string> {
  if (cachedAliasIndex) return cachedAliasIndex;
  const map = new Map<string, string>();
  for (const e of getDictionary()) {
    map.set(e.canonical_name.toLowerCase(), e.canonical_name);
    map.set(e.kernel_op.toLowerCase(), e.canonical_name);
    if (e.ifc4_class) map.set(e.ifc4_class.toLowerCase(), e.canonical_name);
    for (const s of e.synonyms) map.set(s.toLowerCase(), e.canonical_name);
  }
  cachedAliasIndex = map;
  return map;
}

// hotkey → canonical_name.
export function getHotkeyIndex(): Map<string, string> {
  if (cachedHotkeyIndex) return cachedHotkeyIndex;
  const map = new Map<string, string>();
  for (const e of getDictionary()) {
    if (e.hotkey) map.set(e.hotkey.toUpperCase(), e.canonical_name);
  }
  cachedHotkeyIndex = map;
  return map;
}

// Resolve any user-typed string to a canonical_name, or null.
export function resolveAlias(input: string): string | null {
  return getAliasIndex().get(input.trim().toLowerCase()) ?? null;
}

// Get the full dictionary entry by canonical_name.
export function getEntry(canonical_name: string): SpatialDictionaryEntry | null {
  for (const e of getDictionary()) {
    if (e.canonical_name === canonical_name) return e;
  }
  return null;
}

// Reset internal caches — useful for tests after `aliases.json` overrides.
export function clearDictionaryCache(): void {
  cachedEntries = null;
  cachedAliasIndex = null;
  cachedHotkeyIndex = null;
}
