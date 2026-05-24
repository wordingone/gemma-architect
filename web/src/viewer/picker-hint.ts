// Picker prompt, chooser overlay, op-hover highlight — extracted from create-mode.ts (#723).

import * as THREE from "three";
import { provideSessionChoice } from "../commands/command-session";
import type { ChoiceOption } from "../commands/dictionary";

let _pickerPromptEl: HTMLElement | null = null;
let _chooserEl: HTMLElement | null = null;

// Op tools are handled by the opPhase state machine, not the click-to-place pipeline.
export const OP_TOOL_IDS = new Set([
  "extrude", "loft", "boolean", "fillet",
  "aligned-dim", "angular-dim", "area-dim", "volume-dim",
  "label", "transient-measure",
  "sel-window", "sel-lasso", "sel-boundary",
  "copy", "array",
]);

export function initPickerHint(vpBody: HTMLElement): void {
  _pickerPromptEl = document.createElement("div");
  _pickerPromptEl.className = "picker-prompt";
  vpBody.appendChild(_pickerPromptEl);

  _chooserEl = document.createElement("div");
  _chooserEl.className = "chooser-overlay";
  vpBody.appendChild(_chooserEl);
}

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

export function getChooserEl(): HTMLElement | null {
  return _chooserEl;
}

// Sub-tool override: set when a wall sub-tool (wall-polyline, wall-curve, wall-pick) is active.
// These have no dedicated palette button so the DOM query below would return null without this.
let _subToolOverride: string | null = null;
export function setSubToolOverride(id: string | null): void { _subToolOverride = id; }

// Reads the active palette tool ID, returns null for select/transform/op tools.
export function readActiveTool(): string | null {
  if (_subToolOverride) return _subToolOverride;
  const btn = document.querySelector<HTMLElement>(".palette-btn.active");
  const id = btn?.dataset.tool ?? null;
  if (!id || id === "select" || id === "move" || id === "rotate" || id === "scale" || id === "scale-1d" || id === "scale-2d") return null;
  if (OP_TOOL_IDS.has(id)) return null;
  return id;
}

// Object hovered during an op-tool select phase.
let _opHoverObj: THREE.Object3D | null = null;
let _opHoverSavedEmissive: number | null = null;
// #953: per-child saved emissives when hovered object is a Group (e.g. roof).
let _opHoverGroupSaved: { mesh: THREE.Mesh; emissive: number }[] | null = null;
const HOVER_THIN_COLOR  = 0x44aaff;
const HOVER_MESH_EMIT   = 0x1a5f8a; // bright enough to show on grey/cream surfaces

export function opSetHover(obj: THREE.Object3D | null): void {
  if (_opHoverObj === obj) return;
  // Restore previous hover.
  if (_opHoverObj) {
    if (_opHoverGroupSaved) {
      for (const { mesh, emissive } of _opHoverGroupSaved) {
        const m = mesh.material as THREE.MeshStandardMaterial;
        if (m?.emissive) m.emissive.setHex(emissive);
      }
      _opHoverGroupSaved = null;
    } else if (_opHoverSavedEmissive !== null) {
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
  }
  _opHoverObj = obj;
  if (obj) {
    if (obj instanceof THREE.Group) {
      // #953: highlight all child meshes as one unit (e.g. roof group).
      _opHoverGroupSaved = [];
      obj.traverse((child) => {
        if (!(child instanceof THREE.Mesh)) return;
        const m = child.material as THREE.MeshStandardMaterial;
        if (m?.emissive) {
          _opHoverGroupSaved!.push({ mesh: child, emissive: m.emissive.getHex() });
          m.emissive.setHex(HOVER_MESH_EMIT);
        }
      });
    } else if (obj instanceof THREE.Line) {
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
