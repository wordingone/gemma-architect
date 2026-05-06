// gemma-architect Console DSL — minimal evaluator.
//
// Parses the v0 lexicon (`docs/console-dsl.md`) and lowers it to the
// existing replicad surface (`drawRectangle / drawCircle / sketchOnPlane /
// extrude / fuse / cut / translate`) that the worker already executes.
// Spatial-dictionary verbs that are not geometry primitives are accepted and
// routed to the dispatch table at eval time (see compileDsl unknown-verb path).
//
// Scope of this stub:
//   - architectural verbs: `wall`, `slab`, `column`
//   - bindings: `let name = <expr>`
//   - comments: `# ...`
//   - units: meters (the only mode v0 supports)
//
// Out of scope (deferred to a follow-up — the lexicon spec covers the full
// surface):
//   - `door / window / opening` — these need host-wall geometry mutation
//     (boolean cut against a named wall solid). Punted to v1.
//   - `revolve / loft / sweep / pipe / fillet / chamfer / shell / mirror /
//     array / find / bbox / area / volume` — likewise v1.
//   - `polyline-footprint slabs` are accepted but only when rectangular
//     (axis-aligned 4-corner). Curved or N>4-vertex footprints emit a
//     compile error rather than approximating silently.
//
// Verb cheat sheet (v0):
//   wall   (x0 y0) (x1 y1) height=H thickness=T   — vertical wall solid
//   slab   [(x y) ...] thickness=T offset=Z       — polyline-footprint slab
//   column (x y) height=H profile=square(S)|circle(R)
//   box    (cx cy) width=W depth=D height=H [offset=Z]   — axis-aligned solid
//   cut    a b                                    — boolean diff, consumes a+b
//
// box vs slab: same lowering (drawRectangle.extrude.translate) but different
// syntax. slab is polyline-first (designed for floor/roof footprints from
// polylines); box is center+dims-first (cleaner for stair-step / parametric
// solids where dims are the natural parameters).

import { getEntry, resolveAlias } from "./dictionary";

export type Vec2 = [number, number];

export type DslDispatch = { verb: string; args: Record<string, unknown> };

export type CompileResult =
  | { ok: true; js: string; solids: string[]; dispatches?: DslDispatch[] }
  | { ok: false; line: number; message: string };

interface Wall {
  kind: "wall";
  from: Vec2;
  to: Vec2;
  height: number;
  thickness: number;
}
interface Slab {
  kind: "slab";
  width: number;
  depth: number;
  cx: number;
  cy: number;
  thickness: number;
  offset: number;
}
interface Column {
  kind: "column";
  at: Vec2;
  height: number;
  profile: { kind: "square" | "circle"; size: number };
}
interface Cut {
  kind: "cut";
  a: string;
  b: string;
}
interface Box {
  kind: "box";
  cx: number;
  cy: number;
  width: number;
  depth: number;
  height: number;
  offset: number;
}
interface Line {
  kind: "line";
  from: Vec2;
  to: Vec2;
}
interface Circle {
  kind: "circle";
  at: Vec2;
  radius: number;
}
interface Rect {
  kind: "rect";
  cx: number;
  cy: number;
  width: number;
  depth: number;
}
interface Point {
  kind: "point";
  at: Vec2;
}

type Stmt = (Wall | Slab | Column | Cut | Box | Line | Circle | Rect | Point) & { binding: string };

const NUM = /-?\d+(?:\.\d+)?(?:e-?\d+)?/;

function parseNumber(tok: string): number | null {
  const m = tok.match(/^(-?\d+(?:\.\d+)?(?:e-?\d+)?)(mm|cm|m)?$/i);
  if (!m) return null;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return null;
  const unit = (m[2] || "m").toLowerCase();
  if (unit === "mm") return n / 1000;
  if (unit === "cm") return n / 100;
  return n;
}

