// Scene-helpers — temporary scene object management (markers, previews, cursor dot, rubber-band).

import * as THREE from "three";
import type { Viewer } from "../viewer";
import {
  _markerMesh, setMarkerMesh,
  _previewMesh, setPreviewMesh,
  _sketchShiftAxisLine, setSketchShiftAxisLine,
  _cursorDot, setCursorDot,
  _smartTrackPt, _smartTrackTimer, _smartTrackMarker,
  setSmartTrackPtVar, setSmartTrackTimer, setSmartTrackMarker, setSmartTrackCandidate,
  _pending,
  readActiveTool, setPickerHint, pushToCreateSequence, setPending,
} from "./state";
import { TOOL_HANDLERS, type ToolHandler } from "./builders";
import { pushAction } from "../../history";
import { dispatchSync } from "../../commands/dispatch";

// ─── Marker ───────────────────────────────────────────────────────────────────

export function setMarker(viewer: Viewer, pt: { x: number; y: number }): void {
  clearMarker(viewer);
  const geom = new THREE.BufferGeometry();
  geom.setAttribute("position", new THREE.Float32BufferAttribute([pt.x, pt.y, 0.05], 3));
  const mat = new THREE.PointsMaterial({ size: 8, sizeAttenuation: false, color: 0xff8800, depthTest: false });
  const mesh = new THREE.Points(geom, mat);
  mesh.renderOrder = 999;
  viewer.getScene().add(mesh);
  setMarkerMesh(mesh);
}

export function clearMarker(viewer: Viewer): void {
  if (!_markerMesh) return;
  viewer.getScene().remove(_markerMesh);
  _markerMesh.geometry.dispose();
  (_markerMesh.material as THREE.Material).dispose();
  setMarkerMesh(null);
}

// ─── Preview ──────────────────────────────────────────────────────────────────

export function clearPreview(viewer: Viewer): void {
  if (!_previewMesh) return;
  viewer.getScene().remove(_previewMesh);
  _previewMesh.geometry.dispose();
  const mat = _previewMesh.material;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else (mat as THREE.Material).dispose();
  setPreviewMesh(null);
}

// ─── Sketch-shift axis line ───────────────────────────────────────────────────

export function clearSketchShiftLine(viewer: Viewer): void {
  if (!_sketchShiftAxisLine) return;
  viewer.getScene().remove(_sketchShiftAxisLine);
  _sketchShiftAxisLine.geometry.dispose();
  (_sketchShiftAxisLine.material as THREE.Material).dispose();
  setSketchShiftAxisLine(null);
}

export function updateSketchShiftLine(viewer: Viewer, base: THREE.Vector3, axis: "x" | "y" | "z"): void {
  clearSketchShiftLine(viewer);
  const dir = axis === "x" ? new THREE.Vector3(1, 0, 0) : axis === "y" ? new THREE.Vector3(0, 1, 0) : new THREE.Vector3(0, 0, 1);
  const color = axis === "x" ? 0xff4444 : axis === "y" ? 0x44cc44 : 0x4488ff;
  const geo = new THREE.BufferGeometry().setFromPoints([
    base.clone().addScaledVector(dir, -1000),
    base.clone().addScaledVector(dir, 1000),
  ]);
  const mat = new THREE.LineBasicMaterial({ color, depthTest: false, opacity: 0.5, transparent: true });
  const line = new THREE.Line(geo, mat);
  line.renderOrder = 98;
  line.userData.noSnap = true;
  viewer.getScene().add(line);
  setSketchShiftAxisLine(line);
}

// ─── Smart-track ──────────────────────────────────────────────────────────────

export function setSmartTrackPt(viewer: Viewer, pt: { x: number; y: number } | null): void {
  if (_smartTrackMarker) {
    viewer.getScene().remove(_smartTrackMarker);
    (_smartTrackMarker.geometry as THREE.BufferGeometry).dispose();
    (_smartTrackMarker.material as THREE.Material).dispose();
    setSmartTrackMarker(null);
  }
  setSmartTrackPtVar(pt);
  if (pt) {
    const geo = new THREE.SphereGeometry(0.05, 8, 6);
    const mat = new THREE.MeshBasicMaterial({ color: 0x00ccff, depthTest: false, transparent: true, opacity: 0.85 });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.set(pt.x, pt.y, 0.01);
    mesh.renderOrder = 99;
    mesh.userData.noSnap = true;
    viewer.getScene().add(mesh);
    setSmartTrackMarker(mesh);
  }
}

export function clearSmartTrack(viewer: Viewer): void {
  if (_smartTrackTimer) { clearTimeout(_smartTrackTimer); setSmartTrackTimer(null); }
  setSmartTrackCandidate(null);
  setSmartTrackPt(viewer, null);
}

// ─── Composite clear ──────────────────────────────────────────────────────────

export function clearTemporary(viewer: Viewer): void {
  clearPreview(viewer);
  clearMarker(viewer);
  clearSketchShiftLine(viewer);
}

