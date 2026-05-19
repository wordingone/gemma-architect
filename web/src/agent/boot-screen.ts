// boot-screen.ts — Full-viewport loading screen (#938).
// Blocks all underlying UI interaction until agentmodel:boot-complete fires.
// Supersedes loading-anim.ts chrome-edge overlay.

const LOOP_MS = 6_000;          // one travel-head cycle
const FADE_MS = 200;             // fade-out duration on completion
const READY_HOLD_MS = 1_200;     // returning-user: hold READY pulse before fade

let _initialized = false;
let _done = false;

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

let _pathLen = 0;
let _headDashLen = 0;
let _startTime = 0;
let _rafId = 0;

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
  });

  window.addEventListener('agentmodel:loading', (ev: Event) => {
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
  if (_statusEl) {
    _statusEl.textContent = 'READY';
    _statusEl.style.color = '#6ef2b0';
  }
  setTimeout(_onDone, READY_HOLD_MS);
}

function _onDone(): void {
  if (_done) return;
  _done = true;
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
  cancelAnimationFrame(_rafId);
  if (!_overlay) return;
  const detail = (ev as CustomEvent).detail;
  const msg = typeof detail === 'string' ? detail : 'Model failed to load. Try refreshing.';
  if (_statusEl) {
    _statusEl.textContent = `ERROR: ${msg}`;
    _statusEl.style.color = '#ff4040';
    _statusEl.style.display = 'block';
  }
  if (_pctEl) _pctEl.textContent = '';
  if (_fileEl) _fileEl.textContent = '';
  if (_etaEl) _etaEl.textContent = '';
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
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: '16px',
    fontFamily: '"JetBrains Mono", "Fira Mono", monospace',
    userSelect: 'none',
    // pointer-events is auto (default) — blocks all click-through to the shell
  });
  _overlay = overlay;

  // Block the underlying shell from receiving interaction
  const shell = document.getElementById('app-shell');
  if (shell) shell.style.pointerEvents = 'none';

  // --- Ghost UI SVG ---
  const svgNS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(svgNS, 'svg');
  svg.setAttribute('viewBox', '0 0 160 90');
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
  svg.setAttribute('aria-hidden', 'true');
  Object.assign(svg.style, {
    width: 'min(78vw, 620px)',
    height: 'auto',
    pointerEvents: 'none',
  });

  const ghostPath = _ghostPathData();

  // Dim static outline (structural shape reference)
  const dimPath = document.createElementNS(svgNS, 'path');
  dimPath.setAttribute('d', ghostPath);
  dimPath.setAttribute('fill', 'none');
  dimPath.setAttribute('stroke', '#1e1e1e');
  dimPath.setAttribute('stroke-width', '0.35');
  dimPath.setAttribute('stroke-linecap', 'square');
  svg.appendChild(dimPath);

  // Animated traveling head
  const headPath = document.createElementNS(svgNS, 'path');
  headPath.setAttribute('d', ghostPath);
  headPath.setAttribute('fill', 'none');
  headPath.setAttribute('stroke', '#4ca6ff');
  headPath.setAttribute('stroke-width', '0.55');
  headPath.setAttribute('stroke-linecap', 'round');
  headPath.setAttribute('opacity', '0.75');
  svg.appendChild(headPath);
  _headPath = headPath;

  overlay.appendChild(svg);
  document.body.appendChild(overlay);

  // Measure after DOM insertion
  const totalLen = dimPath.getTotalLength();
  _pathLen = totalLen || 1;
  _headDashLen = _pathLen * 0.12;
  headPath.style.strokeDasharray = `${_headDashLen} ${_pathLen - _headDashLen}`;
  headPath.style.strokeDashoffset = '0';

  // --- Progress section ---
  const progress = document.createElement('div');
  Object.assign(progress.style, {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    gap: '5px',
    width: 'min(78vw, 620px)',
  });

  // Product name
  const logo = document.createElement('div');
  logo.textContent = 'GEMMA-CAD';
  Object.assign(logo.style, {
    color: '#444',
    fontSize: '11px',
    letterSpacing: '0.35em',
    marginBottom: '4px',
  });
  progress.appendChild(logo);

  // Progress bar
  const barWrap = document.createElement('div');
  Object.assign(barWrap.style, {
    width: '100%',
    height: '1px',
    background: '#1a1a1a',
    borderRadius: '1px',
    overflow: 'hidden',
  });
  const barFill = document.createElement('div');
  Object.assign(barFill.style, {
    height: '100%',
    background: '#4ca6ff',
    width: '0%',
    transition: 'width 0.4s ease',
    borderRadius: '1px',
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
    fontSize: '9px',
    letterSpacing: '0.06em',
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
  Object.assign(etaEl.style, { color: '#2a2a2a', fontSize: '9px', letterSpacing: '0.05em', alignSelf: 'flex-start' });
  _etaEl = etaEl;
  progress.appendChild(etaEl);

  // Status line (hidden by default; shown on READY or ERROR)
  const statusEl = document.createElement('div');
  Object.assign(statusEl.style, {
    display: 'none',
    fontSize: '10px',
    letterSpacing: '0.2em',
    marginTop: '4px',
  });
  _statusEl = statusEl;
  progress.appendChild(statusEl);

  overlay.appendChild(progress);
}

// ---------------------------------------------------------------------------
// Ghost UI path data (viewBox 0 0 160 90)
//
// Layout proportions:
//   menubar:   y 0-5   (full width)
//   ribbon:    y 5-13  (full width)
//   palette:   x 0-22, y 13-86
//   viewport:  x 22-123, y 13-86
//   sidebar:   x 123-160, y 13-86
//   statusbar: y 86-90 (full width)

function _ghostPathData(): string {
  const segs: string[] = [];

  // Chrome dividers
  segs.push('M0 5 H160');        // menubar bottom
  segs.push('M0 13 H160');       // ribbon bottom
  segs.push('M22 13 V86');       // palette right edge
  segs.push('M123 13 V86');      // sidebar left edge
  segs.push('M0 86 H160');       // statusbar top

  // Ribbon content: 3 tab groups
  segs.push('M3 6 H28 V12 H3 Z');
  segs.push('M30 6 H55 V12 H30 Z');
  segs.push('M57 6 H75 V12 H57 Z');

  // Viewport frame
  segs.push('M22 13 H123 V86 H22 Z');

  // Architectural floor plan in viewport
  // Outer room boundary
  segs.push('M35 22 H110 V80 H35 Z');
  // Horizontal room divider
  segs.push('M35 52 H110');
  // Vertical dividers
  segs.push('M72 22 V52');
  segs.push('M88 52 V80');
  // Door openings (gaps in walls — short marks)
  segs.push('M72 36 L72 42');    // door gap marker
  segs.push('M56 52 L63 52');    // door gap marker

  // Palette: tool button grid (3 cols × 4 rows)
  for (let row = 0; row < 4; row++) {
    for (let col = 0; col < 3; col++) {
      const x = 1.5 + col * 6.8;
      const y = 15.5 + row * 6.5;
      segs.push(`M${x.toFixed(1)} ${y.toFixed(1)} H${(x + 5.3).toFixed(1)} V${(y + 5).toFixed(1)} H${x.toFixed(1)} Z`);
    }
  }

  // Sidebar: property label rows
  for (let i = 0; i < 6; i++) {
    const y = 17 + i * 7;
    segs.push(`M125 ${y} H157`);
    segs.push(`M125 ${(y + 3).toFixed(1)} H148`);
  }

  // Statusbar: indicator segments
  segs.push('M2 88 H30');
  segs.push('M32 88 H55');
  segs.push('M125 88 H158');

  return segs.join(' ');
}
