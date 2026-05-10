// Snap / constrain state singleton.
// Driven by the snap-dock widget in workbench.ts; consumed by create-mode.ts
// (sketch-click quantising) and viewer.ts (gumball drag quantising).

import { gridStore } from "../grids";

export interface SnapState {
  snapOn: boolean;       // master toggle — when off, all other snap flags inert
  orthoOn: boolean;      // axis-only constraint (gumball already does this per-handle)
  gridOn: boolean;       // translate snaps to grid step
  polarOn: boolean;      // rotate snaps to angleStep
  vertexSnapOn: boolean; // gumball relocate snaps to host vertices
  edgeSnapOn: boolean;   // gumball relocate snaps to host edge endpoints + midpoints
  step: number;          // grid step in meters
  angleStep: number;     // polar snap in degrees
}

const _state: SnapState = {
  snapOn: true, orthoOn: true, gridOn: true, polarOn: true,
  vertexSnapOn: true, edgeSnapOn: true,
  step: 1.0, angleStep: 90,
};

export function getSnap(): Readonly<SnapState> { return _state; }
export function getGridOn(): boolean { return _state.gridOn; }

// Subscribers re-render dependent UI / scene helpers when snap state
// changes. The viewer listens to redraw the grid at the new step; the
// statusbar listens to mirror the visible value.
type Listener = (s: Readonly<SnapState>) => void;
const _listeners = new Set<Listener>();
export function subscribeSnap(fn: Listener): () => void {
  _listeners.add(fn);
  return () => _listeners.delete(fn);
}
function emit(): void {
  for (const fn of _listeners) fn(_state);
}

export function setGridOn(on: boolean): void { _state.gridOn = on; emit(); }
export function setSnapOn(on: boolean): void { _state.snapOn = on; emit(); }
export function setOrthoOn(on: boolean): void { _state.orthoOn = on; emit(); }
export function setPolarOn(on: boolean): void { _state.polarOn = on; emit(); }
export function setVertexSnapOn(on: boolean): void { _state.vertexSnapOn = on; emit(); }
export function setEdgeSnapOn(on: boolean): void { _state.edgeSnapOn = on; emit(); }
export function getStep(): number { return _state.step; }
export function setStep(m: number): void { _state.step = Math.max(0.001, m); emit(); }
export function getAngleStep(): number { return _state.angleStep; }
export function setAngleStep(deg: number): void { _state.angleStep = Math.max(0.1, deg); emit(); }

// Quantise a world-space XY point.
// When master snap + grid both on: snaps to the active GridStore grid's
// intersection; falls back to the fixed step when no active grid exists.
// Applies grid origin offset and rotation. Snap radius ~0.15 m.
export function snapPoint(x: number, y: number): { x: number; y: number } {
  if (_state.snapOn && _state.gridOn) {
    const activeGrid = gridStore.getActive();
    // User step always governs precision; active grid provides origin/rotation frame only.
    const s = _state.step;

    if (activeGrid && activeGrid.visible) {
      // Transform point into grid-local space (subtract origin, un-rotate).
      const ox = activeGrid.origin[0], oy = activeGrid.origin[1];
      const cos = Math.cos(-activeGrid.rotation), sin = Math.sin(-activeGrid.rotation);
      const lx = (x - ox) * cos - (y - oy) * sin;
      const ly = (x - ox) * sin + (y - oy) * cos;
      // Snap in grid-local space.
      const snappedLx = Math.round(lx / s) * s;
      const snappedLy = Math.round(ly / s) * s;
      // Transform back to world space.
      const cos2 = Math.cos(activeGrid.rotation), sin2 = Math.sin(activeGrid.rotation);
      return {
        x: ox + snappedLx * cos2 - snappedLy * sin2,
        y: oy + snappedLx * sin2 + snappedLy * cos2,
      };
    }

    return { x: Math.round(x / s) * s, y: Math.round(y / s) * s };
  }
  return { x: Math.round(x * 1000) / 1000, y: Math.round(y * 1000) / 1000 };
}
