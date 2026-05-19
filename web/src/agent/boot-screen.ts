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
let _loadedBytes = 0;            // cumulative from loading events
let _throughput = 0;             // bytes/sec (last reported)
let _currentFile = '';

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

function _showStalled(): void {
  if (_done) return;
  _watchdogId = null;
  if (_statusEl) {
    _statusEl.style.color = '#ff9900';
    _statusEl.style.display = 'block';
    _statusEl.textContent = 'DOWNLOAD STALLED — check your connection and refresh';
  }
}

// ---------------------------------------------------------------------------
// Event wiring

function _wireEvents(): void {
  window.addEventListener('agentmodel:manifest', (ev: Event) => {
    const detail = (ev as CustomEvent<{ totalBytesExpected?: number }>).detail;
    if (detail?.totalBytesExpected) _totalBytes = detail.totalBytesExpected;
    // Initial grace: 90s from manifest to first byte (covers CDN warmup + redirect chain).
    _watchdogId = setTimeout(_showStalled, 90_000);
  });

  window.addEventListener('agentmodel:loading', (ev: Event) => {
    const d = (ev as CustomEvent<{
      bytes?: number; total?: number; throughputBytesPerSec?: number; file?: string;
    }>).detail ?? {};
    const prevLoaded = _loadedBytes;
    if ((d.bytes ?? 0) > 0) _loadedBytes = Math.max(_loadedBytes, d.bytes!);
    if (d.throughputBytesPerSec) _throughput = d.throughputBytesPerSec;
    if (d.file) _currentFile = d.file;
    if (!_totalBytes && d.total) _totalBytes = d.total;
    // Sliding-window: on first loading event switch from 90s initial grace to 30s window;
    // reset the 30s timer on each event with real byte progress.
    if (!_firstLoadingReceived) {
      _firstLoadingReceived = true;
      if (_watchdogId !== null) { clearTimeout(_watchdogId); _watchdogId = null; }
      _watchdogId = setTimeout(_showStalled, 30_000);
    } else if (_loadedBytes > prevLoaded) {
      if (_watchdogId !== null) { clearTimeout(_watchdogId); _watchdogId = null; }
      _watchdogId = setTimeout(_showStalled, 30_000);
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
    // Also slide the watchdog window on drafter progress (drafter = active connection).
    if (_loadedBytes > prevLoaded) {
      if (_watchdogId !== null) { clearTimeout(_watchdogId); _watchdogId = null; }
      _watchdogId = setTimeout(_showStalled, 30_000);
    }
    _updateProgress();
  });

  window.addEventListener('agentmodel:returning-user', _onReturningUser, { once: true });
  window.addEventListener('agentmodel:boot-complete', _onDone, { once: true });
  window.addEventListener('agentmodel:error', _onError, { once: true });
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
  setTimeout(_onDone, READY_HOLD_MS);
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
  svg.setAttribute('viewBox', '0 0 160 90');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');
  Object.assign(svg.style, {
    position: 'absolute',
    top: '0',
    left: '0',
    width: '100%',
    height: '100%',
    pointerEvents: 'none',
  });

  const ghostPath = _ghostPathData();

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
// Ghost UI path data (viewBox 0 0 160 90)
//
// Layout proportions derived from actual shell.css / tokens.css:
//   grid-template-rows: 24px 30px 90px 1fr 22px
//   --palette-w: 80px  --sidebar-w: 320px
//
// At 1366×768 reference: 1px ≈ 0.1171 SVG units
//   menubar:   y 0–2.8    (24px)
//   modebar:   y 2.8–6.3  (30px) — view presets: PERSPECTIVE / TOP / FRONT / RIGHT
//   ribbon:    y 6.3–16.9 (90px) — tool buttons (inner y 7.4–15.8)
//   palette:   x 0–9.4    (80px) — 2 col × 8 row icon grid
//   viewport:  x 9.4–122.5         — floor plan
//   sidebar:   x 122.5–160 (320px) — property panel
//   statusbar: y 87.4–90  (22px)

function _ghostPathData(): string {
  const segs: string[] = [];

  // ── Chrome borders ──
  segs.push('M0 2.8 H160');          // menubar bottom
  segs.push('M0 6.3 H160');          // modebar bottom
  segs.push('M0 16.9 H160');         // ribbon bottom
  segs.push('M9.4 16.9 V87.4');      // palette right edge
  segs.push('M122.5 16.9 V87.4');    // sidebar left edge
  segs.push('M0 87.4 H160');         // statusbar top

  // ── Menubar: app name + menu items (midpoint y≈1.4) ──
  segs.push('M1.5 0.7 H9');
  segs.push('M11 0.7 H16');
  segs.push('M18 0.7 H23');
  segs.push('M25 0.7 H31');
  segs.push('M33 0.7 H37');
  segs.push('M148 0.5 H153');
  segs.push('M154.5 0.5 H159');

  // ── Modebar: view preset buttons (inner y 3.2–5.9) ──
  segs.push('M9 3.2 H24 V5.9 H9 Z');           // PERSPECTIVE
  segs.push('M25.5 3.2 H35 V5.9 H25.5 Z');     // TOP
  segs.push('M36.5 3.2 H47 V5.9 H36.5 Z');     // FRONT
  segs.push('M48.5 3.2 H58 V5.9 H48.5 Z');     // RIGHT
  segs.push('M59.5 3.2 H68 V5.9 H59.5 Z');     // LEFT
  segs.push('M146 3.2 H151 V5.9 H146 Z');      // zoom fit
  segs.push('M152 3.2 H157 V5.9 H152 Z');      // zoom controls
  segs.push('M158 3.2 H160 V5.9 H158 Z');

  // ── Ribbon: tool buttons (inner y 7.4–15.8, h≈8.4u) ──
  // BW=5.5u (47px), step=6.2u. Groups separated by 1.4u gap.
  const BY1 = 7.4, BY2 = 15.8, BW = 5.5;
  function btn(x: number) {
    const r = (n: number) => +n.toFixed(1);
    segs.push(`M${r(x)} ${BY1} H${r(x+BW)} V${BY2} H${r(x)} Z`);
  }
  function sep(x: number) { segs.push(`M${+x.toFixed(1)} ${BY1} V${BY2}`); }

  // Group 1: Select/Move/Rotate (3)
  btn(0.5); btn(6.7); btn(12.9); sep(20.2);
  // Group 2: Wall/Floor/Roof/Column/Beam (5)
  btn(20.7); btn(26.9); btn(33.1); btn(39.3); btn(45.5); sep(52.8);
  // Group 3: Door/Window/Stair/Ramp (4)
  btn(53.3); btn(59.5); btn(65.7); btn(71.9); sep(79.2);
  // Group 4: Line/Polyline/Arc (3)
  btn(79.7); btn(85.9); btn(92.1); sep(99.4);
  // Group 5: Extrude/Boolean (2)
  btn(99.9); btn(106.1);
  // Render mode block
  segs.push(`M109 ${BY1} H121 V${BY2} H109 Z`);
  // Right-side display controls (in sidebar column — ribbon spans full width)
  btn(123.5); btn(129.7); btn(135.9); btn(142.1);
  segs.push(`M150 ${BY1} H159 V${BY2} H150 Z`);

  // ── Palette: 2 col × 8 row icon grid (x 0–9.4, y 16.9–87.4) ──
  // Icon 3.8w × 3.2h. Cols at x=0.4, x=5.0. Row step 3.7. Start y=18.0
  for (let r = 0; r < 8; r++) {
    for (let c = 0; c < 2; c++) {
      const x = +(0.4 + c * 4.6).toFixed(1);
      const y = +(18.0 + r * 3.7).toFixed(1);
      segs.push(`M${x} ${y} H${+(x+3.8).toFixed(1)} V${+(y+3.0).toFixed(1)} H${x} Z`);
    }
  }
  // Section label dividers below icon grid
  segs.push('M0.4 48.0 H9.0');
  segs.push('M0.4 52.5 H9.0');
  segs.push('M0.4 57.0 H9.0');

  // ── Viewport: floor plan (x 9.4–122.5, y 16.9–87.4) ──
  // Building outline (with viewport margin)
  segs.push('M22 25 H114 V82 H22 Z');
  // Interior walls
  segs.push('M22 52 H86');       // main horizontal division
  segs.push('M22 66 H65');       // lower horizontal
  segs.push('M62 25 V52');       // left vertical
  segs.push('M79 52 V82');       // lower-right vertical
  segs.push('M46 52 V82');       // lower-left vertical
  // Door gaps
  segs.push('M62 34 L62 41');
  segs.push('M43 52 L50 52');
  // Window ticks on exterior
  segs.push('M42 25 V27'); segs.push('M53 25 V27');
  segs.push('M79 25 V27'); segs.push('M95 25 V27');
  segs.push('M114 41 H112'); segs.push('M114 60 H112');
  segs.push('M56 82 V80'); segs.push('M72 82 V80');
  // Stair block
  segs.push('M91 25 H114 V42 H91 Z');
  segs.push('M93 27 H112'); segs.push('M93 29.5 H112'); segs.push('M93 32 H112');
  segs.push('M93 34.5 H112'); segs.push('M93 37 H112');
  // Furniture
  segs.push('M28 28 H58 V42 H28 Z');
  segs.push('M30 30 H40 V40 H30 Z');
  segs.push('M28 55 H60 V66 H28 Z');
  // Compass (top-right corner of viewport area)
  segs.push('M118 19 L118 23');
  segs.push('M118 19 L116.5 21.5'); segs.push('M118 19 L119.5 21.5');

  // ── Sidebar: header + 3 tabs + 10 property rows (x 122.5–160) ──
  segs.push('M123.5 18 H159 V22 H123.5 Z');
  segs.push('M124.5 22.5 H136 V24.5 H124.5 Z');
  segs.push('M137 22.5 H149 V24.5 H137 Z');
  segs.push('M150 22.5 H158.5 V24.5 H150 Z');
  for (let i = 0; i < 10; i++) {
    const y = +(26 + i * 6.0).toFixed(1);
    segs.push(`M125.5 ${y} H143`);
    segs.push(`M125.5 ${+(+y + 3.0).toFixed(1)} H158.5`);
  }

  // ── Statusbar: 5 indicator segments (midpoint y≈88.7) ──
  segs.push('M2 88.7 H28');
  segs.push('M30 88.7 H50');
  segs.push('M52 88.7 H72');
  segs.push('M120 88.7 H140');
  segs.push('M142 88.7 H158');

  return segs.join(' ');
}
