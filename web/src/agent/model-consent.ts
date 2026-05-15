// model-consent.ts — First-load download consent gate for in-browser Gemma 4 (#615).
//
// On first visit (no prior consent) the user sees a dialog explaining the ~4 GB
// model download. Clicking "Download" sets a localStorage flag and kicks off model
// prefetch. Subsequent visits skip the dialog (model served from browser cache).
//
// Remote path (VITE_GEMMA_AGENT_URL set): consent gate is skipped — no local download.
//
// Progress strip: listens to agentmodel:loading custom events and renders a thin
// full-width bar that auto-hides when agentmodel:ready fires.

const CONSENT_KEY = "gemma4-e4b-consent-v1";

function hasConsent(): boolean {
  try {
    return localStorage.getItem(CONSENT_KEY) === "1";
  } catch {
    return false;
  }
}

function grantConsent(): void {
  try {
    localStorage.setItem(CONSENT_KEY, "1");
  } catch {
    // storage unavailable — proceed anyway
  }
}

// ---- Download progress strip ---------------------------------------------------

let _progressStrip: HTMLElement | null = null;

function ensureProgressStrip(): HTMLElement {
  if (_progressStrip) return _progressStrip;
  const strip = document.createElement("div");
  strip.id = "model-download-strip";
  strip.style.cssText = [
    "position:fixed",
    "bottom:0",
    "left:0",
    "right:0",
    "z-index:9000",
    "background:var(--ink-base,#0e0e10)",
    "color:var(--paper-base,#faf7ee)",
    "font:11px/1 var(--font-mono,'JetBrains Mono',monospace)",
    "padding:6px 16px",
    "display:flex",
    "align-items:center",
    "gap:12px",
  ].join(";");
  strip.innerHTML = `
    <span id="model-dl-label" style="flex:0 0 auto;opacity:.7;">GEMMA·4·E4B  ·  DOWNLOADING</span>
    <div style="flex:1;height:3px;background:rgba(255,255,255,.15);border-radius:2px;overflow:hidden">
      <div id="model-dl-bar" style="height:100%;width:0%;background:var(--accent,#4ca6ff);transition:width .3s;border-radius:2px;"></div>
    </div>
    <span id="model-dl-pct" style="flex:0 0 32px;text-align:right;opacity:.7;">0%</span>
  `;
  document.body.appendChild(strip);
  _progressStrip = strip;
  return strip;
}

function updateProgress(pct: number, file: string): void {
  const strip = ensureProgressStrip();
  strip.style.display = "flex";
  const bar = document.getElementById("model-dl-bar");
  const pctEl = document.getElementById("model-dl-pct");
  const labelEl = document.getElementById("model-dl-label");
  if (bar) bar.style.width = `${Math.round(pct)}%`;
  if (pctEl) pctEl.textContent = `${Math.round(pct)}%`;
  if (labelEl) {
    const shortFile = file ? ` · ${file.split("/").pop() ?? file}` : "";
    labelEl.textContent = `GEMMA·4·E4B  ·  DOWNLOADING${shortFile}`;
  }
}

function hideProgressStrip(): void {
  if (_progressStrip) {
    _progressStrip.style.transition = "opacity .4s";
    _progressStrip.style.opacity = "0";
    setTimeout(() => {
      _progressStrip?.remove();
      _progressStrip = null;
    }, 500);
  }
}

function wireProgressEvents(): void {
  window.addEventListener("agentmodel:loading", (e) => {
    const { progress, file } = (e as CustomEvent<{ progress: number; file?: string }>).detail;
    updateProgress(progress ?? 0, file ?? "");
  });
  window.addEventListener("agentmodel:ready", () => hideProgressStrip(), { once: true });
  window.addEventListener("agentmodel:error", () => hideProgressStrip(), { once: true });
}

// ---- Consent dialog ------------------------------------------------------------

function buildConsentDialog(onApprove: () => void, onCancel: () => void): HTMLElement {
  const overlay = document.createElement("div");
  overlay.id = "model-consent-overlay";
  overlay.style.cssText = [
    "position:fixed",
    "inset:0",
    "z-index:8999",
    "background:rgba(0,0,0,.72)",
    "display:flex",
    "align-items:center",
    "justify-content:center",
  ].join(";");

  const card = document.createElement("div");
  card.style.cssText = [
    "background:var(--surface,#1c1c20)",
    "color:var(--ink-base,#e8e4dc)",
    "border:1px solid rgba(255,255,255,.10)",
    "border-radius:10px",
    "padding:28px 32px 24px",
    "max-width:460px",
    "width:calc(100% - 48px)",
    "font-family:var(--font-ui,'Inter',sans-serif)",
    "box-shadow:0 24px 80px rgba(0,0,0,.6)",
  ].join(";");

  card.innerHTML = `
    <div style="font:600 15px/1.2 var(--font-ui,'Inter',sans-serif);letter-spacing:.01em;margin-bottom:10px;">
      Gemma 4 (E4B) — model download required
    </div>
    <div style="font:13px/1.55 var(--font-ui,'Inter',sans-serif);opacity:.75;margin-bottom:20px;">
      Gemma·Architect runs the AI entirely in your browser.
      The first time you use it, it needs to download model files
      (<strong style="opacity:1;">≈ 4 GB</strong>) from HuggingFace.
      Files are cached — subsequent sessions load instantly.
    </div>
    <div style="font:11px/1.4 var(--font-mono,'JetBrains Mono',monospace);opacity:.45;margin-bottom:20px;">
      Your browser may show a storage permission prompt for large caches.
      Progress appears at the bottom of the screen during download.
    </div>
    <div style="display:flex;gap:10px;justify-content:flex-end;">
      <button id="consent-cancel" style="
        padding:7px 16px;border:1px solid rgba(255,255,255,.15);border-radius:6px;
        background:transparent;color:inherit;font:13px var(--font-ui,'Inter',sans-serif);
        cursor:pointer;opacity:.7;
      ">Not now</button>
      <button id="consent-approve" style="
        padding:7px 20px;border:none;border-radius:6px;
        background:var(--accent,#4ca6ff);color:#fff;
        font:600 13px var(--font-ui,'Inter',sans-serif);cursor:pointer;
      ">Download model (≈ 4 GB)</button>
    </div>
  `;

  card.querySelector("#consent-approve")?.addEventListener("click", () => {
    overlay.remove();
    onApprove();
  });
  card.querySelector("#consent-cancel")?.addEventListener("click", () => {
    overlay.remove();
    onCancel();
  });

  overlay.appendChild(card);
  return overlay;
}

// ---- Public API ----------------------------------------------------------------

/**
 * Call instead of prefetchModel() when running in-browser (no REMOTE_URL).
 * If the user has already consented, calls onProceed() immediately.
 * Otherwise shows the consent dialog first.
 */
export function checkConsentAndLoad(onProceed: () => void): void {
  wireProgressEvents();

  if (hasConsent()) {
    onProceed();
    return;
  }

  const overlay = buildConsentDialog(
    () => { grantConsent(); onProceed(); },
    () => { /* user cancelled — do nothing; model won't load until next attempt */ },
  );
  document.body.appendChild(overlay);
}
