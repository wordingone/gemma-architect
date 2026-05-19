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
// Event wiring

function _wireEvents(): void {
  window.addEventListener('agentmodel:manifest', (ev: Event) => {
    const detail = (ev as CustomEvent<{ totalBytesExpected?: number }>).detail;
    if (detail?.totalBytesExpected) _totalBytes = detail.totalBytesExpected;
    _watchdogId = setTimeout(() => {
      if (_done || _loadedBytes > 0) return;
      if (_statusEl) {
        _statusEl.style.color = '#ff9900';
        _statusEl.style.display = 'block';
        _statusEl.textContent = 'DOWNLOAD STALLED — check your connection and refresh';
      }
    }, 60_000);
  });

  window.addEventListener('agentmodel:loading', (ev: Event) => {
    if (_watchdogId !== null) { clearTimeout(_watchdogId); _watchdogId = null; }
    const d = (ev as CustomEvent<{
      bytes?: number; total?: number; throughputBytesPerSec?: number; file?: string;
    }>).detail ?? {};
    if ((d.bytes ?? 0) > 0) _loadedBytes = Math.max(_loadedBytes, d.bytes!);
    if (d.throughputBytesPerSec) _throughput = d.throughputBytesPerSec;
    if (d.file) _currentFile = d.file;
    if (!_totalBytes && d.total) _totalBytes = d.total;
    _updateProgress();
  });

  window.addEventListener('agentmodel:drafter:loading', (ev: Event) => {
    const d = (ev as CustomEvent<{
      bytes?: number; total?: number; throughputBytesPerSec?: number;
    }>).detail ?? {};
    if ((d.bytes ?? 0) > 0) _loadedBytes = Math.max(_loadedBytes, (_totalBytes * 0.85) + (d.bytes! * 0.15));
    if (d.throughputBytesPerSec) _throughput = d.throughputBytesPerSec;
    _currentFile = 'drafter';
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
//   menubar:   y 0-5   (full width, with app name + menu items)
//   ribbon:    y 5-14  (full width, tool groups with buttons)
//   palette:   x 0-20, y 14-87  (tool palette, icon grid)
//   viewport:  x 20-122, y 14-87 (3D canvas with architectural content)
//   sidebar:   x 122-160, y 14-87 (inspector panel, property rows)
//   statusbar: y 87-90 (full width, snap + unit indicators)

function _ghostPathData(): string {
  const segs: string[] = [];

  // ── Chrome dividers ──
  segs.push('M0 5 H160');         // menubar bottom
  segs.push('M0 14 H160');        // ribbon bottom
  segs.push('M20 14 V87');        // palette right edge
  segs.push('M122 14 V87');       // sidebar left edge
  segs.push('M0 87 H160');        // statusbar top

  // ── Menubar: app name + menu words ──
  segs.push('M2 1.5 H14');        // app name block
  segs.push('M16 1.5 H22');       // File menu word
  segs.push('M24 1.5 H30');       // Edit
  segs.push('M32 1.5 H40');       // View
  segs.push('M42 1.5 H50');       // Insert
  segs.push('M52 1.5 H58');       // Help

  // ── Ribbon: 5 tool groups with button clusters ──
  // Group 1: Select/Navigate (3 buttons)
  segs.push('M2 6 H5 V13 H2 Z');
  segs.push('M6 6 H9 V13 H6 Z');
  segs.push('M10 6 H13 V13 H10 Z');
  // Group divider
  segs.push('M14.5 6 V13');
  // Group 2: Draw (5 buttons)
  segs.push('M16 6 H19 V13 H16 Z');
  segs.push('M20 6 H23 V13 H20 Z');
  segs.push('M24 6 H27 V13 H24 Z');
  segs.push('M28 6 H31 V13 H28 Z');
  segs.push('M32 6 H35 V13 H32 Z');
  // Group divider
  segs.push('M36.5 6 V13');
  // Group 3: Model ops (4 buttons)
  segs.push('M38 6 H41 V13 H38 Z');
  segs.push('M42 6 H45 V13 H42 Z');
  segs.push('M46 6 H49 V13 H46 Z');
  segs.push('M50 6 H53 V13 H50 Z');
  // Group divider
  segs.push('M54.5 6 V13');
  // Group 4: Annotate (3 buttons)
  segs.push('M56 6 H59 V13 H56 Z');
  segs.push('M60 6 H63 V13 H60 Z');
  segs.push('M64 6 H67 V13 H64 Z');
  // Group divider
  segs.push('M68.5 6 V13');
  // Group 5: Layers/Scenes (3 buttons)
  segs.push('M70 6 H73 V13 H70 Z');
  segs.push('M74 6 H77 V13 H74 Z');
  segs.push('M78 6 H81 V13 H78 Z');
  // Right side: render mode + viewport controls
  segs.push('M110 6 H120 V13 H110 Z');  // render mode button
  segs.push('M121 6 H124 V13 H121 Z');
  segs.push('M125 6 H128 V13 H125 Z');
  segs.push('M129 6 H132 V13 H129 Z');
  segs.push('M133 6 H136 V13 H133 Z');
  segs.push('M147 6 H160 V13 H147 Z');  // viewport tabs area

  // ── Palette: 4-col × 7-row icon grid ──
  for (let row = 0; row < 7; row++) {
    for (let col = 0; col < 4; col++) {
      const x = 0.8 + col * 4.8;
      const y = 16 + row * 5.2;
      segs.push(`M${x.toFixed(1)} ${y.toFixed(1)} H${(x + 3.8).toFixed(1)} V${(y + 4.2).toFixed(1)} H${x.toFixed(1)} Z`);
    }
  }
  // Section label rows in palette
  segs.push('M0.5 57 H19');
  segs.push('M0.5 63.5 H19');
  segs.push('M0.5 70 H19');
  segs.push('M0.5 76.5 H19');

  // ── Viewport: architectural floor plan content ──
  // Outer building boundary
  segs.push('M30 22 H112 V82 H30 Z');
  // Primary room dividers (horizontal)
  segs.push('M30 48 H90');
  segs.push('M30 65 H70');
  // Primary room dividers (vertical)
  segs.push('M65 22 V48');
  segs.push('M82 48 V82');
  segs.push('M50 48 V82');
  // Door openings (arc indicators)
  segs.push('M65 34 L65 40');
  segs.push('M47 48 L53 48');
  segs.push('M30 56 L30 62');
  // Window hash marks on exterior wall
  segs.push('M45 22 L45 23');   segs.push('M48 22 L48 23');  // N facade
  segs.push('M75 22 L75 23');   segs.push('M90 22 L90 23');
  segs.push('M112 35 L111 35'); segs.push('M112 55 L111 55'); // E facade
  segs.push('M60 82 L60 81');   segs.push('M95 82 L95 81');  // S facade
  // Stair block
  segs.push('M95 22 H112 V38 H95 Z');
  segs.push('M97 24 H110'); segs.push('M97 26.5 H110'); segs.push('M97 29 H110');
  segs.push('M97 31.5 H110'); segs.push('M97 34 H110'); segs.push('M97 36.5 H110');
  // Furniture: desk in top-left room
  segs.push('M35 25 H58 V38 H35 Z');
  segs.push('M37 27 H45 V36 H37 Z');
  // Furniture: table in bottom room
  segs.push('M35 52 H65 V62 H35 Z');
  // Grid accent lines (light)
  segs.push('M20 25 H122');    // major grid line
  segs.push('M20 42 H122');
  segs.push('M20 59 H122');
  segs.push('M20 76 H122');
  segs.push('M40 14 V87');
  segs.push('M60 14 V87');
  segs.push('M80 14 V87');
  segs.push('M100 14 V87');

  // Compass rose (top-right of viewport)
  segs.push('M116 17 L116 20');  // N
  segs.push('M116 17 L114.5 19'); segs.push('M116 17 L117.5 19');  // N arrow

  // ── Sidebar: inspector panel ──
  // Panel header
  segs.push('M123 15 H159 V19 H123 Z');
  // Tabs
  segs.push('M124 20 H137 V22 H124 Z');
  segs.push('M138 20 H151 V22 H138 Z');
  segs.push('M152 20 H159 V22 H152 Z');
  // Property row groups (label + value pairs)
  for (let i = 0; i < 9; i++) {
    const y = 24 + i * 7;
    segs.push(`M125 ${y} H145`);            // property label
    segs.push(`M125 ${(y + 3).toFixed(1)} H157`); // value bar (longer)
  }
  // Vector diagram placeholder (node graph area)
  segs.push('M124 89 H159');  // bottom section divider
  segs.push('M124 91 H159');
  segs.push('M124 93 H151');

  // ── Statusbar: indicator segments ──
  segs.push('M2 88.5 H28');   // snap indicator
  segs.push('M30 88.5 H50');  // units indicator
  segs.push('M52 88.5 H72');  // coordinates
  segs.push('M120 88.5 H140'); // layer
  segs.push('M142 88.5 H158'); // render mode

  return segs.join(' ');
}