// ─── Cursor dot ───────────────────────────────────────────────────────────────

export function ensureCursorDot(): HTMLElement {
  if (_cursorDot) return _cursorDot;
  const el = document.createElement("div");
  el.id = "sketch-cursor-dot";
  el.style.cssText = [
    "position:fixed",
    "width:12px",
    "height:12px",
    "border-radius:50%",
    "background:#ffffff",
    "border:2px solid #111111",
    "box-shadow:0 0 0 1px #ffffff",
    "pointer-events:none",
    "display:none",
    "transform:translate(-50%,-50%)",
    "z-index:9999",
  ].join(";");
  document.body.appendChild(el);
  setCursorDot(el);
  return el;
}

export function moveCursorDot(_viewer: Viewer, _pt: { x: number; y: number }, clientX: number, clientY: number, vertexSnap = false): void {
  const dot = ensureCursorDot();
  dot.style.display = "block";
  dot.style.left = clientX + "px";
  dot.style.top = clientY + "px";
  if (vertexSnap) {
    dot.style.background = "#4caf50";
    dot.style.border = "2px solid #1b5e20";
    dot.style.boxShadow = "0 0 0 1px #4caf50,0 0 8px rgba(76,175,80,0.5)";
    dot.style.width = "14px";
    dot.style.height = "14px";
  } else {
    dot.style.background = "#ffffff";
    dot.style.border = "2px solid #111111";
    dot.style.boxShadow = "0 0 0 1px #ffffff";
    dot.style.width = "12px";
    dot.style.height = "12px";
  }
}

export function hideCursorDot(): void {
  if (_cursorDot) _cursorDot.style.display = "none";
}

export function destroyCursorDot(): void {
  if (!_cursorDot) return;
  _cursorDot.remove();
  setCursorDot(null);
}

// ─── Rubber-band preview ──────────────────────────────────────────────────────

export function updateRubberBand(viewer: Viewer, handler: ToolHandler, livePoint: { x: number; y: number; z?: number }): void {
  clearPreview(viewer);
  const isUnlimited = handler.clicks === -1;
  // Fixed-click tools only preview on 1 pending click; unlimited on ≥1.
  if (!isUnlimited && _pending.length !== 1) return;
  if (isUnlimited && _pending.length < 1) return;

  const previewPts = isUnlimited ? [..._pending, livePoint] : [_pending[0], livePoint];

  // Skip degenerate preview (check all three axes so clip tool in ortho elevation views works).
  const last = previewPts[previewPts.length - 1];
  const prev = previewPts[previewPts.length - 2];
  const dx = last.x - prev.x;
  const dy = last.y - prev.y;
  const dz = (last.z ?? 0) - (prev.z ?? 0);
  if (dx * dx + dy * dy + dz * dz < 1e-4) return;

  // Unlimited tools need ≥2 pts to build geometry.
  if (isUnlimited && previewPts.length < 2) return;

  try {
    const out = handler.handler(previewPts);
    const preview = out.mesh;
    // Replace material(s) with a translucent preview version.
    const applyPreviewMat = (m: THREE.Mesh) => {
      const origMat = Array.isArray(m.material) ? m.material[0] : m.material;
      const previewMat = new THREE.MeshStandardMaterial({
        color: (origMat as THREE.MeshStandardMaterial).color?.clone() ?? new THREE.Color(0x888888),
        transparent: true,
        opacity: 0.35,
        depthWrite: false,
        depthTest: false,
      });
      if (Array.isArray(m.material)) m.material.forEach((mat) => mat.dispose());
      else (m.material as THREE.Material).dispose();
      m.material = previewMat;
      m.renderOrder = 1;
    };
    if (preview instanceof THREE.Mesh) {
      applyPreviewMat(preview);
      setPreviewMesh(preview);
    } else {
      // Group (e.g. point) — apply to all mesh children.
      preview.traverse((child) => { if (child instanceof THREE.Mesh) applyPreviewMat(child); });
      setPreviewMesh(preview as unknown as THREE.Mesh);
    }
    // Preview geometry must not become a snap target for its own tool session.
    preview.traverse((c) => { c.userData.noSnap = true; });
    viewer.getScene().add(preview);
  } catch {
    // Degenerate geometry — skip preview
  }
}

// ─── Commit unlimited-click tool (polyline/curve) ─────────────────────────────

export function commitUnlimited(viewer: Viewer): { mesh: THREE.Object3D; chain: string } | null {
  const tool = readActiveTool();
  if (!tool) return null;
  const handler = TOOL_HANDLERS[tool];
  if (!handler || handler.clicks !== -1 || _pending.length < 2) return null;
  clearTemporary(viewer);
  clearSmartTrack(viewer);
  const out = handler.handler(_pending);
  setPending([]);
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "mesh");
  pushToCreateSequence(out.chain);
  pushAction(out.mesh, out.chain);
  hideCursorDot();
  setPickerHint(null);
  dispatchSync("setActiveTool", { toolId: "select" });
  return out;
}
