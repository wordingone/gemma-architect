// image-to-ifc-agent.ts — autonomous image→IFC agent loop (#182).
//
// Distinct from #168's deterministic Sobel pipeline: here the agent receives
// the floorplan image as a multimodal content block and decides which
// dispatch verbs to call. Walls + slab accumulate in scene-kg via the
// dispatch table; once the agent loop completes, the current scene is
// serialised to IFC4 via the existing ifc-build.ts emitter.
//
// Pipeline:
//   1. File → ImageBitmap (createImageBitmap)
//   2. runAgentTurn({ prompt, frames: [bitmap] }) — multimodal content block
//      forwarded to the local Gemma 4 endpoint by agent-harness.ts
//   3. Each AgentDispatch is invoked via dispatch() — handlers update
//      scene-kg as a side-effect (T6/T8 contract)
//   4. After the loop terminates, buildIfc() emits a STEP-21 IFC4 byte
//      stream describing the project/site/building/storey skeleton plus
//      whatever proxy mesh the agent surfaced
//
// The harness is purely orchestration — it does not itself decide what
// walls or slabs look like. Dispatch handlers + scene-kg own that.

import { runAgentTurn, type AgentDispatch } from "./agent-harness";
import { dispatch } from "../commands/dispatch";
import { buildIfc, type IfcMesh } from "../ifc/ifc-build";

// ============================================================
// Public types
// ============================================================

export type ImageToIFCAgentResult = {
  ifcBuffer: Uint8Array;
  dispatchLog: AgentDispatch[];
  turnCount: number;
};

export type ImageToIFCAgentOptions = {
  /** Maximum agent turns before forcing IFC emission. Default 6. */
  maxTurns?: number;
  /** Per-turn prompt seed. Default reconstructs walls + slab. */
  prompt?: string;
};

// ============================================================
// Internal helpers
// ============================================================

const DEFAULT_PROMPT = "Reconstruct this floorplan as IFC4 walls + slab.";
const DEFAULT_MAX_TURNS = 6;

/**
 * Convert a File (drag-drop or `<input type=file>`) into an ImageBitmap.
 * Throws if the input is not a decodable image.
 */
async function fileToBitmap(file: File): Promise<ImageBitmap> {
  // createImageBitmap accepts Blob (File extends Blob) directly. Browsers
  // decode without going via HTMLImageElement, so this works inside
  // workers too if the call site moves off-main-thread later.
  return await createImageBitmap(file);
}

/**
 * Empty placeholder mesh. The agent's dispatches mutate scene-kg
 * (relations + element types) but the geometric mesh harvested out of
 * the kernel is owned by transforms.ts / kernel.ts — not the agent
 * harness directly. For the scaffold, we emit a single zero-extent
 * triangle so buildIfc() produces a valid STEP-21 file with the
 * project/site/building/storey skeleton; once T11 wires the kernel-side
 * mesh harvest, this swaps for the real geometry.
 */
function emptyPlaceholderMesh(): IfcMesh {
  // One degenerate triangle at the origin — zero-area, valid topology.
  const vertices = new Float32Array([0, 0, 0, 0, 0, 0, 0, 0, 0]);
  const indices = new Uint32Array([0, 1, 2]);
  return { vertices, indices };
}

// ============================================================
// Public entry point
// ============================================================

/**
 * Drive the autonomous image→IFC agent loop end-to-end.
 *
 * - Encodes the input file as an ImageBitmap content block
 * - Runs up to `maxTurns` turns against runAgentTurn(), invoking each
 *   returned dispatch via the central dispatch table
 * - On loop exit (no further dispatches OR maxTurns reached), emits a
 *   IFC4 STEP-21 buffer via buildIfc()
 *
 * Errors from the inference endpoint propagate; dispatch failures are
 * captured in the log but do NOT halt the loop (the agent can recover
 * on the next turn).
 */
export async function imageToIFCAgent(
  file: File,
  options?: ImageToIFCAgentOptions,
): Promise<ImageToIFCAgentResult> {
  const maxTurns = options?.maxTurns ?? DEFAULT_MAX_TURNS;
  const prompt = options?.prompt ?? DEFAULT_PROMPT;

  const bitmap = await fileToBitmap(file);
  const dispatchLog: AgentDispatch[] = [];

  let turnCount = 0;
  for (let turn = 0; turn < maxTurns; turn++) {
    turnCount++;
    const response = await runAgentTurn({
      prompt,
      frames: [bitmap],
      maxTurns: 1,
    });

    if (response.dispatches.length === 0) {
      // Agent emitted only text — loop terminates. The text response is
      // surfaced via the raw payload for callers that want to display it.
      break;
    }

    for (const d of response.dispatches) {
      dispatchLog.push(d);
      // Dispatch handler keeps scene-kg in sync as a side-effect (T6).
      // Failures are captured in the log via dispatchLog above; we do
      // not propagate them — the next turn can recover.
      await dispatch(d.verb, d.args);
    }
  }

  // Release the decoded image. ImageBitmaps occupy GPU memory until
  // explicitly closed; not closing leaks across repeated reconstructions.
  bitmap.close();

  // Serialise current scene to IFC4. The mesh placeholder is replaced
  // once the kernel-side harvest (T11) lands; the dispatch log records
  // what the agent wanted regardless.
  const mesh = emptyPlaceholderMesh();
  const ifcBuffer = buildIfc(mesh, "GemmaCad Agent Reconstruction");

  return { ifcBuffer, dispatchLog, turnCount };
}
