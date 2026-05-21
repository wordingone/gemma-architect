// boot-screen.ts — Full-viewport loading screen (#938, #1134).
// Blocks all underlying UI interaction until agentmodel:boot-complete fires.
// Supersedes loading-anim.ts chrome-edge overlay.

const LOOP_MS = 6_000;          // one travel-head cycle
const FADE_MS = 200;             // fade-out duration on completion
const READY_HOLD_MS = 1_200;     // returning-user: hold READY pulse before fade

let _initialized = false;
let _done = false;
let _isReturningUser = false;

// Bytes progress state
let _totalBytes = 0;             // from agentmodel:manifest
let _loadedBytes = 0;            // cumulative from loading events (file-banking approach)
let _completedFileBytes = 0;     // sum of total bytes for fully-transitioned files
let _lastFile = '';              // filename of the in-progress file
let _lastFileTotal = 0;          // total bytes of the in-progress file
let _throughput = 0;             // bytes/sec (last reported)
let _currentFile = '';           // display label (current file basename)

// DOM refs
let _overlay: HTMLDivElement | null = null;
let _headPath: SVGPathElement | null = null;
let _barFill: HTMLDivElement | null = null;
let _pctEl: HTMLSpanElement | null = null;
let _fileEl: HTMLSpanElement | null = null;
let _etaEl: HTMLSpanElement | null = null;
let _statusEl: HTMLDivElement | null = null;
let _hintEl: HTMLDivElement | null = null;

let _pathLen = 0;
let _headDashLen = 0;
let _startTime = 0;
let _rafId = 0;
let _watchdogId: ReturnType<typeof setTimeout> | null = null;
let _firstLoadingReceived = false;
let _stalledShown = false;
let _stallCount = 0;   // incremented each time _showStalled fires; exposed as window.__boot_stall_count

// Download trace — in-memory log of all agentmodel:* events for STALLED diagnostics.
type TraceEntry = { t: number; event: string; bytes?: number; total?: number; phase?: string };
const _trace: TraceEntry[] = [];
function _traceEvent(event: string, extra?: Omit<TraceEntry, 't' | 'event'>): void {
  _trace.push({ t: Math.round(performance.now()), event, ...extra });
}

// ---------------------------------------------------------------------------
// Public API

export function initBootScreen(): void {
  if (_initialized) return;
  _initialized = true;
  _buildOverlay();
  _wireEvents();
  _startTime = performance.now();
  _tick();
}

// ---------------------------------------------------------------------------
// Stall display

function _recoverFromStall(): void {
  if (!_stalledShown || !_statusEl) return;
  _stalledShown = false;
  _statusEl.textContent = '';
  _statusEl.style.display = 'none';
}

