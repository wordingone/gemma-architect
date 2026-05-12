// Video recorder — T12. Captures the browser tab/UI at 4 fps via getDisplayMedia
// and maintains a 60-frame ring buffer (15 s of replay context) for downstream
// agent-replicate flows. Capture is grab-frame-from-<video>-element + draw to
// OffscreenCanvas + transferToImageBitmap; the ring buffer is ImageBitmap[] so
// frames stay GPU-resident and zero-copy when blitted later.
//
// Public API matches T12 spec exactly. No dependencies beyond DOM + WebWorker
// libs (already in tsconfig). Closes any prior MediaStream tracks on stop and
// disposes ImageBitmaps when the buffer rotates / is cleared.

const RING_SIZE = 60; // 60 frames × 250 ms = 15 s
const FRAME_INTERVAL_MS = 250;
const TARGET_FRAME_RATE = 4;

let mediaStream: MediaStream | null = null;
let videoEl: HTMLVideoElement | null = null;
let canvas: OffscreenCanvas | null = null;
let canvasCtx: OffscreenCanvasRenderingContext2D | null = null;
let captureTimer: number | null = null;
let recording = false;
const ringBuffer: ImageBitmap[] = [];
const stateSubscribers: Array<(active: boolean) => void> = [];

function notifyState(active: boolean): void {
  for (const cb of stateSubscribers) {
    try {
      cb(active);
    } catch {
      // Subscriber crashes must not break other subscribers or the recorder.
    }
  }
}

function disposeRingBuffer(): void {
  for (const bmp of ringBuffer) {
    try {
      bmp.close();
    } catch {
      // ImageBitmap.close() may throw if already closed; safe to ignore.
    }
  }
  ringBuffer.length = 0;
}

async function captureFrame(): Promise<void> {
  if (!recording) return;
  if (!videoEl || !canvas || !canvasCtx) return;
  if (videoEl.readyState < 2) return; // HAVE_CURRENT_DATA — no frame yet
  const w = videoEl.videoWidth;
  const h = videoEl.videoHeight;
  if (w === 0 || h === 0) return;
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  try {
    canvasCtx.drawImage(videoEl, 0, 0, w, h);
    const bmp = canvas.transferToImageBitmap();
    ringBuffer.push(bmp);
    if (ringBuffer.length > RING_SIZE) {
      const dropped = ringBuffer.shift();
      if (dropped) {
        try {
          dropped.close();
        } catch {
          // already-closed bitmap; ignore
        }
      }
    }
  } catch {
    // drawImage / transferToImageBitmap can throw if the source is tainted
    // or the canvas is detached. Skip the frame; recording continues.
  }
}

export async function startRecording(): Promise<void> {
  if (recording) return;
  if (typeof navigator === "undefined" || !navigator.mediaDevices?.getDisplayMedia) {
    throw new Error("getDisplayMedia is not supported in this environment");
  }
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: TARGET_FRAME_RATE },
    audio: false,
  });
  mediaStream = stream;

  videoEl = document.createElement("video");
  videoEl.muted = true;
  videoEl.playsInline = true;
  videoEl.srcObject = stream;
  try {
    await videoEl.play();
  } catch {
    // Autoplay restrictions shouldn't normally bite a muted video, but if
    // play() rejects we still want the recording loop to try every interval.
  }

  // OffscreenCanvas is in lib.dom (per tsconfig WebWorker lib).
  canvas = new OffscreenCanvas(1, 1);
  const ctx = canvas.getContext("2d");
  canvasCtx = ctx as OffscreenCanvasRenderingContext2D | null;

  recording = true;
  disposeRingBuffer();

  // If the user ends the share via the browser's native UI, treat that as
  // stopRecording() — keeps state coherent without polling.
  for (const track of stream.getTracks()) {
    track.addEventListener("ended", () => {
      if (recording) stopRecording();
    });
  }

  captureTimer = window.setInterval(() => {
    void captureFrame();
  }, FRAME_INTERVAL_MS);

  notifyState(true);
}

export function stopRecording(): void {
  if (!recording) return;
  recording = false;
  if (captureTimer !== null) {
    window.clearInterval(captureTimer);
    captureTimer = null;
  }
  if (mediaStream) {
    for (const track of mediaStream.getTracks()) {
      try {
        track.stop();
      } catch {
        // stop() throws on already-ended tracks in some browsers; ignore.
      }
    }
    mediaStream = null;
  }
  if (videoEl) {
    try {
      videoEl.pause();
    } catch {
      // ignore
    }
    videoEl.srcObject = null;
    videoEl = null;
  }
  canvas = null;
  canvasCtx = null;
  notifyState(false);
}

export function isRecording(): boolean {
  return recording;
}

export function getFrameBuffer(): ImageBitmap[] {
  // Return a shallow copy so callers iterating won't observe ring rotations.
  return ringBuffer.slice();
}

export function clearFrameBuffer(): void {
  disposeRingBuffer();
}

export function subscribeRecordingState(cb: (active: boolean) => void): () => void {
  stateSubscribers.push(cb);
  // Fire current state immediately so subscribers don't need a separate
  // initial-read call.
  try {
    cb(recording);
  } catch {
    // ignore subscriber errors on initial fire
  }
  return () => {
    const idx = stateSubscribers.indexOf(cb);
    if (idx >= 0) stateSubscribers.splice(idx, 1);
  };
}
