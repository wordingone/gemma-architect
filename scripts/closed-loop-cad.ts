// Closed-loop tool-chain CAD harness — runs base Gemma 4 (no LoRA) at
// http://127.0.0.1:8083/v1 against a CAD prompt with iterative tool calls.
//
// Usage:
//   bun scripts/closed-loop-cad.ts [--prompt-file PATH] [--out OUT_DIR]
//
// Default prompt: data/schultz-target.jsonl (the user message only).
// Default out: outputs/closed-loop-schultz/{run-<ts>}/
//   - log.jsonl: every tool call + result, in order
//   - messages.json: full chat history
//   - mesh.json: final solid's mesh stats (if submit() was called)
//   - summary.json: aggregate stats vs gold (composition counts, bbox)
//
// Compare against single-shot LoRA results:
//   - 4b-it: 12/14 consts, has_extrude+fuse, has_cut=False
//   - e2b-it: 6/14 consts, has_extrude=False (broken)

import { setOC } from "replicad";
import * as tier1 from "../src/tools/tier1.js";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const ENDPOINT = "http://127.0.0.1:8083/v1/chat/completions";
const MAX_ITERATIONS = 50;     // hard cap on assistant turns
const MAX_TOOL_CALLS = 200;    // hard cap on total tool calls
const PROMPT_FILE = process.argv.includes("--prompt-file")
  ? process.argv[process.argv.indexOf("--prompt-file") + 1]
  : "data/schultz-target.jsonl";
const RUN_TS = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
const OUT_DIR = (process.argv.includes("--out")
  ? process.argv[process.argv.indexOf("--out") + 1]
  : `outputs/closed-loop-schultz/run-${RUN_TS}`);
mkdirSync(OUT_DIR, { recursive: true });

// ─── OpenCascade ─────────────────────────────────────────────────────────
let _ocReady: Promise<void> | null = null;
async function ensureOC() {
  if (_ocReady) return _ocReady;
  _ocReady = (async () => {
    const ocModule: any = await import("replicad-opencascadejs/src/replicad_single.js");
    const init = ocModule.default ?? ocModule;
    const oc = await init();
    setOC(oc);
  })();
  return _ocReady;
}

// ─── State ────────────────────────────────────────────────────────────────
const solids = new Map<string, any>();
const drawings = new Map<string, any>();
const sketches = new Map<string, any>();
let final: any = null;

function getSolid(name: string): any | { error: string } {
  const s = solids.get(name);
  if (!s) return { error: `unknown solid: '${name}' (known: [${[...solids.keys()].join(", ")}])` };
  return s;
}

function bboxOf(solid: any): any {
  try {
    const bb = solid.boundingBox;
    // Replicad BoundingBox API: `bounds` is `[[minX, minY, minZ], [maxX, maxY, maxZ]]`,
    // `center` is `[cx, cy, cz]`, plus scalar `width / height / depth`.
    const [min, max] = bb.bounds;
    const round = (n: number) => Math.round(n * 10000) / 10000; // 4 decimals to keep model output compact
    return {
      min: min.map(round),
      max: max.map(round),
      center: bb.center.map(round),
      size: [round(bb.width), round(bb.height), round(bb.depth)],
    };
  } catch (e: any) {
    return { error: e.message };
  }
}

