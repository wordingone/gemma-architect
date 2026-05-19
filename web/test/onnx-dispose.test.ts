// onnx-dispose.test.ts — §A (#990) ORT session lifecycle: shutdown + re-init dispose.
//
// Mirrors the dispose logic from:
//   model-worker.ts → handleShutdown()  (§A-shutdown)
//   model-worker.ts → handleInit()       (§A-init — dispose on re-init)

import { describe, expect, test } from "bun:test";

// ── Mock ORT session ──────────────────────────────────────────────────────────

interface MockOrtSession {
  releaseCount: number;
  release(): Promise<void>;
}

interface MockModel {
  disposeCount: number;
  dispose(): Promise<void>;
}

function makeMockSession(): MockOrtSession {
  const s: MockOrtSession = {
    releaseCount: 0,
    async release() { this.releaseCount++; },
  };
  return s;
}

function makeMockModel(): MockModel {
  const m: MockModel = {
    disposeCount: 0,
    async dispose() { this.disposeCount++; },
  };
  return m;
}

// ── Mirror of model-worker.ts handleShutdown (§A-shutdown #990) ───────────────
// Keep in sync with web/src/agent/model-worker.ts `handleShutdown`.

interface WorkerState {
  drafterSession: MockOrtSession | null;
  model: MockModel | null;
  processor: unknown;
}

async function handleShutdown(state: WorkerState): Promise<void> {
  if (state.drafterSession) {
    try { await (state.drafterSession as any).release?.(); } catch { /* non-fatal */ }
    state.drafterSession = null;
  }
  if (state.model) {
    try { await (state.model as any).dispose?.(); } catch { /* non-fatal */ }
    state.model = null;
  }
  state.processor = null;
}

// ── Mirror of model-worker.ts handleInit re-init dispose (§A-init #990) ──────
// Keep in sync with web/src/agent/model-worker.ts `handleInit` leading dispose block.

async function disposeOnReInit(state: WorkerState): Promise<void> {
  if (state.drafterSession) {
    try { await (state.drafterSession as any).release?.(); } catch { /* non-fatal */ }
    state.drafterSession = null;
  }
  if (state.model) {
    try { await (state.model as any).dispose?.(); } catch { /* non-fatal */ }
    state.model = null;
  }
  state.processor = null;
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe("#990 §A-shutdown — handleShutdown disposes ORT sessions", () => {

  test("shutdown: _drafterSession.release() called exactly once", async () => {
    const sess = makeMockSession();
    const state: WorkerState = { drafterSession: sess, model: null, processor: null };
    await handleShutdown(state);
    expect(sess.releaseCount).toBe(1);
    expect(state.drafterSession).toBeNull();
  });

  test("shutdown: _model.dispose() called exactly once when present", async () => {
    const model = makeMockModel();
    const state: WorkerState = { drafterSession: null, model, processor: {} };
    await handleShutdown(state);
    expect(model.disposeCount).toBe(1);
    expect(state.model).toBeNull();
    expect(state.processor).toBeNull();
  });

  test("shutdown: both drafter and model disposed in same call", async () => {
    const sess = makeMockSession();
    const model = makeMockModel();
    const state: WorkerState = { drafterSession: sess, model, processor: {} };
    await handleShutdown(state);
    expect(sess.releaseCount).toBe(1);
    expect(model.disposeCount).toBe(1);
    expect(state.drafterSession).toBeNull();
    expect(state.model).toBeNull();
  });

  test("shutdown: no drafter session — no crash, model still disposed", async () => {
    const model = makeMockModel();
    const state: WorkerState = { drafterSession: null, model, processor: null };
    await expect(handleShutdown(state)).resolves.toBeUndefined();
    expect(model.disposeCount).toBe(1);
  });

  test("shutdown: no sessions at all — no crash", async () => {
    const state: WorkerState = { drafterSession: null, model: null, processor: null };
    await expect(handleShutdown(state)).resolves.toBeUndefined();
  });

  test("release() throwing: non-fatal — state still nulled", async () => {
    const badSess = {
      releaseCount: 0,
      async release() {
        this.releaseCount++;
        throw new Error("ORT release failed");
      },
    };
    const state: WorkerState = { drafterSession: badSess as unknown as MockOrtSession, model: null, processor: null };
    await expect(handleShutdown(state)).resolves.toBeUndefined();
    expect(state.drafterSession).toBeNull();
  });
});

describe("#990 §A-init — handleInit disposes prior session on re-init (model swap)", () => {

  test("re-init: old _drafterSession.release() called once before new session", async () => {
    const oldSess = makeMockSession();
    const state: WorkerState = { drafterSession: oldSess, model: null, processor: null };
    await disposeOnReInit(state);
    // Old session disposed
    expect(oldSess.releaseCount).toBe(1);
    expect(state.drafterSession).toBeNull();
    // Simulate new session created after dispose
    const newSess = makeMockSession();
    state.drafterSession = newSess;
    expect(newSess.releaseCount).toBe(0); // not released yet
  });

  test("re-init: no prior session — no crash", async () => {
    const state: WorkerState = { drafterSession: null, model: null, processor: null };
    await expect(disposeOnReInit(state)).resolves.toBeUndefined();
  });

  test("re-init: each swap releases exactly 1 session (1 release per swap)", async () => {
    const sessions = [makeMockSession(), makeMockSession(), makeMockSession()];
    const state: WorkerState = { drafterSession: null, model: null, processor: null };

    for (let i = 0; i < sessions.length; i++) {
      // Load new session
      state.drafterSession = sessions[i];
      if (i + 1 < sessions.length) {
        // Re-init: dispose current before loading next
        await disposeOnReInit(state);
        expect(sessions[i].releaseCount).toBe(1);
      }
    }
    // Final session never released (session still active)
    expect(sessions[sessions.length - 1].releaseCount).toBe(0);
  });

  test("re-init: _model.dispose() called on prior model", async () => {
    const oldModel = makeMockModel();
    const state: WorkerState = { drafterSession: null, model: oldModel, processor: {} };
    await disposeOnReInit(state);
    expect(oldModel.disposeCount).toBe(1);
    expect(state.model).toBeNull();
    expect(state.processor).toBeNull();
  });
});
