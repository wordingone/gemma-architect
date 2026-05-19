// video-input.ts — Frame sampler + data-URL encoder for E4B video content blocks (#693).
//
// Env gate: VITE_VIDEO_INPUT=1 (disabled by default — verify step is chromium-halt-blocked).
//
// Pipeline:
//   ImageBitmap[] (from video-recorder ring buffer)
//     → sampleFrames()    — thin down to ≤ MAX_VIDEO_FRAMES at ≤ VIDEO_FPS
//     → framesToDataUrls() — encode each frame as JPEG data URL via OffscreenCanvas
//     → returned as string[] for transfer to model-worker via postMessage
//
// The Gemma 4 model card specifies 1 fps, max 60s (60 frames) for video input.
// transformers.js processor accepts { type: "video", video: RawImage[] } content blocks;
// frames are passed as the `videos` arg: proc(chatText, null, [RawImages[]]).
//
// References:
//   HuggingFace Gemma 4 model card — native video processing, 1 fps, up to 60s
//   transformers.js v4.x AutoProcessor — videos param in processor call

export const VIDEO_INPUT_ENABLED: boolean =
  !!(import.meta.env as Record<string, string | undefined>).VITE_VIDEO_INPUT;

// Gemma 4 model card constraints.
export const VIDEO_FPS = 1;             // frames per second passed to the model
export const MAX_VIDEO_FRAMES = 60;     // 60 frames = 60 s at 1 fps
export const VIDEO_JPEG_QUALITY = 0.85; // JPEG quality for data-URL encoding

/**
 * Sample `frames` down to at most `maxFrames` evenly spaced frames,
 * selected to approximate `fps` relative to the capture rate.
 *
 * The ring buffer captures at 4 fps (250ms interval). To get 1 model-fps from
 * 4 capture-fps, we stride by 4 — i.e. take every 4th frame. This is equivalent
 * to selecting frames at the target fps × (captureRate / targetRate).
 *
 * @param frames      Source frames (ordered oldest→newest).
 * @param captureRate Capture rate of the source ring buffer (fps). Default: 4.
 * @param targetFps   Target fps for the model. Default: VIDEO_FPS (1).
 * @param maxFrames   Hard cap on output count. Default: MAX_VIDEO_FRAMES (60).
 */
export function sampleFrames(
  frames:      ImageBitmap[],
  captureRate  = 4,
  targetFps    = VIDEO_FPS,
  maxFrames    = MAX_VIDEO_FRAMES,
): ImageBitmap[] {
  if (frames.length === 0) return [];
  // stride = how many source frames per output frame
  const stride = Math.max(1, Math.round(captureRate / targetFps));
  const sampled: ImageBitmap[] = [];
  for (let i = 0; i < frames.length && sampled.length < maxFrames; i += stride) {
    sampled.push(frames[i]);
  }
  return sampled;
}

/**
 * Encode each ImageBitmap as a JPEG data URL using OffscreenCanvas.
 * Returns the data URLs in the same order as the input frames.
 *
 * @param frames   Sampled ImageBitmap frames.
 * @param quality  JPEG quality [0-1]. Default: VIDEO_JPEG_QUALITY.
 */
export async function framesToDataUrls(
  frames:  ImageBitmap[],
  quality  = VIDEO_JPEG_QUALITY,
): Promise<string[]> {
  const urls: string[] = [];
  for (const bmp of frames) {
    const w = bmp.width;
    const h = bmp.height;
    if (w === 0 || h === 0) continue;

    const oc = new OffscreenCanvas(w, h);
    const ctx = oc.getContext("2d") as OffscreenCanvasRenderingContext2D | null;
    if (!ctx) continue;

    ctx.drawImage(bmp, 0, 0);
    const blob = await oc.convertToBlob({ type: "image/jpeg", quality });
    const dataUrl = await _blobToDataUrl(blob);
    urls.push(dataUrl);
  }
  return urls;
}

function _blobToDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result as string);
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}

/**
 * Full pipeline: sample ring buffer frames + encode to data URLs.
 * Returns an empty array if video input is disabled or frames is empty.
 */
export async function buildVideoDataUrls(
  frames:      ImageBitmap[],
  captureRate  = 4,
): Promise<string[]> {
  if (!VIDEO_INPUT_ENABLED) return [];
  if (frames.length === 0)  return [];
  const sampled = sampleFrames(frames, captureRate);
  return framesToDataUrls(sampled);
}