// ─── Tool dispatch ────────────────────────────────────────────────────────
function executeTool(name: string, args: any): any {
  try {
    switch (name) {
      case "make_box": {
        const s = tier1.makeBox(args.width, args.depth, args.height);
        solids.set(args.name, s);
        return { ok: true, name: args.name, bbox: bboxOf(s) };
      }
      case "make_cylinder": {
        const s = tier1.makeCylinder(args.radius, args.height);
        solids.set(args.name, s);
        return { ok: true, name: args.name, bbox: bboxOf(s) };
      }
      case "draw_rectangle": {
        const d = tier1.drawRectangle(args.width, args.depth);
        drawings.set(args.name, d);
        return { ok: true, name: args.name, kind: "drawing" };
      }
      case "draw_circle": {
        const d = tier1.drawCircle(args.radius);
        drawings.set(args.name, d);
        return { ok: true, name: args.name, kind: "drawing" };
      }
      case "sketch_on_plane": {
        const d = drawings.get(args.drawing);
        if (!d) return { error: `unknown drawing: '${args.drawing}'` };
        const s = d.sketchOnPlane(args.plane ?? "XY");
        sketches.set(args.name, s);
        return { ok: true, name: args.name, kind: "sketch", plane: args.plane ?? "XY" };
      }
      case "extrude": {
        const sk = sketches.get(args.sketch);
        if (!sk) return { error: `unknown sketch: '${args.sketch}'` };
        const sol = sk.extrude(args.height);
        solids.set(args.name, sol);
        return { ok: true, name: args.name, bbox: bboxOf(sol) };
      }
      case "extrude_drawing": {
        // Convenience: drawing → sketch on XY → extrude, all in one.
        const d = drawings.get(args.drawing);
        if (!d) return { error: `unknown drawing: '${args.drawing}'` };
        const sol = d.sketchOnPlane(args.plane ?? "XY").extrude(args.height);
        solids.set(args.name, sol);
        return { ok: true, name: args.name, bbox: bboxOf(sol) };
      }
      case "fuse": {
        const a = getSolid(args.a);
        const b = getSolid(args.b);
        if ("error" in a) return a;
        if ("error" in b) return b;
        const sol = a.fuse(b);
        solids.set(args.name, sol);
        solids.delete(args.a);
        solids.delete(args.b);
        return { ok: true, name: args.name, bbox: bboxOf(sol), consumed: [args.a, args.b] };
      }
      case "cut": {
        const a = getSolid(args.a);
        const b = getSolid(args.b);
        if ("error" in a) return a;
        if ("error" in b) return b;
        const sol = a.cut(b);
        solids.set(args.name, sol);
        solids.delete(args.a);
        solids.delete(args.b);
        return { ok: true, name: args.name, bbox: bboxOf(sol), consumed: [args.a, args.b] };
      }
      case "translate": {
        const s = getSolid(args.name);
        if ("error" in s) return s;
        const moved = s.translate([args.x, args.y, args.z]);
        solids.set(args.name, moved);
        return { ok: true, name: args.name, bbox: bboxOf(moved) };
      }
      case "rotate": {
        const s = getSolid(args.name);
        if ("error" in s) return s;
        const moved = s.rotate(args.angle_deg, args.axis ?? [0, 0, 1], args.origin ?? [0, 0, 0]);
        solids.set(args.name, moved);
        return { ok: true, name: args.name, bbox: bboxOf(moved) };
      }
      case "inspect": {
        const s = getSolid(args.name);
        if ("error" in s) return s;
        return { ok: true, name: args.name, bbox: bboxOf(s) };
      }
      case "list_solids": {
        return {
          ok: true,
          solids: [...solids.entries()].map(([n, s]) => ({ name: n, bbox: bboxOf(s) })),
          drawings: [...drawings.keys()],
          sketches: [...sketches.keys()],
        };
      }
      case "submit": {
        const s = getSolid(args.name);
        if ("error" in s) return s;
        final = s;
        return { ok: true, name: args.name, message: "Final solid submitted. Loop will terminate." };
      }
      default:
        return { error: `unknown tool: '${name}'` };
    }
  } catch (e: any) {
    return { error: `runtime: ${e.message}` };
  }
}