function parseTuple(s: string): number[] | null {
  // (1 2) or (1, 2, 3) — whitespace OR commas, leading/trailing parens
  const inner = s.trim().replace(/^\(/, "").replace(/\)$/, "");
  const toks = inner.split(/[,\s]+/).filter(Boolean);
  const out: number[] = [];
  for (const t of toks) {
    const n = parseNumber(t);
    if (n === null) return null;
    out.push(n);
  }
  return out;
}

// Split a line into top-level tokens, respecting (...) and [...] groups.
function tokenize(line: string): string[] {
  const out: string[] = [];
  let i = 0;
  let buf = "";
  let depth = 0;
  while (i < line.length) {
    const c = line[i];
    if (c === "(" || c === "[") {
      depth++;
      buf += c;
    } else if (c === ")" || c === "]") {
      depth--;
      buf += c;
    } else if (/\s/.test(c) && depth === 0) {
      if (buf) { out.push(buf); buf = ""; }
    } else {
      buf += c;
    }
    i++;
  }
  if (buf) out.push(buf);
  return out;
}

interface NamedArg { name: string; value: string }

function splitNamed(toks: string[]): { positional: string[]; named: NamedArg[] } {
  const positional: string[] = [];
  const named: NamedArg[] = [];
  for (const t of toks) {
    const eq = t.indexOf("=");
    if (eq > 0 && /^[a-z][\w-]*$/.test(t.slice(0, eq))) {
      named.push({ name: t.slice(0, eq), value: t.slice(eq + 1) });
    } else {
      positional.push(t);
    }
  }
  return { positional, named };
}

function getNamed(named: NamedArg[], key: string): string | null {
  const a = named.find((x) => x.name === key);
  return a ? a.value : null;
}

function parseProfile(s: string): { kind: "square" | "circle"; size: number } | null {
  // square(0.4) or circle(0.3)
  const m = s.match(/^(square|circle)\(([^)]+)\)$/i);
  if (!m) return null;
  const size = parseNumber(m[2]);
  if (size === null) return null;
  return { kind: m[1].toLowerCase() as "square" | "circle", size };
}

// Derive an axis-aligned rectangular slab from a polyline footprint.
// Accepts only [(x0 y0) (x1 y0) (x1 y1) (x0 y1) (x0 y0)] (rectangular,
// closed) for now. Other footprints return null.
function parseRectFootprint(s: string): { width: number; depth: number; cx: number; cy: number } | null {
  // Inner: [(0 0) (6 0) (6 4) (0 4) (0 0)]
  const m = s.trim().match(/^\[(.*)\]$/s);
  if (!m) return null;
  const inner = m[1];
  // split into ( ... ) groups
  const groups = inner.match(/\([^)]*\)/g);
  if (!groups || groups.length < 4) return null;
  const points: Vec2[] = [];
  for (const g of groups) {
    const pair = parseTuple(g);
    if (!pair || pair.length !== 2) return null;
    points.push([pair[0], pair[1]]);
  }
  // Drop trailing closing point if equal to first
  if (
    points.length >= 5 &&
    points[0][0] === points[points.length - 1][0] &&
    points[0][1] === points[points.length - 1][1]
  ) {
    points.pop();
  }
  if (points.length !== 4) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  const xmin = Math.min(...xs), xmax = Math.max(...xs);
  const ymin = Math.min(...ys), ymax = Math.max(...ys);
  // Confirm axis-aligned: every point must be at (xmin|xmax, ymin|ymax)
  for (const p of points) {
    const xOk = p[0] === xmin || p[0] === xmax;
    const yOk = p[1] === ymin || p[1] === ymax;
    if (!xOk || !yOk) return null;
  }
  return { width: xmax - xmin, depth: ymax - ymin, cx: (xmin + xmax) / 2, cy: (ymin + ymax) / 2 };
}

