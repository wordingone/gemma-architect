// boot-capability-gate.ts — #1637: Boot-time GPU capability detection + 3-path user choice.
//
// Runs before model loading starts. If adapter class is not dgpu (and ?gpu=wasm not already
// set), shows a full-screen modal requiring user to pick one of three paths before proceeding.
//
// Path 1 "flags":         Show chrome://flags instructions. Page sits; user must reload manually.
// Path 2 "wasm-fallback": Reload with ?gpu=wasm — next boot uses WASM EP, modal skipped.
// Path 3 "cad-only":      No AI. CREATE tab disabled; chat panel not mounted.
//
// Gate promise resolves immediately (no modal) when:
//   - adapter classifies as dgpu, OR
//   - ?gpu=wasm already in URL (returning user from Path 2)

export type AdapterClass = "dgpu" | "igpu" | "software" | "unknown" | "no-webgpu";
export type UserPath = "dgpu-proceed" | "flags" | "wasm-fallback" | "cad-only";
export type BootTier = "tier_0" | "tier_1" | "tier_2" | "tier_4";

export function pathToTier(path: UserPath): BootTier {
  switch (path) {
    case "dgpu-proceed": return "tier_0";
    case "wasm-fallback": return "tier_1";
    case "flags": return "tier_0"; // user is fixing gpu; tier will be 0 on reload
    case "cad-only": return "tier_4";
  }
}

export function isGpuWasmForced(): boolean {
  try { return new URLSearchParams(location.search).get("gpu") === "wasm"; } catch { return false; }
}

// ── Adapter detection ────────────────────────────────────────────────────────

export async function detectAdapterClass(): Promise<{ classification: AdapterClass; deviceLabel: string }> {
  try {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const gpu = (navigator as any).gpu;
    if (!gpu) return { classification: "no-webgpu", deviceLabel: "" };
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const adapter = await gpu.requestAdapter({ powerPreference: "high-performance" }).catch(() => null) as any | null;
    if (!adapter) return { classification: "no-webgpu", deviceLabel: "" };

    const info = adapter.info ?? {};
    const vendor = String(info.vendor ?? "").toLowerCase();
    const arch   = String(info.architecture ?? "").toLowerCase();
    const isFallback = !!adapter.isFallbackAdapter;
    const deviceLabel = String(info.description ?? info.device ?? info.vendor ?? "").trim();

    let classification: AdapterClass;
    if (isFallback) {
      classification = "software";
    } else if (
      vendor === "intel" &&
      (arch.startsWith("gen-") || arch.includes("iris") || arch.includes("uhd") || arch.includes("xe-lp"))
    ) {
      classification = "igpu";
    } else if (vendor === "amd" && (arch.includes("vega-igpu") || arch.includes("gfx10-igpu"))) {
      classification = "igpu";
    } else if (vendor === "apple") {
      classification = "igpu";
    } else if (vendor === "") {
      classification = "unknown";
    } else {
      classification = "dgpu";
    }
    return { classification, deviceLabel };
  } catch {
    return { classification: "unknown", deviceLabel: "" };
  }
}

// ── Modal DOM ────────────────────────────────────────────────────────────────

function _deviceCopy(cl: AdapterClass, label: string): string {
  if (cl === "no-webgpu" || cl === "software") {
    return "WebGPU is unavailable in your browser. Full AI features require Chrome or Edge with WebGPU support.";
  }
  if (cl === "igpu") {
    const dev = label ? `(${label}) ` : "";
    return `Your browser is using integrated graphics ${dev}— Chrome is routing WebGPU to a slower GPU. Full AI speed requires the dedicated GPU.`;
  }
  return "Your browser's GPU configuration may limit AI performance.";
}

