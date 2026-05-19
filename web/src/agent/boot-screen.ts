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
  dimPath.setAttribute('stroke', '#1e1e1e');
  dimPath.setAttribute('stroke-width', '0.3');
  dimPath.setAttribute('stroke-linecap', 'square');
  svg.appendChild(dimPath);

  // Animated traveling head
  const headPath = document.createElementNS(svgNS, 'path');
  headPath.setAttribute('d', ghostPath);
  headPath.setAttribute('fill', 'none');
  headPath.setAttribute('stroke', '#4ca6ff');
  headPath.setAttribute('stroke-width', '0.5');
  headPath.setAttribute('stroke-linecap', 'round');
  headPath.setAttribute('opacity', '0.8');
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
// Layout proportions mirror actual Gemma-CAD chrome:
//   menubar:   y 0-2   (thin bar, app name + menu items)
//   ribbon:    y 2-8   (tool groups; buttons span y 2.8-7.2, leaving margins)
//   palette:   x 0-16, y 8-87  (4 col × 6 row icon grid, 3.2×2.8 each)
//   viewport:  x 16-122, y 8-87 (floor plan; no grid lines to avoid overlap)
//   sidebar:   x 122-160, y 8-87 (tabs + property rows)
//   statusbar: y 87-90

function _ghostPathData(): string {
  const segs: string[] = [];

  // ── Chrome structure ──
  segs.push('M0 2 H160');      // menubar bottom
  segs.push('M0 8 H160');      // ribbon bottom
  segs.push('M16 8 V87');      // palette right edge
  segs.push('M122 8 V87');     // sidebar left edge
  segs.push('M0 87 H160');     // statusbar top

  // ── Menubar: short word-width blocks ──
  segs.push('M2 1 H11');
  segs.push('M13 1 H17');
  segs.push('M19 1 H23');
  segs.push('M25 1 H31');
  segs.push('M33 1 H37');

  // ── Ribbon: buttons occupy y=2.8–7.2 (4.4 units = ~37px at full HD) ──
  // Each button: 3.5 wide. Step 4.2. Groups separated by thin line.
  const BY1 = 2.8, BY2 = 7.2, BW = 3.5;
  function btn(x: number) { segs.push(`M${x} ${BY1} H${x+BW} V${BY2} H${x} Z`); }
  function sep(x: number) { segs.push(`M${x} ${BY1} V${BY2}`); }

  // Group 1 (3)
  btn(1.0); btn(5.2); btn(9.4); sep(13.8);
  // Group 2 (5)
  btn(14.3); btn(18.5); btn(22.7); btn(26.9); btn(31.1); sep(35.5);
  // Group 3 (4)
  btn(36.0); btn(40.2); btn(44.4); btn(48.6); sep(53.0);
  // Group 4 (3)
  btn(53.5); btn(57.7); btn(61.9); sep(66.3);
  // Group 5 (2)
  btn(66.8); btn(71.0);
  // Right: render-mode + 4 small + viewport tabs
  segs.push(`M107 ${BY1} H121 V${BY2} H107 Z`);
  btn(122.0); btn(126.2); btn(130.4); btn(134.6);
  segs.push(`M150 ${BY1} H160 V${BY2} H150 Z`);

  // ── Palette: 4 col × 6 row icon grid ──
  // Icon: 3.2 wide × 2.8 tall. Col step 3.8, row step 3.3. Start (0.4, 9.2)
  for (let r = 0; r < 6; r++) {
    for (let c = 0; c < 4; c++) {
      const x = +(0.4 + c * 3.8).toFixed(1);
      const y = +(9.2 + r * 3.3).toFixed(1);
      segs.push(`M${x} ${y} H${+(x+3.2).toFixed(1)} V${+(y+2.8).toFixed(1)} H${x} Z`);
    }
  }
  // Three section dividers below icon grid (~y 29)
  segs.push('M0.5 30 H15.5');
  segs.push('M0.5 34.5 H15.5');
  segs.push('M0.5 39 H15.5');

  // ── Viewport: clean floor-plan (no grid — avoids overlap clutter) ──
  // Building boundary
  segs.push('M26 17 H114 V83 H26 Z');
  // Room dividers
  segs.push('M26 46 H88');
  segs.push('M26 63 H67');
  segs.push('M63 17 V46');
  segs.push('M80 46 V83');
  segs.push('M47 46 V83');
  // Door-opening gaps
  segs.push('M63 31 L63 38');
  segs.push('M44 46 L50 46');
  // Window ticks on exterior walls
  segs.push('M44 17 V19'); segs.push('M54 17 V19');
  segs.push('M80 17 V19'); segs.push('M96 17 V19');
  segs.push('M114 38 H112'); segs.push('M114 57 H112');
  segs.push('M58 83 V81'); segs.push('M75 83 V81');
  // Stair block
  segs.push('M91 17 H114 V35 H91 Z');
  segs.push('M93 19 H112'); segs.push('M93 21.5 H112'); segs.push('M93 24 H112');
  segs.push('M93 26.5 H112'); segs.push('M93 29 H112'); segs.push('M93 31.5 H112');
  // Furniture
  segs.push('M30 20 H60 V34 H30 Z');
  segs.push('M32 22 H42 V32 H32 Z');
  segs.push('M30 49 H62 V61 H30 Z');
  // Compass (top-right viewport corner)
  segs.push('M118 11 L118 15');
  segs.push('M118 11 L116.5 13.5'); segs.push('M118 11 L119.5 13.5');

  // ── Sidebar: header + 3 tabs + 10 property rows ──
  segs.push('M123 9 H159 V13 H123 Z');
  segs.push('M124 13.5 H136 V15.5 H124 Z');
  segs.push('M137 13.5 H149 V15.5 H137 Z');
  segs.push('M150 13.5 H158 V15.5 H150 Z');
  for (let i = 0; i < 10; i++) {
    const y = +(17 + i * 6.8).toFixed(1);
    segs.push(`M125 ${y} H143`);
    segs.push(`M125 ${+(+y + 3.2).toFixed(1)} H158`);
  }

  // ── Statusbar: 5 indicator segments ──
  segs.push('M2 88.5 H28');
  segs.push('M30 88.5 H50');
  segs.push('M52 88.5 H72');
  segs.push('M120 88.5 H140');
  segs.push('M142 88.5 H158');

  return segs.join(' ');
}