function emitWall(s: Wall, name: string): string {
  const dx = s.to[0] - s.from[0];
  const dy = s.to[1] - s.from[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  const cx = (s.from[0] + s.to[0]) / 2;
  const cy = (s.from[1] + s.to[1]) / 2;
  const ang = Math.atan2(dy, dx);
  // Wall: rectangle of (length × thickness) extruded h, rotated to wall axis,
  // translated to midpoint. Z=0 base.
  // Replicad Solid.rotate signature is (angle, position, direction). Earlier
  // arg order passed direction first, position second — silently returned
  // undefined and broke .translate downstream. 4/8 corpus rows (every wall-
  // based one: wall, wall-with-door, l-walls, four-walled-room) failed before
  // this fix. Regression caught by scripts/verify-dsl-corpus.ts.
  return [
    `const ${name} = drawRectangle(${len.toFixed(4)}, ${s.thickness.toFixed(4)})`,
    `  .sketchOnPlane("XY")`,
    `  .extrude(${s.height.toFixed(4)})`,
    `  .rotate(${((ang * 180) / Math.PI).toFixed(4)}, [0,0,0], [0,0,1])`,
    `  .translate([${cx.toFixed(4)}, ${cy.toFixed(4)}, 0]);`,
  ].join("\n");
}

function emitSlab(s: Slab, name: string): string {
  return [
    `const ${name} = drawRectangle(${s.width.toFixed(4)}, ${s.depth.toFixed(4)})`,
    `  .sketchOnPlane("XY")`,
    `  .extrude(${s.thickness.toFixed(4)})`,
    `  .translate([${s.cx.toFixed(4)}, ${s.cy.toFixed(4)}, ${s.offset.toFixed(4)}]);`,
  ].join("\n");
}

function emitBox(s: Box, name: string): string {
  return [
    `const ${name} = drawRectangle(${s.width.toFixed(4)}, ${s.depth.toFixed(4)})`,
    `  .sketchOnPlane("XY")`,
    `  .extrude(${s.height.toFixed(4)})`,
    `  .translate([${s.cx.toFixed(4)}, ${s.cy.toFixed(4)}, ${s.offset.toFixed(4)}]);`,
  ].join("\n");
}

function emitColumn(s: Column, name: string): string {
  if (s.profile.kind === "circle") {
    return [
      `const ${name} = drawCircle(${s.profile.size.toFixed(4)})`,
      `  .sketchOnPlane("XY")`,
      `  .extrude(${s.height.toFixed(4)})`,
      `  .translate([${s.at[0].toFixed(4)}, ${s.at[1].toFixed(4)}, 0]);`,
    ].join("\n");
  }
  // Square column → drawRectangle(size, size)
  return [
    `const ${name} = drawRectangle(${s.profile.size.toFixed(4)}, ${s.profile.size.toFixed(4)})`,
    `  .sketchOnPlane("XY")`,
    `  .extrude(${s.height.toFixed(4)})`,
    `  .translate([${s.at[0].toFixed(4)}, ${s.at[1].toFixed(4)}, 0]);`,
  ].join("\n");
}

function emitLine(s: Line, name: string): string {
  const dx = s.to[0] - s.from[0];
  const dy = s.to[1] - s.from[1];
  const len = Math.sqrt(dx * dx + dy * dy);
  const cx = (s.from[0] + s.to[0]) / 2;
  const cy = (s.from[1] + s.to[1]) / 2;
  const ang = ((Math.atan2(dy, dx) * 180) / Math.PI).toFixed(4);
  return `const ${name} = makeBox(${len.toFixed(4)}, 0.02, 0.002).rotate(${ang}, [0,0,0], [0,0,1]).translate([${cx.toFixed(4)}, ${cy.toFixed(4)}, 0]);`;
}

function emitCircle(s: Circle, name: string): string {
  return `const ${name} = makeCylinder(${s.radius.toFixed(4)}, 0.002).translate([${s.at[0].toFixed(4)}, ${s.at[1].toFixed(4)}, 0]);`;
}

function emitRect(s: Rect, name: string): string {
  return [
    `const ${name} = drawRectangle(${s.width.toFixed(4)}, ${s.depth.toFixed(4)})`,
    `  .sketchOnPlane("XY")`,
    `  .extrude(0.002)`,
    `  .translate([${s.cx.toFixed(4)}, ${s.cy.toFixed(4)}, 0]);`,
  ].join("\n");
}

function emitPoint(s: Point, name: string): string {
  return `const ${name} = makeCylinder(0.05, 0.05).translate([${s.at[0].toFixed(4)}, ${s.at[1].toFixed(4)}, 0]);`;
}

export function compileDsl(source: string): CompileResult {
  const lines = source.split(/\r?\n/);
  const stmts: Stmt[] = [];
  const spatialDispatches: DslDispatch[] = [];
  let anonCounter = 0;
  for (let i = 0; i < lines.length; i++) {
    const raw = lines[i];
    // Strip comments + trim
    const hashAt = raw.indexOf("#");
    const trimmed = (hashAt >= 0 ? raw.slice(0, hashAt) : raw).trim();
    if (!trimmed) continue;
    // Optional `let name = ...` binding
    let body = trimmed;
    let binding: string | null = null;
    const letMatch = trimmed.match(/^let\s+([a-z][\w-]*)\s*=\s*(.*)$/i);
    if (letMatch) {
      binding = letMatch[1].replace(/-/g, "_");
      body = letMatch[2];
    }
    const toks = tokenize(body);
    if (toks.length === 0) continue;
    const verb = toks[0].toLowerCase();
    const rest = toks.slice(1);
    const { positional, named } = splitNamed(rest);

    const name = binding ?? `e${anonCounter++}`;

    if (verb === "wall") {
      // wall (x0 y0) (x1 y1) height=H thickness=T
      if (positional.length < 2) {
        return { ok: false, line: i + 1, message: `wall: expected 2 endpoints, got ${positional.length}` };
      }
      const from = parseTuple(positional[0]);
      const to = parseTuple(positional[1]);
      if (!from || from.length !== 2 || !to || to.length !== 2) {
        return { ok: false, line: i + 1, message: `wall: endpoints must be (x y)` };
      }
      const hStr = getNamed(named, "height");
      const tStr = getNamed(named, "thickness");
      if (!hStr || !tStr) {
        return { ok: false, line: i + 1, message: `wall: requires height= and thickness=` };
      }
      const height = parseNumber(hStr);
      const thickness = parseNumber(tStr);
      if (height === null || thickness === null) {
        return { ok: false, line: i + 1, message: `wall: height/thickness not a number` };
      }
      stmts.push({ kind: "wall", from: [from[0], from[1]], to: [to[0], to[1]], height, thickness, binding: name });
      continue;
    }

    if (verb === "slab") {
      // slab [(...)] thickness=T offset=O
      if (positional.length < 1) {
        return { ok: false, line: i + 1, message: `slab: expected footprint polyline` };
      }
      const rect = parseRectFootprint(positional[0]);
      if (!rect) {
        return { ok: false, line: i + 1, message: `slab: footprint must be a closed axis-aligned 4-corner rectangle in v0` };
      }
      const tStr = getNamed(named, "thickness");
      if (!tStr) {
        return { ok: false, line: i + 1, message: `slab: requires thickness=` };
      }
      const thickness = parseNumber(tStr);
      if (thickness === null) {
        return { ok: false, line: i + 1, message: `slab: thickness not a number` };
      }
      const offsetStr = getNamed(named, "offset");
      const offset = offsetStr ? parseNumber(offsetStr) ?? 0 : 0;
      stmts.push({ kind: "slab", width: rect.width, depth: rect.depth, cx: rect.cx, cy: rect.cy, thickness, offset, binding: name });
      continue;
    }

    if (verb === "column") {
      // column (x y) height=H profile=square(S) | circle(R)
      if (positional.length < 1) {
        return { ok: false, line: i + 1, message: `column: expected position (x y)` };
      }
      const at = parseTuple(positional[0]);
      if (!at || at.length !== 2) {
        return { ok: false, line: i + 1, message: `column: position must be (x y)` };
      }
      const hStr = getNamed(named, "height");
      if (!hStr) {
        return { ok: false, line: i + 1, message: `column: requires height=` };
      }
      const height = parseNumber(hStr);
      if (height === null) {
        return { ok: false, line: i + 1, message: `column: height not a number` };
      }
      const profStr = getNamed(named, "profile") ?? "square(0.3)";
      const profile = parseProfile(profStr);
      if (!profile) {
        return { ok: false, line: i + 1, message: `column: profile must be square(N) or circle(R)` };
      }
      stmts.push({ kind: "column", at: [at[0], at[1]], height, profile, binding: name });
      continue;
    }

    if (verb === "box") {
      // box (cx cy) width=W depth=D height=H [offset=Z]
      if (positional.length < 1) {
        return { ok: false, line: i + 1, message: `box: expected center (cx cy)` };
      }
      const center = parseTuple(positional[0]);
      if (!center || center.length !== 2) {
        return { ok: false, line: i + 1, message: `box: center must be (cx cy)` };
      }
      const wStr = getNamed(named, "width");
      const dStr = getNamed(named, "depth");
      const hStr = getNamed(named, "height");
      if (!wStr || !dStr || !hStr) {
        return { ok: false, line: i + 1, message: `box: requires width=, depth=, height=` };
      }
      const width = parseNumber(wStr);
      const depth = parseNumber(dStr);
      const height = parseNumber(hStr);
      if (width === null || depth === null || height === null) {
        return { ok: false, line: i + 1, message: `box: width/depth/height not a number` };
      }
      const offsetStr = getNamed(named, "offset");
      const offset = offsetStr ? parseNumber(offsetStr) ?? 0 : 0;
      stmts.push({ kind: "box", cx: center[0], cy: center[1], width, depth, height, offset, binding: name });
      continue;
    }

    if (verb === "cut") {
      // cut <a> <b> → const result = a.cut(b);
      // Operands must be names of previously-bound solids.
      if (positional.length !== 2) {
        return { ok: false, line: i + 1, message: `cut: expected 2 operand names, got ${positional.length}` };
      }
      const aRaw = positional[0];
      const bRaw = positional[1];
      if (!/^[a-z][\w-]*$/i.test(aRaw) || !/^[a-z][\w-]*$/i.test(bRaw)) {
        return { ok: false, line: i + 1, message: `cut: operands must be identifier names (use 'let' to bind solids first)` };
      }
      const a = aRaw.replace(/-/g, "_");
      const b = bRaw.replace(/-/g, "_");
      const known = new Set(stmts.map((s) => s.binding));
      if (!known.has(a)) return { ok: false, line: i + 1, message: `cut: unknown name '${aRaw}'` };
      if (!known.has(b)) return { ok: false, line: i + 1, message: `cut: unknown name '${bRaw}'` };
      stmts.push({ kind: "cut", a, b, binding: name });
      continue;
    }

    if (verb === "line" || verb === "segment") {
      if (positional.length < 2) {
        return { ok: false, line: i + 1, message: `line: expected 2 point tuples, e.g. line (0 0) (3 3)` };
      }
      const from = parseTuple(positional[0]);
      const to = parseTuple(positional[1]);
      if (!from || from.length < 2 || !to || to.length < 2) {
        return { ok: false, line: i + 1, message: `line: invalid point syntax — use (x y)` };
      }
      stmts.push({ kind: "line", from: [from[0], from[1]], to: [to[0], to[1]], binding: name });
      continue;
    }

    if (verb === "circle") {
      const centerStr = positional[0];
      const radiusStr = getNamed(named, "radius") ?? positional[1];
      if (!centerStr || !radiusStr) {
        return { ok: false, line: i + 1, message: `circle: expected circle (cx cy) radius=R` };
      }
      const center = parseTuple(centerStr);
      const radius = parseNumber(radiusStr);
      if (!center || center.length < 2 || radius === null) {
        return { ok: false, line: i + 1, message: `circle: invalid args — use circle (cx cy) radius=R` };
      }
      stmts.push({ kind: "circle", at: [center[0], center[1]], radius, binding: name });
      continue;
    }

    if (verb === "rectangle" || verb === "rect") {
      const widthStr = getNamed(named, "width") ?? positional[0];
      const depthStr = getNamed(named, "depth") ?? getNamed(named, "height") ?? positional[1];
      if (!widthStr || !depthStr) {
        return { ok: false, line: i + 1, message: `rectangle: expected width=W depth=D [center=(cx cy)]` };
      }
      const width = parseNumber(widthStr);
      const depth = parseNumber(depthStr);
      if (width === null || depth === null) {
        return { ok: false, line: i + 1, message: `rectangle: width/depth not a number` };
      }
      const centerStr = getNamed(named, "center") ?? positional[2];
      const center = centerStr ? parseTuple(centerStr) : null;
      const cx = center ? center[0] : 0;
      const cy = center ? center[1] : 0;
      stmts.push({ kind: "rect", cx, cy, width, depth, binding: name });
      continue;
    }

    if (verb === "point" || verb === "pt" || verb === "vertex") {
      if (positional.length < 1) {
        return { ok: false, line: i + 1, message: `point: expected (x y)` };
      }
      const pt = parseTuple(positional[0]);
      if (!pt || pt.length < 2) {
        return { ok: false, line: i + 1, message: `point: invalid point syntax — use point (x y)` };
      }
      stmts.push({ kind: "point", at: [pt[0], pt[1]], binding: name });
      continue;
    }

    // Not a geometry primitive — check the spatial dictionary. If it resolves,
    // record as a dispatch (caller executes via dispatchSync) and continue.
    const canonical = getEntry(verb)?.canonical_name ?? resolveAlias(verb) ?? null;
    if (canonical) {
      const args: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(named)) args[k] = v;
      for (let pi = 0; pi < positional.length; pi++) args[`_${pi}`] = positional[pi];
      spatialDispatches.push({ verb: canonical, args });
      continue;
    }

    return { ok: false, line: i + 1, message: `unknown verb: '${verb}' (supported: wall, slab, column, box, cut + spatial-api verbs)` };
  }

  // Emit replicad. Each statement → one binding; final value is fused
  // composite of all bindings (mirrors the existing four-walled-room demo
  // pattern). If only one statement, that's the result.
  if (stmts.length === 0) {
    // Dispatch-only programs (all spatial-api verbs, no geometry) are valid.
    if (spatialDispatches.length > 0) {
      return { ok: true, js: "", solids: [], dispatches: spatialDispatches };
    }
    return { ok: false, line: 0, message: `empty program` };
  }
  const body: string[] = [];
  const names: string[] = [];
  const consumed = new Set<string>();
  for (const s of stmts) {
    if (s.kind === "wall") body.push(emitWall(s, s.binding));
    else if (s.kind === "slab") body.push(emitSlab(s, s.binding));
    else if (s.kind === "column") body.push(emitColumn(s, s.binding));
    else if (s.kind === "box") body.push(emitBox(s, s.binding));
    else if (s.kind === "line") body.push(emitLine(s, s.binding));
    else if (s.kind === "circle") body.push(emitCircle(s, s.binding));
    else if (s.kind === "rect") body.push(emitRect(s, s.binding));
    else if (s.kind === "point") body.push(emitPoint(s, s.binding));
    else if (s.kind === "cut") {
      body.push(`const ${s.binding} = ${s.a}.cut(${s.b});`);
      consumed.add(s.a);
      consumed.add(s.b);
    }
    names.push(s.binding);
  }
  // Auto-fuse only solids not consumed by a cut. The cut's result stays live.
  const live = names.filter((n) => !consumed.has(n));
  if (live.length > 1) {
    body.push(`const composite = ${live.slice(1).reduce((acc, n) => `${acc}.fuse(${n})`, live[0])};`);
  }
  return {
    ok: true,
    js: body.join("\n"),
    solids: live,
    dispatches: spatialDispatches.length > 0 ? spatialDispatches : undefined,
  };
}