function _buildModal(
  container: HTMLElement,
  cl: AdapterClass,
  label: string,
): Promise<UserPath> {
  return new Promise<UserPath>((resolve) => {
    const modal = document.createElement("div");
    modal.className = "bcg-modal";
    modal.setAttribute("role", "dialog");
    modal.setAttribute("aria-modal", "true");
    modal.setAttribute("aria-label", "GPU capability options");

    const flagsUrl = "chrome://flags/#force-high-performance-gpu";

    modal.innerHTML = `
      <div class="bcg-inner">
        <div class="bcg-icon">⚡</div>
        <h2 class="bcg-title">Set up GPU for AI</h2>
        <p class="bcg-device">${_deviceCopy(cl, label)}</p>

        <div class="bcg-paths">

          <div class="bcg-path bcg-path--recommended" tabindex="0" role="button" aria-label="Enable full speed (recommended)">
            <div class="bcg-path-header">
              <span class="bcg-path-badge">Recommended</span>
              <span class="bcg-path-title">Enable full speed</span>
              <span class="bcg-path-perf">30–50 tok/s</span>
            </div>
            <p class="bcg-path-desc">Use high-performance GPU via Chrome flag — restores full AI speed.</p>
            <div class="bcg-path-steps" aria-label="Steps">
              <ol>
                <li>Open a new tab and paste this URL:</li>
              </ol>
              <div class="bcg-url-row">
                <code class="bcg-flag-url">${flagsUrl}</code>
                <button class="bcg-copy-btn" type="button" title="Copy URL" aria-label="Copy chrome flags URL">Copy</button>
              </div>
              <ol start="2">
                <li>Set the flag dropdown to <strong>Enabled</strong></li>
                <li>Click <strong>Relaunch</strong></li>
                <li>Return to this page</li>
              </ol>
              <details class="bcg-alt-details">
                <summary>Or use Windows Graphics Settings</summary>
                <ol>
                  <li>Open Windows Settings → System → Display → Graphics</li>
                  <li>Find <strong>chrome.exe</strong> → Options → <strong>High performance</strong></li>
                  <li>Save → relaunch Chrome → return here</li>
                </ol>
              </details>
            </div>
            <button class="bcg-path-btn bcg-path-btn--primary" type="button" data-path="flags" aria-label="I have done this — reload the page">
              I've done this — reload the page
            </button>
          </div>

          <div class="bcg-path" tabindex="0" role="button" aria-label="Use fallback inference (slower)">
            <div class="bcg-path-header">
              <span class="bcg-path-title">Use fallback inference</span>
              <span class="bcg-path-perf bcg-path-perf--slow">3–8 tok/s</span>
            </div>
            <p class="bcg-path-desc">Continue with WASM CPU inference. All AI features work; generation is slower.</p>
            <button class="bcg-path-btn" type="button" data-path="wasm-fallback" aria-label="Continue with slower AI">
              Continue with slower AI
            </button>
          </div>

          <div class="bcg-path" tabindex="0" role="button" aria-label="Skip AI features">
            <div class="bcg-path-header">
              <span class="bcg-path-title">Skip AI features</span>
              <span class="bcg-path-perf bcg-path-perf--none">CAD only</span>
            </div>
            <p class="bcg-path-desc">Use NURBS modeling, IFC import/export, and view tools. CREATE tab will be disabled.</p>
            <button class="bcg-path-btn" type="button" data-path="cad-only" aria-label="Continue without AI">
              Continue without AI
            </button>
          </div>

        </div>

        <p class="bcg-footer">This choice is saved for this session. Reload to change.</p>
      </div>
    `;

    // Copy button for chrome://flags URL
    modal.querySelector<HTMLButtonElement>(".bcg-copy-btn")?.addEventListener("click", (e) => {
      e.stopPropagation();
      navigator.clipboard?.writeText(flagsUrl).catch(() => {});
      const btn = e.currentTarget as HTMLButtonElement;
      const orig = btn.textContent;
      btn.textContent = "Copied!";
      setTimeout(() => { btn.textContent = orig; }, 1500);
    });

    // Path button clicks
    modal.querySelectorAll<HTMLButtonElement>("[data-path]").forEach((btn) => {
      btn.addEventListener("click", (e) => {
        e.stopPropagation();
        const path = btn.dataset.path as UserPath;
        if (path === "wasm-fallback") {
          // Reload with ?gpu=wasm — modal will be skipped on next boot
          const sep = location.search ? "&" : "?";
          window.location.assign(location.href + sep + "gpu=wasm");
          return; // navigation pending; don't resolve
        }
        if (path === "flags") {
          // Reload — user confirmed they enabled the flag
          window.location.reload();
          return;
        }
        modal.remove();
        resolve(path);
      });
    });

    // Keyboard: Tab cycles buttons; Enter/Space activates focused button
    modal.addEventListener("keydown", (e) => {
      if (e.key === "Enter" || e.key === " ") {
        const el = document.activeElement as HTMLButtonElement;
        if (el?.dataset.path) el.click();
      }
    });

    container.appendChild(modal);

    // Focus first interactive element
    requestAnimationFrame(() => {
      modal.querySelector<HTMLButtonElement>(".bcg-copy-btn")?.focus();
    });
  });
}

// ── CSS ──────────────────────────────────────────────────────────────────────