function _showStalled(): void {
  if (_done) return;
  _watchdogId = null;
  _stalledShown = true;
  _stallCount++;
  (window as unknown as Record<string, unknown>).__boot_stall_count = _stallCount;
  if (!_statusEl) return;
  Object.assign(_statusEl.style, { color: '#ff9900', display: 'block' });
  _statusEl.textContent = 'DOWNLOAD STALLED — check your connection and refresh';

  // Trace persisted silently — forensic if we can access the device, never user-facing.
  try {
    console.warn('[gemma-cad] stall trace', JSON.stringify(_trace));
    const req = indexedDB.open('gemma-cad-diagnostics', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('stall-traces');
    req.onsuccess = () => {
      const db = req.result;
      db.transaction('stall-traces', 'readwrite')
        .objectStore('stall-traces')
        .put(_trace, new Date().toISOString());
    };
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Event wiring

function _wireEvents(): void {
  window.addEventListener('agentmodel:manifest', (ev: Event) => {
    const detail = (ev as CustomEvent<{ totalBytesExpected?: number }>).detail;
    if (detail?.totalBytesExpected) _totalBytes = detail.totalBytesExpected;
    _traceEvent('manifest', { total: detail?.totalBytesExpected });
    // Cancel any watchdog set by pre-manifest loading events (they carry no bytes).
    if (_watchdogId !== null) { clearTimeout(_watchdogId); _watchdogId = null; }
    // Initial grace: 90s from manifest to first byte (covers CDN warmup + redirect chain).
    _watchdogId = setTimeout(_showStalled, 90_000);
  });

  window.addEventListener('agentmodel:loading', (ev: Event) => {
    const d = (ev as CustomEvent<{
      bytes?: number; total?: number; throughputBytesPerSec?: number; file?: string; phase?: string;
    }>).detail ?? {};
    // Cumulative bytes tracking: bank each completed file's total when the filename changes,
    // then add current-file loaded bytes. This matches model-consent.ts and avoids the
    // Math.max stall where per-file bytes reset to 0 on each new shard (#1379 Bug 2).
    const shortFile = d.file ? (d.file.split('/').pop() ?? d.file) : '';
    const bytes = d.bytes ?? 0;
    const total = d.total ?? 0;
    if (shortFile && shortFile !== _lastFile && _lastFile !== '') {
      _completedFileBytes += _lastFileTotal;
    }
    if (shortFile) { _lastFile = shortFile; _lastFileTotal = total; }
    if (bytes > 0 || _completedFileBytes > 0) {
      _loadedBytes = _completedFileBytes + bytes;
    }
    if (d.throughputBytesPerSec) _throughput = d.throughputBytesPerSec;
    if (d.file) _currentFile = d.file;
    if (!_totalBytes && total) _totalBytes = total;
    _traceEvent('loading', { bytes, total, phase: d.phase });
    // Any loading event proves the pipeline is alive — clear a false-positive stall.
    _recoverFromStall();
    // Sliding-window watchdog: arm/reset on each event.
    //
    // model-init: ORT/WebGPU deserialisation — CPU/GPU-bound, 60-180s. 180s window.
    // warmup: GPU shader compilation — 30-120s on cold-cache. 180s window.
    // model download: CDN transfer. 60s window — doubled from prior 30s to absorb CDN
    //   inter-shard gaps and the download→model-init transition gap (#1379 Bug 1).
    //   The transition between the last "model" download event and the first "model-init"
    //   event (ORT weight loading) can exceed 30s on some systems; 60s tolerates this
    //   without masking a genuine stall.
    const watchdogMs = (d.phase === 'model-init' || d.phase === 'warmup') ? 180_000 : 60_000;
    if (!_firstLoadingReceived && _loadedBytes > 0) {
      _firstLoadingReceived = true;
      if (_watchdogId !== null) { clearTimeout(_watchdogId); _watchdogId = null; }
      _watchdogId = setTimeout(_showStalled, watchdogMs);
    } else if (_firstLoadingReceived) {
      if (_watchdogId !== null) { clearTimeout(_watchdogId); _watchdogId = null; }
      _watchdogId = setTimeout(_showStalled, watchdogMs);
    }
    _updateProgress();
  });

  window.addEventListener('agentmodel:drafter:loading', (ev: Event) => {
    const d = (ev as CustomEvent<{
      bytes?: number; total?: number; throughputBytesPerSec?: number;
    }>).detail ?? {};
    const prevLoaded = _loadedBytes;
    if ((d.bytes ?? 0) > 0) _loadedBytes = Math.max(_loadedBytes, (_totalBytes * 0.85) + (d.bytes! * 0.15));
    if (d.throughputBytesPerSec) _throughput = d.throughputBytesPerSec;
    _currentFile = 'drafter';
    _traceEvent('drafter:loading', { bytes: d.bytes, total: d.total });
    _recoverFromStall();
    // Also slide the watchdog window on drafter progress (drafter = active connection).
    if (_loadedBytes > prevLoaded) {
      if (_watchdogId !== null) { clearTimeout(_watchdogId); _watchdogId = null; }
      _watchdogId = setTimeout(_showStalled, 30_000);
    }
    _updateProgress();
  });

  window.addEventListener('agentmodel:returning-user', () => {
    _traceEvent('returning-user');
    _onReturningUser();
  }, { once: true });
  window.addEventListener('agentmodel:boot-complete', () => {
    _traceEvent('boot-complete');
    // returning-user path installs its own boot-complete listener with READY_HOLD_MS delay;
    // calling _onDone() here would bypass that hold and fade the overlay immediately.
    if (!_isReturningUser) _onDone();
  }, { once: true });
  window.addEventListener('agentmodel:error', (ev: Event) => {
    _traceEvent('error');
    _onError(ev);
  }, { once: true });
}

// ---------------------------------------------------------------------------
// rAF loop

function _tick(): void {
  if (_done || !_headPath) return;
  const elapsed = (performance.now() - _startTime) % LOOP_MS;
  const pct = elapsed / LOOP_MS;
  // Traveling head: offset sweeps 0 → -(pathLen) then wraps
  _headPath.style.strokeDashoffset = `${-(_pathLen * pct)}`;
  _rafId = requestAnimationFrame(_tick);
}

// ---------------------------------------------------------------------------
// Progress display

function _updateProgress(): void {
  if (_done || !_pctEl) return;
  const pct = _totalBytes > 0 ? Math.min((_loadedBytes / _totalBytes) * 100, 99) : 0;
  _pctEl.textContent = pct > 0 ? `${Math.round(pct)}%` : '';
  if (_barFill) _barFill.style.width = `${pct}%`;

  // Hide first-visit hint once loading starts
  if (pct > 0 && _hintEl) _hintEl.style.opacity = '0';

  // File label (basename only)
  if (_fileEl) {
    const base = _currentFile ? _currentFile.split('/').pop() ?? _currentFile : '';
    _fileEl.textContent = base;
  }

  // ETA
  if (_etaEl) {
    const remainingBytes = _totalBytes - _loadedBytes;
    if (_throughput > 0 && remainingBytes > 0) {
      const secs = Math.ceil(remainingBytes / _throughput);
      _etaEl.textContent = `~${secs}s remaining`;
    } else {
      _etaEl.textContent = '';
    }
  }
}

// ---------------------------------------------------------------------------
// Completion handlers

function _onReturningUser(): void {
  if (_done) return;
  _isReturningUser = true;
  cancelAnimationFrame(_rafId);
  // Snap the head to full coverage, show READY pulse
  if (_headPath) {
    _headPath.style.strokeDasharray = `${_pathLen}`;
    _headPath.style.strokeDashoffset = '0';
    _headPath.setAttribute('opacity', '1');
  }
  if (_pctEl) { _pctEl.textContent = '100%'; _pctEl.style.color = '#6ef2b0'; }
  if (_barFill) { _barFill.style.width = '100%'; _barFill.style.background = '#6ef2b0'; }
  if (_fileEl) _fileEl.textContent = '';
  if (_etaEl) _etaEl.textContent = '';
  if (_hintEl) _hintEl.style.display = 'none';
  if (_statusEl) {
    _statusEl.textContent = 'READY';
    _statusEl.style.color = '#6ef2b0';
    _statusEl.style.display = 'block';
  }
  // Wait for boot-complete before dismissing the overlay. returning-user fires when
  // cached weights are *detected* in Cache API, not when the model is loaded into the
  // ORT/WebGPU runtime — dismissing here causes "Model is still loading" on first prompt.
  // boot-complete fires after model-ready + warmup-done + drafter-done, so inference is
  // guaranteed usable when the overlay fades.
  window.addEventListener('agentmodel:boot-complete', () => {
    setTimeout(_onDone, READY_HOLD_MS);
  }, { once: true });
}

function _onDone(): void {
  if (_done) return;
  _done = true;
  if (_watchdogId !== null) { clearTimeout(_watchdogId); _watchdogId = null; }
  cancelAnimationFrame(_rafId);
  if (!_overlay) return;
  _overlay.style.transition = `opacity ${FADE_MS}ms ease`;
  _overlay.style.opacity = '0';
  setTimeout(() => {
    _overlay?.remove();
    _overlay = null;
    const shell = document.getElementById('app-shell');
    if (shell) shell.style.pointerEvents = '';
  }, FADE_MS + 50);
}

function _onError(ev: Event): void {
  if (_done) return;
  _done = true;
  if (_watchdogId !== null) { clearTimeout(_watchdogId); _watchdogId = null; }
  cancelAnimationFrame(_rafId);
  if (!_overlay) return;
  const detail = (ev as CustomEvent).detail;
  const msg = typeof detail === 'string' ? detail
    : (typeof detail?.message === 'string' ? detail.message : 'Model failed to load');
  const url: string = detail && typeof detail === 'object' && typeof detail.url === 'string'
    ? detail.url : '';
  if (_statusEl) {
    Object.assign(_statusEl.style, {
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      gap: '6px',
      color: '#ff4040',
    });
    const errorLine = document.createElement('div');
    errorLine.textContent = `ERROR: ${msg}`;
    _statusEl.appendChild(errorLine);
    if (url) {
      const urlLine = document.createElement('div');
      urlLine.style.cssText = 'font-size:8px;opacity:.55;word-break:break-all;max-width:min(78vw,580px);text-align:center;';
      urlLine.textContent = url;
      _statusEl.appendChild(urlLine);
    }
    const retryBtn = document.createElement('button');
    retryBtn.textContent = 'Retry';
    retryBtn.style.cssText = 'margin-top:2px;padding:4px 14px;border:1px solid rgba(255,64,64,.4);border-radius:4px;background:transparent;color:#ff4040;font:10px monospace;cursor:pointer;letter-spacing:.06em;';
    retryBtn.addEventListener('click', () => { window.location.reload(); });
    _statusEl.appendChild(retryBtn);
  }
  if (_pctEl) _pctEl.textContent = '';
  if (_fileEl) _fileEl.textContent = '';
  if (_etaEl) _etaEl.textContent = '';
  if (_hintEl) _hintEl.style.display = 'none';
}

// ---------------------------------------------------------------------------
// DOM construction

function _buildOverlay(): void {
  const overlay = document.createElement('div');
  overlay.id = 'boot-screen';
  overlay.setAttribute('aria-label', 'Loading Gemma-CAD');
  overlay.setAttribute('aria-live', 'polite');
  Object.assign(overlay.style, {
    position: 'fixed',
    inset: '0',
    zIndex: '9999',
    background: '#0d0d0d',
    overflow: 'hidden',
    userSelect: 'none',
    fontFamily: '"JetBrains Mono", "Fira Mono", monospace',
  });
  _overlay = overlay;

  // Block the underlying shell from receiving interaction
  const shell = document.getElementById('app-shell');
  if (shell) shell.style.pointerEvents = 'none';

  // --- Ghost UI SVG — fills the entire viewport ---
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  const vw = window.innerWidth, vh = window.innerHeight;
  svg.setAttribute('viewBox', `0 0 ${vw} ${vh}`);
  // preserveAspectRatio=none: stretch to fill viewport so fixed-pixel layout rows/cols align
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('aria-hidden', 'true');
  Object.assign(svg.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  });

  const ghostPath = _ghostPathData(vw, vh);

  // Dim static outline (structural shape reference)
  const dimPath = document.createElementNS(svgNS, 'path');
  dimPath.setAttribute('d', ghostPath);
  dimPath.setAttribute('fill', 'none');
  dimPath.setAttribute('stroke', '#222222');
  dimPath.setAttribute('stroke-width', '0.5');
  dimPath.setAttribute('vector-effect', 'non-scaling-stroke');
  dimPath.setAttribute('stroke-linecap', 'square');
  svg.appendChild(dimPath);

  // Animated traveling head
  const headPath = document.createElementNS(svgNS, 'path');
  headPath.setAttribute('d', ghostPath);
  headPath.setAttribute('fill', 'none');
  headPath.setAttribute('stroke', '#4ca6ff');
  headPath.setAttribute('stroke-width', '0.8');
  headPath.setAttribute('vector-effect', 'non-scaling-stroke');
  headPath.setAttribute('stroke-linecap', 'round');
  headPath.setAttribute('opacity', '0.9');
  svg.appendChild(headPath);
  _headPath = headPath;

  overlay.appendChild(svg);
  document.body.appendChild(overlay);

  // Measure after DOM insertion
  const totalLen = dimPath.getTotalLength();
  _pathLen = totalLen || 1;
  _headDashLen = _pathLen * 0.10;
  headPath.style.strokeDasharray = `${_headDashLen} ${_pathLen - _headDashLen}`;
  headPath.style.strokeDashoffset = '0';

  // --- Progress section — absolute positioned at bottom ---
  const progress = document.createElement('div');
  Object.assign(progress.style, {
    position: 'absolute',
    bottom: '0',
    left: '0',
    right: '0',
    padding: 'clamp(12px, 2vh, 28px) clamp(20px, 4vw, 60px)',
    display: 'flex',
    flexDirection: 'column',
    gap: 'clamp(4px, 0.6vh, 8px)',
    background: 'linear-gradient(transparent, rgba(13,13,13,0.95) 30%)',
  });

  // Product name
  const logo = document.createElement('div');
  logo.textContent = 'GEMMA-CAD';
  Object.assign(logo.style, {
    color: '#555',
    fontSize: 'clamp(10px, 1.2vw, 16px)',
    letterSpacing: '0.4em',
    marginBottom: 'clamp(2px, 0.4vh, 6px)',
  });
  progress.appendChild(logo);

  // First-visit hint (hides once progress starts or on returning user)
  const hintEl = document.createElement('div');
  hintEl.textContent = 'Loading neural model (~2 GB) — first visit only';
  Object.assign(hintEl.style, {
    color: '#383838',
    fontSize: 'clamp(9px, 1.0vw, 13px)',
    letterSpacing: '0.05em',
    transition: 'opacity 0.5s',
    marginBottom: 'clamp(4px, 0.6vh, 8px)',
  });
  _hintEl = hintEl;
  progress.appendChild(hintEl);

  // Progress bar
  const barWrap = document.createElement('div');
  Object.assign(barWrap.style, {
    width: '100%',
    height: 'clamp(2px, 0.3vh, 4px)',
    background: '#1a1a1a',
    borderRadius: '2px',
    overflow: 'hidden',
  });
  const barFill = document.createElement('div');
  Object.assign(barFill.style, {
    height: '100%',
    background: '#4ca6ff',
    width: '0%',
    transition: 'width 0.4s ease',
    borderRadius: '2px',
  });
  barWrap.appendChild(barFill);
  progress.appendChild(barWrap);
  _barFill = barFill;

  // Pct + file row
  const row = document.createElement('div');
  Object.assign(row.style, {
    display: 'flex',
    justifyContent: 'space-between',
    width: '100%',
    fontSize: 'clamp(9px, 0.9vw, 12px)',
    letterSpacing: '0.06em',
    marginTop: 'clamp(2px, 0.3vh, 4px)',
  });

  const pctEl = document.createElement('span');
  Object.assign(pctEl.style, { color: '#4ca6ff' });
  _pctEl = pctEl;
  row.appendChild(pctEl);

  const fileEl = document.createElement('span');
  Object.assign(fileEl.style, {
    color: '#333',
    maxWidth: '60%',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    textAlign: 'right',
  });
  _fileEl = fileEl;
  row.appendChild(fileEl);

  progress.appendChild(row);

  const etaEl = document.createElement('span');
  Object.assign(etaEl.style, {
    color: '#2a2a2a',
    fontSize: 'clamp(9px, 0.8vw, 11px)',
    letterSpacing: '0.05em',
    alignSelf: 'flex-start',
  });
  _etaEl = etaEl;
  progress.appendChild(etaEl);

  // Status line (hidden by default; shown on READY or ERROR)
  const statusEl = document.createElement('div');
  Object.assign(statusEl.style, {
    display: 'none',
    fontSize: 'clamp(10px, 1.0vw, 14px)',
    letterSpacing: '0.2em',
    marginTop: 'clamp(2px, 0.4vh, 6px)',
  });
  _statusEl = statusEl;
  progress.appendChild(statusEl);

  overlay.appendChild(progress);
}

// ---------------------------------------------------------------------------
// Ghost UI path data — viewport-aware pixel coordinates.
//
// CSS fixed row heights (grid-template-rows: 24px 30px 90px 1fr 22px):
//   menubar=24, modebar=30, ribbon=90, statusbar=22
// CSS fixed col widths (--palette-w: 80px, --sidebar-w default 320px):
//   palette=80, sidebar=320
//
// Uses actual vw×vh so the SVG (viewBox=0 0 vw vh, preserveAspectRatio=none)
// aligns with the real shell at any viewport size.

function _ghostPathData(vw: number, vh: number): string {
  const segs: string[] = [];
  const r = (n: number) => Math.round(n);  // round to integer pixel

  // ── Layout boundaries (actual pixels) ──
  const menuH = 24, modeH = 30, ribH = 90, statH = 22;
  const palW = 80;
  const sideW = 320; // --sidebar-w default; approximation for animation
  const y1 = menuH;               // menubar bottom = 24
  const y2 = menuH + modeH;       // modebar bottom = 54
  const y3 = menuH + modeH + ribH;// ribbon bottom = 144
  const y4 = vh - statH;          // statusbar top = vh-22
  const x1 = palW;                // palette right = 80
  const x2 = vw - sideW;         // sidebar left = vw-320

  // ── Chrome borders ──
  segs.push(`M0 ${y1} H${vw}`);          // menubar bottom
  segs.push(`M0 ${y2} H${vw}`);          // modebar bottom
  segs.push(`M0 ${y3} H${vw}`);          // ribbon bottom
  segs.push(`M${x1} ${y3} V${y4}`);      // palette right edge
  segs.push(`M${x2} ${y3} V${y4}`);      // sidebar left edge
  segs.push(`M0 ${y4} H${vw}`);          // statusbar top

  // ── Menubar: app name + menu items (midpoint y ≈ 12) ──
  const myM = Math.round(menuH / 2);
  segs.push(`M12 ${myM-4} H80`);         // app name/logo
  segs.push(`M90 ${myM-4} H130`);        // menu items
  segs.push(`M${vw-120} ${myM-3} H${vw-80}`);
  segs.push(`M${vw-75} ${myM-3} H${vw-20}`);

  // ── Modebar: mode tabs (inner y y1+4 to y2-4) ──
  // Three tabs: MODEL / LAYOUT / RESEARCH, each ~116px wide
  const mt1 = y1 + 4, mt2 = y2 - 4;
  const tabW = 116;
  segs.push(`M0 ${mt1} H${tabW} V${mt2} H0 Z`);              // MODEL
  segs.push(`M${tabW} ${mt1} H${tabW*2} V${mt2} H${tabW} Z`); // LAYOUT
  segs.push(`M${tabW*2} ${mt1} H${tabW*3} V${mt2} H${tabW*2} Z`); // RESEARCH
  // modebar-meta cluster (right side)
  segs.push(`M${vw-240} ${y1+9} H${vw-20}`);

  // ── Ribbon: tool button clusters (inner y y2+8 to y3-8) ──
  const RY1 = y2 + 8, RY2 = y3 - 8;
  const BW = 22, BSP = 2, GSEP = 8; // button 20px + 2×1px margin, group separator 8px
  let bx = 4;
  const btn = (x: number) => segs.push(`M${x} ${RY1} H${x+BW} V${RY2} H${x} Z`);
  const sep = (x: number) => segs.push(`M${x} ${RY1} V${RY2}`);
  // Group 1: Select/Move/Rotate (3)
  btn(bx); bx += BW+BSP; btn(bx); bx += BW+BSP; btn(bx); bx += BW+GSEP; sep(bx);
  // Group 2: Wall/Floor/Roof/Column/Beam (5)
  bx += 4; btn(bx); bx += BW+BSP; btn(bx); bx += BW+BSP; btn(bx); bx += BW+BSP;
  btn(bx); bx += BW+BSP; btn(bx); bx += BW+GSEP; sep(bx);
  // Group 3: Door/Window/Stair/Ramp (4)
  bx += 4; btn(bx); bx += BW+BSP; btn(bx); bx += BW+BSP; btn(bx); bx += BW+BSP; btn(bx); bx += BW+GSEP; sep(bx);
  // Group 4: Line/Polyline/Arc (3)
  bx += 4; btn(bx); bx += BW+BSP; btn(bx); bx += BW+BSP; btn(bx); bx += BW+GSEP; sep(bx);
  // Group 5: Extrude/Boolean (2)
  bx += 4; btn(bx); bx += BW+BSP; btn(bx); bx += BW+GSEP;
  // Render mode block
  segs.push(`M${bx+4} ${RY1} H${bx+70} V${RY2} H${bx+4} Z`);
  // Right-side display controls (in sidebar region — ribbon spans full width)
  const rx = x2 + 4;
  btn(rx); btn(rx+BW+BSP); btn(rx+2*(BW+BSP)); btn(rx+3*(BW+BSP));
  segs.push(`M${rx+4*(BW+BSP)+8} ${RY1} H${vw-8} V${RY2} H${rx+4*(BW+BSP)+8} Z`);

  // ── Palette: 2 col × 8 row icon grid (x 0–80, y y3–y4) ──
  // Icon cells: ~36px wide × 28px tall, 2 cols, rows start at y3+8
  const ICON_W = 34, ICON_H = 26, ICON_SX = 4, ICON_SY = 8, ICON_GAP = 4;
  const colX = [ICON_SX, ICON_SX + ICON_W + ICON_GAP];
  for (let row = 0; row < 8; row++) {
    for (let col = 0; col < 2; col++) {
      const px = colX[col], py = y3 + ICON_SY + row * (ICON_H + ICON_GAP);
      if (py + ICON_H > y4 - 4) break;
      segs.push(`M${px} ${py} H${px+ICON_W} V${py+ICON_H} H${px} Z`);
    }
  }
  // Section label dividers
  const dY1 = y3 + ICON_SY + 3*(ICON_H+ICON_GAP) + ICON_H + 2;
  segs.push(`M4 ${dY1} H${palW-4}`);
  segs.push(`M4 ${dY1 + 30} H${palW-4}`);
  segs.push(`M4 ${dY1 + 60} H${palW-4}`);

  // ── Viewport: floor plan schematic (x x1–x2, y y3–y4) ──
  // Scale floor plan outline proportionally within the viewport region
  const vpW = x2 - x1, vpH = y4 - y3;
  const fpX1 = r(x1 + vpW*0.10), fpX2 = r(x1 + vpW*0.88);
  const fpY1 = r(y3 + vpH*0.12), fpY2 = r(y3 + vpH*0.92);
  const fpW = fpX2 - fpX1, fpH = fpY2 - fpY1;
  segs.push(`M${fpX1} ${fpY1} H${fpX2} V${fpY2} H${fpX1} Z`); // building outline
  // Interior walls (proportional)
  const hmid = r(fpY1 + fpH*0.38);
  const hlow = r(fpY1 + fpH*0.58);
  const vleft = r(fpX1 + fpW*0.48);
  const vright1 = r(fpX1 + fpW*0.67);
  const vright2 = r(fpX1 + fpW*0.31);
  segs.push(`M${fpX1} ${hmid} H${vright1}`);
  segs.push(`M${fpX1} ${hlow} H${vleft}`);
  segs.push(`M${vleft} ${fpY1} V${hmid}`);
  segs.push(`M${vright1} ${hmid} V${fpY2}`);
  segs.push(`M${vright2} ${hmid} V${fpY2}`);
  // Compass (top-right of viewport area)
  const cpx = r(x2 - vpW*0.04), cpy = r(y3 + vpH*0.06);
  segs.push(`M${cpx} ${cpy-16} L${cpx} ${cpy+16}`);
  segs.push(`M${cpx} ${cpy-16} L${cpx-10} ${cpy+4}`);
  segs.push(`M${cpx} ${cpy-16} L${cpx+10} ${cpy+4}`);

  // ── Sidebar: header + 3 tabs + property rows (x x2–vw) ──
  const sx = x2 + 8, sw = vw - 8;
  segs.push(`M${sx} ${y3+8} H${sw} V${y3+28} H${sx} Z`); // header
  const tabH2 = 16, tabW2 = r((vw - x2 - 16) / 3);
  for (let t = 0; t < 3; t++) {
    const tx = sx + t*tabW2;
    segs.push(`M${tx} ${y3+30} H${tx+tabW2-4} V${y3+30+tabH2} H${tx} Z`);
  }
  const rowStep = Math.min(36, Math.floor((y4 - (y3+50)) / 10));
  for (let i = 0; i < 10; i++) {
    const ry = y3 + 50 + i * rowStep;
    if (ry + rowStep > y4 - 4) break;
    segs.push(`M${sx} ${ry} H${r(sx + (vw-x2)*0.50)}`);
    segs.push(`M${sx} ${ry+rowStep-4} H${sw}`);
  }

  // ── Statusbar: indicator segments (midpoint y ≈ y4 + statH/2) ──
  const sy = y4 + Math.round(statH / 2);
  segs.push(`M12 ${sy-3} H${r(vw*0.18)}`);
  segs.push(`M${r(vw*0.20)} ${sy-3} H${r(vw*0.35)}`);
  segs.push(`M${r(vw*0.37)} ${sy-3} H${r(vw*0.50)}`);
  segs.push(`M${r(vw*0.75)} ${sy-3} H${r(vw*0.88)}`);
  segs.push(`M${r(vw*0.90)} ${sy-3} H${r(vw-12)}`);

  return segs.join(' ');
}
