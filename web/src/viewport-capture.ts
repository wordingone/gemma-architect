// viewport-capture.ts — Capture the THREE.js WebGL canvas at reduced resolution.
//
// Returns a JPEG data-URL suitable for embedding in an image-text-to-text
// model turn, or null if the canvas is unavailable / tainted.
//
// The main renderer must have preserveDrawingBuffer: true (set in viewer.ts).

export function captureViewport(maxDim = 512): string | null {
  // __viewer.canvas is private in TypeScript but accessible at runtime.
  type ViewerLike = { canvas?: HTMLCanvasElement; renderer?: { domElement?: HTMLCanvasElement } };
  const viewer = (window as unknown as { __viewer?: ViewerLike }).__viewer;
  const canvas: HTMLCanvasElement | null =
    viewer?.canvas ?? viewer?.renderer?.domElement ?? document.querySelector("canvas");
  if (!canvas) return null;

  const w = canvas.width;
  const h = canvas.height;
  if (w === 0 || h === 0) return null;

  const scale = Math.min(1, maxDim / Math.max(w, h));
  const sw = Math.max(1, Math.round(w * scale));
  const sh = Math.max(1, Math.round(h * scale));

  const off = document.createElement("canvas");
  off.width = sw;
  off.height = sh;
  const ctx = off.getContext("2d");
  if (!ctx) return null;

  try {
    ctx.drawImage(canvas, 0, 0, sw, sh);
  } catch {
    return null; // tainted canvas (cross-origin)
  }

  return off.toDataURL("image/jpeg", 0.82);
}