function _injectStyles(): void {
  if (document.getElementById("bcg-styles")) return;
  const style = document.createElement("style");
  style.id = "bcg-styles";
  style.textContent = `
.bcg-modal {
  position: fixed; inset: 0; z-index: 9999;
  background: #0d0d0d;
  display: flex; align-items: center; justify-content: center;
  font-family: "Inter", system-ui, sans-serif;
  color: #e8e8e8;
  overflow-y: auto;
  padding: 24px 16px;
}
.bcg-inner {
  max-width: 600px; width: 100%;
  display: flex; flex-direction: column; gap: 20px;
}
.bcg-icon { font-size: 32px; }
.bcg-title { font-size: 22px; font-weight: 700; margin: 0; letter-spacing: -.02em; }
.bcg-device { margin: 0; font-size: 13px; color: #aaa; line-height: 1.5; }
.bcg-paths { display: flex; flex-direction: column; gap: 12px; }
.bcg-path {
  background: #1a1a1a; border: 1px solid #2e2e2e; border-radius: 8px;
  padding: 16px 18px; display: flex; flex-direction: column; gap: 10px;
  cursor: default; outline: none;
}
.bcg-path--recommended { border-color: #3d8fff55; background: #0e1f3a; }
.bcg-path:focus-visible { border-color: #3d8fff; box-shadow: 0 0 0 2px #3d8fff44; }
.bcg-path-header { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.bcg-path-badge {
  font-size: 10px; text-transform: uppercase; letter-spacing: .05em;
  background: #3d8fff; color: #fff; border-radius: 3px; padding: 2px 6px;
}
.bcg-path-title { font-size: 15px; font-weight: 600; }
.bcg-path-perf { font-size: 12px; color: #5c8; margin-left: auto; font-variant-numeric: tabular-nums; }
.bcg-path-perf--slow { color: #c85; }
.bcg-path-perf--none { color: #888; }
.bcg-path-desc { margin: 0; font-size: 12px; color: #aaa; line-height: 1.5; }
.bcg-path-steps { font-size: 12px; color: #c8c8c8; }
.bcg-path-steps ol { margin: 4px 0; padding-left: 18px; line-height: 1.8; }
.bcg-url-row { display: flex; align-items: center; gap: 8px; margin: 6px 0; }
.bcg-flag-url {
  background: #111; border: 1px solid #333; border-radius: 4px;
  padding: 4px 8px; font-size: 11px; color: #7db4ff; flex: 1; user-select: all;
  word-break: break-all;
}
.bcg-copy-btn {
  background: #252525; border: 1px solid #3a3a3a; border-radius: 4px;
  color: #ccc; font-size: 11px; padding: 4px 10px; cursor: pointer; white-space: nowrap;
  flex-shrink: 0;
}
.bcg-copy-btn:hover { background: #333; color: #fff; }
.bcg-copy-btn:focus-visible { outline: 2px solid #3d8fff; outline-offset: 2px; }
.bcg-alt-details { margin-top: 8px; }
.bcg-alt-details summary { cursor: pointer; color: #7db4ff; font-size: 11px; }
.bcg-path-btn {
  align-self: flex-start;
  background: #252525; border: 1px solid #3a3a3a; border-radius: 5px;
  color: #ccc; font-size: 12px; padding: 7px 14px; cursor: pointer; font-weight: 500;
}
.bcg-path-btn:hover { background: #333; color: #fff; }
.bcg-path-btn:focus-visible { outline: 2px solid #3d8fff; outline-offset: 2px; }
.bcg-path-btn--primary {
  background: #1b3a6b; border-color: #3d8fff66; color: #7db4ff;
}
.bcg-path-btn--primary:hover { background: #1f4d94; color: #b0d4ff; }
.bcg-footer { margin: 0; font-size: 11px; color: #555; }
  `;
  document.head.appendChild(style);
}

// ── Gate promise ─────────────────────────────────────────────────────────────

let _gatePromise: Promise<UserPath> | null = null;
let _resolvedPath: UserPath | null = null;

export function getCapabilityGatePromise(): Promise<UserPath> {
  if (!_gatePromise) {
    // Should have been initialized by initCapabilityGate; resolve to dgpu as fallback.
    _gatePromise = Promise.resolve<UserPath>("dgpu-proceed");
  }
  return _gatePromise;
}

export function getResolvedPath(): UserPath | null { return _resolvedPath; }

export function isCadOnlyMode(): boolean { return _resolvedPath === "cad-only"; }
export function isWasmFallbackMode(): boolean {
  return _resolvedPath === "wasm-fallback" || isGpuWasmForced();
}

// ── Init (called by boot-screen.ts) ─────────────────────────────────────────

let _modalShown = false;

/** Returns true if the modal was shown (i.e. classification ≠ dgpu and not ?gpu=wasm). */
export let wasCapabilityModalShown = false;
/** The user's chosen path after gate resolves (or "dgpu-proceed" if no modal). */
export let resolvedBootPath: UserPath = "dgpu-proceed";

export function initCapabilityGate(overlayContainer: HTMLElement): void {
  if (_gatePromise) return; // already initialized

  // If ?gpu=wasm is already set, user already picked Path 2 on a prior boot.
  if (isGpuWasmForced()) {
    _gatePromise = Promise.resolve<UserPath>("wasm-fallback");
    _resolvedPath = "wasm-fallback";
    resolvedBootPath = "wasm-fallback";
    return;
  }

  _gatePromise = (async (): Promise<UserPath> => {
    const { classification, deviceLabel } = await detectAdapterClass();
    // §#1637-Leo: unknown defaults to dgpu-path (no modal). False-negative (slower inference
    // for one user) is much cheaper than false-positive (blocking a healthy user).
    if (classification === "dgpu" || classification === "unknown") {
      _resolvedPath = "dgpu-proceed";
      resolvedBootPath = "dgpu-proceed";
      return "dgpu-proceed";
    }
    // Show modal for igpu / software / no-webgpu
    _injectStyles();
    _modalShown = true;
    wasCapabilityModalShown = true;
    const path = await _buildModal(overlayContainer, classification, deviceLabel);
    _resolvedPath = path;
    resolvedBootPath = path;
    return path;
  })();
}