// ─── Tool schemas (OpenAI tool format) ────────────────────────────────────
const TOOLS = [
  {
    type: "function",
    function: {
      name: "make_box",
      description: "Make an axis-aligned box solid centered at origin, dimension form.",
      parameters: {
        type: "object",
        properties: {
          width: { type: "number", description: "X extent" },
          depth: { type: "number", description: "Y extent" },
          height: { type: "number", description: "Z extent" },
          name: { type: "string", description: "Name to bind the resulting solid to (used in later tool calls)" },
        },
        required: ["width", "depth", "height", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "make_cylinder",
      description: "Make a vertical cylinder along Z, base at z=0.",
      parameters: {
        type: "object",
        properties: {
          radius: { type: "number" },
          height: { type: "number" },
          name: { type: "string" },
        },
        required: ["radius", "height", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draw_rectangle",
      description: "Make a 2D rectangle drawing centered at origin (intermediate; use extrude_drawing to turn into solid).",
      parameters: {
        type: "object",
        properties: {
          width: { type: "number" },
          depth: { type: "number" },
          name: { type: "string" },
        },
        required: ["width", "depth", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "draw_circle",
      description: "Make a 2D circle drawing centered at origin.",
      parameters: {
        type: "object",
        properties: {
          radius: { type: "number" },
          name: { type: "string" },
        },
        required: ["radius", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "extrude_drawing",
      description: "Convenience: take a 2D drawing, place it on a plane, extrude into a solid in one step.",
      parameters: {
        type: "object",
        properties: {
          drawing: { type: "string", description: "Name of a previously-made drawing" },
          height: { type: "number", description: "Extrusion distance along the plane normal" },
          plane: { type: "string", enum: ["XY", "XZ", "YZ"], description: "Plane to sketch on. Default XY (extrude along Z)." },
          name: { type: "string", description: "Name to bind the resulting solid to" },
        },
        required: ["drawing", "height", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "fuse",
      description: "Boolean union: a + b. Consumes both a and b (their names become invalid after).",
      parameters: {
        type: "object",
        properties: {
          a: { type: "string" },
          b: { type: "string" },
          name: { type: "string" },
        },
        required: ["a", "b", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "cut",
      description: "Boolean difference: a - b (cuts b out of a). Use to make openings (door, window) by cutting a small box out of a wall. Consumes both a and b.",
      parameters: {
        type: "object",
        properties: {
          a: { type: "string", description: "Solid to cut from (e.g. wall)" },
          b: { type: "string", description: "Solid to cut out (e.g. doorway)" },
          name: { type: "string", description: "Name of the result" },
        },
        required: ["a", "b", "name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "translate",
      description: "Translate an existing solid in place by (x, y, z). Updates the solid's position; name unchanged.",
      parameters: {
        type: "object",
        properties: {
          name: { type: "string" },
          x: { type: "number" },
          y: { type: "number" },
          z: { type: "number" },
        },
        required: ["name", "x", "y", "z"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "inspect",
      description: "Return the bounding box of a named solid for verification.",
      parameters: {
        type: "object",
        properties: { name: { type: "string" } },
        required: ["name"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_solids",
      description: "List all currently-known solids, drawings, and sketches.",
      parameters: { type: "object", properties: {}, required: [] },
    },
  },
  {
    type: "function",
    function: {
      name: "submit",
      description: "Finalize a named solid as the final building. Call this when construction is complete. The loop will terminate.",
      parameters: {
        type: "object",
        properties: { name: { type: "string", description: "Name of the final assembled solid" } },
        required: ["name"],
      },
    },
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────
async function main() {
  await ensureOC();
  console.log("OpenCascade ready.");

  const row = JSON.parse(readFileSync(PROMPT_FILE, "utf8").trim());
  const userMsg = row.messages.find((m: any) => m.role === "user");
  const goldMsg = row.messages.find((m: any) => m.role === "assistant");
  console.log(`Prompt: ${userMsg.content.slice(0, 100)}...`);

  const SYSTEM = [
    "You build 3D buildings via tool calls. Each turn = exactly ONE tool call.",
    "Reasoning should be terse — name the next tool + args; don't deliberate over alternatives.",
    "Stages: (1) make_box for floor, (2) make_box for each wall (translate to position after), (3) make_box for partition + columns, (4) for door/window: make wall, make smaller opening box at the right position, cut to subtract, (5) fuse everything into one solid, (6) submit.",
    "Convention: make_box is centered at origin; translate AFTER to position. For a 40-foot-long, 8-inch-thick, 9-foot-tall wall at the south edge of a 26-foot-deep floor, translate by (0, -3.9, 1.5) to put it at y=-3.9 with center z at 1.5 (base above the 8-inch floor slab).",
    "When in doubt: just make the next part. The bbox feedback in the tool result tells you if it's correct.",
  ].join(" ");

  const messages: any[] = [
    { role: "system", content: SYSTEM },
    { role: "user", content: userMsg.content },
  ];

  const log: any[] = [];
  let totalToolCalls = 0;
  let iter = 0;

  while (iter < MAX_ITERATIONS) {
    iter++;
    console.log(`\n=== iteration ${iter} ===`);

    let resp;
    try {
      const r = await fetch(ENDPOINT, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          messages,
          tools: TOOLS,
          // Force a tool call every turn — Gemma 4 is verbose in its thought
          // mode and burns context deliberating rather than acting. "required" makes
          // the grammar engine emit a tool call. Loop terminates on submit().
          tool_choice: "required",
          temperature: 0.5,           // higher temp breaks indecision loops
          max_tokens: 2048,
          // llama-server-specific: DRY (Don't Repeat Yourself) penalizes the
          // "Wait, I'll just make the east wall." x10 indecision loop Gemma 4
          // falls into on multi-step tool problems. Verbose reasoning is fine;
          // verbatim self-repetition is what breaks the chain.
          dry_multiplier: 0.8,
          dry_base: 1.75,
          dry_allowed_length: 2,
          dry_penalty_last_n: 1024,
        }),
      });
      resp = await r.json();
    } catch (e: any) {
      console.log(`fetch error: ${e.message}`);
      break;
    }

    const choice = resp.choices?.[0];
    if (!choice) {
      console.log("no choice in response — aborting");
      break;
    }
    const msg = choice.message;
    // Strip the model's reasoning tokens from the saved history. Gemma 4's
    // <|channel>thought blocks are huge (~500 tokens each) and cumulative reasoning
    // bloat is what causes the iter-3 stall. Keep only the tool call envelope.
    messages.push({ role: "assistant", content: null, tool_calls: msg.tool_calls });

    if (msg.content) console.log(`assistant content: ${String(msg.content).slice(0, 80)}... [${String(msg.content).length} chars stripped]`);
    console.log(`finish_reason: ${choice.finish_reason}, tool_calls: ${msg.tool_calls?.length ?? 0}, usage: prompt=${resp.usage?.prompt_tokens} completion=${resp.usage?.completion_tokens}`);

    if (!msg.tool_calls || msg.tool_calls.length === 0) {
      console.log("no tool calls — model decided to stop.");
      break;
    }

    let submitted = false;
    for (const call of msg.tool_calls) {
      totalToolCalls++;
      const args = JSON.parse(call.function.arguments);
      const result = executeTool(call.function.name, args);
      log.push({ iter, call: call.function.name, args, result });
      console.log(`  ${call.function.name}(${Object.keys(args).join(",")}) → ${result.error ? `ERROR: ${result.error}` : "ok"}`);

      messages.push({
        role: "tool",
        tool_call_id: call.id,
        content: JSON.stringify(result),
      });

      if (call.function.name === "submit" && result.ok) {
        submitted = true;
      }
      if (totalToolCalls >= MAX_TOOL_CALLS) {
        console.log(`tool call cap (${MAX_TOOL_CALLS}) — aborting`);
        break;
      }
    }
    if (submitted) {
      console.log("submit() called — loop terminating cleanly.");
      break;
    }
    if (totalToolCalls >= MAX_TOOL_CALLS) break;
  }

  // ─── Persist ──────────────────────────────────────────────────────────
  writeFileSync(join(OUT_DIR, "log.jsonl"), log.map(l => JSON.stringify(l)).join("\n") + "\n", "utf8");
  writeFileSync(join(OUT_DIR, "messages.json"), JSON.stringify(messages, null, 2), "utf8");

  let summary: any = {
    prompt_file: PROMPT_FILE,
    iterations: iter,
    total_tool_calls: totalToolCalls,
    submitted: final !== null,
    error_count: log.filter(l => l.result.error).length,
    tool_count_by_name: log.reduce((acc, l) => {
      acc[l.call] = (acc[l.call] || 0) + 1;
      return acc;
    }, {} as Record<string, number>),
  };

  if (final) {
    try {
      const m = final.mesh({ tolerance: 0.05, angularTolerance: 0.3 });
      const bbox = bboxOf(final);
      summary.mesh = {
        n_triangles: (m.triangles as any).length / 3,
        n_vertices: (m.vertices as any).length / 3,
        bbox,
      };
      writeFileSync(join(OUT_DIR, "mesh.json"), JSON.stringify(summary.mesh, null, 2), "utf8");
      console.log(`\nFINAL: ${summary.mesh.n_triangles} triangles, bbox size = ${bbox.size}`);
    } catch (e: any) {
      summary.mesh_error = e.message;
      console.log(`mesh error: ${e.message}`);
    }
  }

  // composition counts
  const cuts = log.filter(l => l.call === "cut" && l.result.ok).length;
  const fuses = log.filter(l => l.call === "fuse" && l.result.ok).length;
  const extrudes = log.filter(l => (l.call === "extrude" || l.call === "extrude_drawing") && l.result.ok).length;
  summary.composition = { cuts, fuses, extrudes };

  writeFileSync(join(OUT_DIR, "summary.json"), JSON.stringify(summary, null, 2), "utf8");

  console.log(`\n══ SUMMARY ══`);
  console.log(`iterations: ${iter}`);
  console.log(`tool calls: ${totalToolCalls} (${summary.error_count} errors)`);
  console.log(`composition: ${cuts} cuts, ${fuses} fuses, ${extrudes} extrudes`);
  console.log(`submitted: ${summary.submitted}`);
  console.log(`out: ${OUT_DIR}`);
}

main().catch((e) => {
  console.error("fatal:", e);
  process.exit(1);
});
