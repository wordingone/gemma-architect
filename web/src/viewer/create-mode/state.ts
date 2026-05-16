// State — module-level variables, picker/chooser UI, opSetHover, readActiveTool.
// Consumed by all other create-mode sub-modules.

import * as THREE from "three";
import type { Viewer } from "../viewer";
import { provideSessionChoice } from "../../commands/command-session";
import type { ChoiceOption } from "../../commands/dictionary";

// ─── Constants ────────────────────────────────────────────────────────────────

export const DEFAULT_WALL_HEIGHT = 3;
export const DEFAULT_WALL_THICKNESS = 0.2;
export const DEFAULT_SLAB_THICKNESS = 0.2;
export const DEFAULT_COLUMN_HEIGHT = 4;
export const DEFAULT_RECT_HEIGHT = 2.8;
export const DEFAULT_DOOR_W = 0.9;
export const DEFAULT_DOOR_H = 2.1;
export const DEFAULT_WINDOW_W = 1.2;
export const DEFAULT_WINDOW_H = 1.4;
export const DEFAULT_WINDOW_SILL = 1.0;
export const DEFAULT_STAIR_RISE = 0.18;
export const DEFAULT_STAIR_TREAD = 0.28;
export const DEFAULT_STAIR_WIDTH = 1.0;
export const DEFAULT_POLYGON_SIDES = 6;
export const DEFAULT_EXTRUDE_HEIGHT = 2.5;
export const DEFAULT_BEAM_SIZE = 0.2;
export const DEFAULT_FOUNDATION_T = 0.5;
export const DEFAULT_CEILING_T = 0.05;
export const DEFAULT_RAMP_WIDTH = 1.2;
export const DEFAULT_RAILING_H = 1.0;

// ─── Construction sequence ────────────────────────────────────────────────────

const _createSequence: string[] = [];

export function getCreateSequence(): string[] {
  return [..._createSequence];
}

export function clearCreateSequence(): void {
  _createSequence.length = 0;
}

export function pushToCreateSequence(chain: string): void {
  _createSequence.push(chain);
}

// ─── Pending click buffer ─────────────────────────────────────────────────────

export let _pending: Array<{ x: number; y: number; z?: number }> = [];

export function shiftAxisSnap(
  base: { x: number; y: number },
  cur: { x: number; y: number },
  step: number,
): { x: number; y: number } {
  const dx = cur.x - base.x;
  const dy = cur.y - base.y;
  if (Math.abs(dx) >= Math.abs(dy)) {
    return { x: base.x + Math.round(dx / step) * step, y: base.y };
  } else {
    return { x: base.x, y: base.y + Math.round(dy / step) * step };
  }
}

export let _lastPointerClient: { x: number; y: number } = { x: 0, y: 0 };
export let _lastCreateClickTs = 0;
export let _lastCreateClickX = 0;
export let _lastCreateClickY = 0;

// Temporary scene objects.
export let _previewMesh: THREE.Mesh | null = null;
export let _markerMesh: THREE.Points | null = null;
export let _sketchShiftAxisLine: THREE.Line | null = null;
export let _cursorDot: HTMLElement | null = null;

// Smart-track.
export const SMART_TRACK_MS = 750;
export let _smartTrackPt: { x: number; y: number } | null = null;
export let _smartTrackTimer: ReturnType<typeof setTimeout> | null = null;
export let _smartTrackCandidate: { x: number; y: number; id: string } | null = null;
export let _smartTrackMarker: THREE.Mesh | null = null;

export let _shiftAxisChoice: "x" | "y" | "z" | null = null;

// Viewer reference.
export let _viewer: Viewer | null = null;

// ─── Setters for mutable exports ──────────────────────────────────────────────

export function setPending(v: Array<{ x: number; y: number; z?: number }>): void { _pending = v; }
export function setLastPointerClient(v: { x: number; y: number }): void { _lastPointerClient = v; }
export function setLastCreateClickTs(v: number): void { _lastCreateClickTs = v; }
export function setLastCreateClickX(v: number): void { _lastCreateClickX = v; }
export function setLastCreateClickY(v: number): void { _lastCreateClickY = v; }
export function setPreviewMesh(v: THREE.Mesh | null): void { _previewMesh = v; }
export function setMarkerMesh(v: THREE.Points | null): void { _markerMesh = v; }
export function setSketchShiftAxisLine(v: THREE.Line | null): void { _sketchShiftAxisLine = v; }
export function setCursorDot(v: HTMLElement | null): void { _cursorDot = v; }
export function setSmartTrackPtVar(v: { x: number; y: number } | null): void { _smartTrackPt = v; }
export function setSmartTrackTimer(v: ReturnType<typeof setTimeout> | null): void { _smartTrackTimer = v; }
export function setSmartTrackCandidate(v: { x: number; y: number; id: string } | null): void { _smartTrackCandidate = v; }
export function setSmartTrackMarker(v: THREE.Mesh | null): void { _smartTrackMarker = v; }
export function setShiftAxisChoice(v: "x" | "y" | "z" | null): void { _shiftAxisChoice = v; }
export function setViewerRef(v: Viewer | null): void { _viewer = v; }

// ─── Selection-mode state ─────────────────────────────────────────────────────

