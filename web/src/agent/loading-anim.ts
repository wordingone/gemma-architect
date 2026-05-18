// loading-anim.ts — SVG chrome-stroke animation during model load.
//
// Traces the app chrome edges (menubar bottom, ribbon bottom, viewport frame,
// statusbar top) with a stroke-dasharray sweep synchronized to model load time.
// Completes and fades out when both agentmodel:ready + agentmodel:drafter:ready
// have fired. Runs once per page load; never retriggered.

const SWEEP_MS = 45_000; // linear sweep covers 0→80% of path in this duration
const CAP_PCT = 80;      // progress cap before model-ready snap

let _initialized = false;
let _started = false;
let _done = false;
let _modelReady = false;
let _drafterReady = false;

let _svg: SVGSVGElement | null = null;
let _path: SVGPathElement | null = null;
let _totalLen = 0;
let _startTime = 0;
let _rafId = 0;

export function initLoadingAnim(): void {
  if (_initialized) return;
  _initialized = true;
  _wireEvents();
}

// ---- events ----------------------------------------------------------------

function _wireEvents(): void {
  window.addEventListener("agentmodel:loading", _onFirst, { once: true });
  window.addEventListener("agentmodel:ready", _onModelReady, { once: true });
  window.addEventListener("agentmodel:drafter:ready", _onDrafterReady, { once: true });
  window.addEventListener("agentmodel:error", _onModelReady, { once: true });
  window.addEventListener("agentmodel:drafter:error", _onDrafterReady, { once: true });
  // returning-user: skip animation entirely (model already cached)
  window.addEventListener("agentmodel:returning-user", _onDone, { once: true });
  // boot-complete: from Eli #938 richer events — treat as full completion
  window.addEventListener("agentmodel:boot-complete", _onDone, { once: true });
}

function _onFirst(): void {
  if (_started) return;
  _started = true;
  _startTime = performance.now();
  _buildOverlay();
  _tick();
}

function _onModelReady(): void {
  _modelReady = true;
  _maybeComplete();
}

function _onDrafterReady(): void {
  _drafterReady = true;
  _maybeComplete();
}

function _maybeComplete(): void {
  if (_modelReady && _drafterReady) _onDone();
}

function _onDone(): void {
  if (_done) return;
  _done = true;
  cancelAnimationFrame(_rafId);
  if (!_svg) return;
  // Snap to fully drawn
  if (_path) _path.style.strokeDashoffset = "0";
  // Fade out
  setTimeout(() => {
    if (!_svg) return;
    _svg.style.transition = "opacity 0.7s ease";
    _svg.style.opacity = "0";
    setTimeout(() => { _svg?.remove(); _svg = null; }, 800);
  }, 350);
}

// ---- rAF sweep -------------------------------------------------------------

function _tick(): void {
  if (_done || !_path) return;
  const elapsed = performance.now() - _startTime;
  const pct = Math.min((elapsed / SWEEP_MS) * CAP_PCT, CAP_PCT);
  _path.style.strokeDashoffset = `${_totalLen * (1 - pct / 100)}`;
  _rafId = requestAnimationFrame(_tick);
}

// ---- SVG overlay -----------------------------------------------------------

function _buildOverlay(): void {
  const segs = _chromeSegments();
  if (segs.length === 0) return;

  const d = segs.map(([x1, y1, x2, y2]) => `M${x1} ${y1} L${x2} ${y2}`).join(" ");

  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.id = "loading-anim-svg";
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = [
    "position:fixed",
    "inset:0",
    "width:100%",
    "height:100%",
    "pointer-events:none",
    "z-index:8998",
    "overflow:visible",
  ].join(";");

  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  path.setAttribute("fill", "none");
  path.setAttribute("stroke", "var(--accent, #4ca6ff)");
  path.setAttribute("stroke-width", "1.5");
  path.setAttribute("stroke-linecap", "round");
  path.setAttribute("opacity", "0.5");
  svg.appendChild(path);
  document.body.appendChild(svg);

  const len = path.getTotalLength();
  _totalLen = len || 1;
  path.style.strokeDasharray = `${_totalLen}`;
  path.style.strokeDashoffset = `${_totalLen}`;

  _svg = svg;
  _path = path;
}

function _chromeSegments(): [number, number, number, number][] {
  const segs: [number, number, number, number][] = [];

  const push = (el: Element | null, edge: "top" | "bottom" | "left" | "right") => {
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return;
    switch (edge) {
      case "bottom": segs.push([r.left, r.bottom, r.right, r.bottom]); break;
      case "top":    segs.push([r.left, r.top,    r.right, r.top]);    break;
      case "left":   segs.push([r.left, r.top,    r.left,  r.bottom]); break;
      case "right":  segs.push([r.right, r.top,   r.right, r.bottom]); break;
    }
  };

  // Chrome edges, drawn in order: menubar bottom → ribbon bottom →
  // viewport left → viewport top → viewport right → statusbar top
  push(document.querySelector(".menubar"),          "bottom");
  push(document.querySelector(".ribbon"),            "bottom");
  push(document.querySelector("#viewport-area-host"), "left");
  push(document.querySelector("#viewport-area-host"), "top");
  push(document.querySelector("#viewport-area-host"), "right");
  push(document.querySelector(".statusbar"),         "top");

  return segs;
}