export let _selOverlaySvg: SVGSVGElement | null = null;
export let _selDragging = false;
export let _rawChooserDefault: (() => void) | null = null;
export let _multiSelHighlighted: THREE.Object3D[] = [];
export let _selHLOwned = false;

export let _pickerPromptEl: HTMLElement | null = null;
export let _chooserEl: HTMLElement | null = null;

export function setSelOverlaySvg(v: SVGSVGElement | null): void { _selOverlaySvg = v; }
export function setSelDragging(v: boolean): void { _selDragging = v; }
export function setRawChooserDefault(v: (() => void) | null): void { _rawChooserDefault = v; }
export function setMultiSelHighlighted(v: THREE.Object3D[]): void { _multiSelHighlighted = v; }
export function setSelHLOwned(v: boolean): void { _selHLOwned = v; }
export function setPickerPromptEl(v: HTMLElement | null): void { _pickerPromptEl = v; }
export function setChooserElVar(v: HTMLElement | null): void { _chooserEl = v; }

// ─── Op-tool state ────────────────────────────────────────────────────────────

export const OP_TOOL_IDS = new Set([
  "extrude", "boolean", "fillet", "aligned-dim", "angular-dim",
  "area-dim", "volume-dim", "label", "transient-measure",
  "sel-window", "sel-lasso", "sel-boundary",
]);

export const EXTRUDABLE_CREATORS = new Set([
  "rect", "circle", "polygon", "polyline", "curve", "line",
  "wall", "slab", "column", "box", "beam", "roof", "space",
]);

// Object hovered during an op-tool select phase.
let _opHoverObj: THREE.Object3D | null = null;
let _opHoverSavedEmissive: number | null = null;
export const HOVER_THIN_COLOR  = 0x44aaff;
export const HOVER_MESH_EMIT   = 0x334455;

export function opSetHover(obj: THREE.Object3D | null): void {
  if (_opHoverObj === obj) return;
  if (_opHoverObj && _opHoverSavedEmissive !== null) {
    if (_opHoverObj instanceof THREE.Line) {
      (_opHoverObj.material as THREE.LineBasicMaterial).color.setHex(_opHoverSavedEmissive);
    } else if (_opHoverObj instanceof THREE.Points) {
      (_opHoverObj.material as THREE.PointsMaterial).color.setHex(_opHoverSavedEmissive);
    } else if (_opHoverObj instanceof THREE.Mesh) {
      const m = (_opHoverObj.material as THREE.MeshStandardMaterial);
      if (m?.emissive) m.emissive.setHex(_opHoverSavedEmissive);
    }
    _opHoverSavedEmissive = null;
  }
  _opHoverObj = obj;
  if (obj) {
    if (obj instanceof THREE.Line) {
      const lm = obj.material as THREE.LineBasicMaterial;
      _opHoverSavedEmissive = lm.color.getHex();
      lm.color.setHex(HOVER_THIN_COLOR);
    } else if (obj instanceof THREE.Points) {
      const pm = obj.material as THREE.PointsMaterial;
      _opHoverSavedEmissive = pm.color.getHex();
      pm.color.setHex(HOVER_THIN_COLOR);
    } else if (obj instanceof THREE.Mesh) {
      const m = obj.material as THREE.MeshStandardMaterial;
      if (m?.emissive) {
        _opHoverSavedEmissive = m.emissive.getHex();
        m.emissive.setHex(HOVER_MESH_EMIT);
      }
    }
  }
}

export function readActiveTool(): string | null {
  const btn = document.querySelector<HTMLElement>(".palette-btn.active");
  const id = btn?.dataset.tool ?? null;
  if (!id || id === "select" || id === "move" || id === "rotate" || id === "scale" || id === "scale-1d" || id === "scale-2d") return null;
  if (OP_TOOL_IDS.has(id)) return null;
  return id;
}

// ─── Picker / Chooser UI ──────────────────────────────────────────────────────

export function setPickerHint(msg: string | null): void {
  if (!_pickerPromptEl) return;
  if (msg) {
    _pickerPromptEl.textContent = msg;
    _pickerPromptEl.classList.add("visible");
  } else {
    _pickerPromptEl.classList.remove("visible");
  }
}

export function setChooserHint(choice: { arg: string; options: ChoiceOption[] } | null): void {
  if (!_chooserEl) return;
  if (!choice) {
    _chooserEl.classList.remove("visible");
    _chooserEl.innerHTML = "";
    return;
  }
  _chooserEl.innerHTML = "";
  const label = document.createElement("div");
  label.className = "chooser-label";
  label.textContent = `Choose ${choice.arg}:`;
  _chooserEl.appendChild(label);
  for (const opt of choice.options) {
    const chip = document.createElement("button");
    chip.className = "chooser-chip";
    chip.textContent = opt.label;
    chip.title = opt.description;
    chip.addEventListener("click", () => {
      void provideSessionChoice(opt.value).then((result) => {
        if (result.status === "needs_choice" && result.awaiting_text_choice) {
          setChooserHint(result.awaiting_text_choice);
        } else {
          setChooserHint(null);
          setPickerHint(result.status === "needs_input" ? (result.summary ?? null) : null);
        }
      });
    });
    _chooserEl.appendChild(chip);
  }
  _chooserEl.classList.add("visible");
}
