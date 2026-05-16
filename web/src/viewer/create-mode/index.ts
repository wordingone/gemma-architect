// index.ts — public surface for create-mode.
// Re-exports public API and hosts initCreateMode / emitClickWorld / resetPending.

import * as THREE from "three";
import type { Viewer } from "../viewer";
import { subscribe } from "../../commands/state";
import { dispatchSync } from "../../commands/dispatch";
import { getSnap } from "../snap-state";
import { pushAction } from "../../history";
import { formatLength } from "../../units";
import {
  getActiveCommandSession, provideSessionPick,
  clearCommandSession, commitCommandSession,
} from "../../commands/command-session";
import {
  getSelected, setSelected,
  addToMultiSelected, clearMultiSelected, getMultiSelected,
} from "../selection-state";

// ─── Sub-modules ──────────────────────────────────────────────────────────────

import {
  _pending, setPending,
  _viewer, setViewerRef,
  _shiftAxisChoice, setShiftAxisChoice,
  _lastPointerClient, setLastPointerClient,
  _lastCreateClickTs, setLastCreateClickTs,
  _lastCreateClickX, setLastCreateClickX,
  _lastCreateClickY, setLastCreateClickY,
  _selDragging, setSelDragging,
  _selHLOwned,
  _rawChooserDefault,
  _smartTrackPt, _smartTrackTimer, _smartTrackCandidate, SMART_TRACK_MS,
  setSmartTrackTimer, setSmartTrackCandidate,
  setPickerHint, setChooserHint,
  setPickerPromptEl, setChooserElVar,
  readActiveTool, opSetHover,
  shiftAxisSnap, pushToCreateSequence,
} from "./state";
import {
  _pendingHostId, setPendingHostId,
  getSnapTarget, setSnapTarget,
  HOST_TOOL_CREATORS, findHostMesh,
  nearestSnapVertex, unprojectToAxisLine,
} from "./snap";
import {
  unprojectToXY, unprojectForClipTool, snapWorldForView,
  getGeometryZ, showLevelChip, projectToScreen, screenYtoDz,
} from "./projection";
import {
  _lastSurfaceHit, setLastSnapEdgeDir,
} from "./snap-internal";
import { TOOL_HANDLERS, TOOL_TODOS } from "./builders";
import {
  _ptPhase, setPtPhase,
  _ptCoordInputEl, setPtCoordInputEl,
  _ptCoordWrapEl, setPtCoordWrapEl,
  _ptViewer, setPtViewer,
  _ptInitPos, _ptInitQuat, _ptInitScale,
  _ptAxisLock, setPtAxisLock,
  _lastPtTool,
  ptGetTarget, ptGetAxisBase, ptEffectiveAxisDir, ptPhaseIsObjectSelect,
  ptPrompt, ptClearPrompt, ptShowCoordInput, ptHideCoordInput,
  ptSetAxisLockLine, ptClearAxisLockLine, ptSetPreviewLine,
  ptHandlePoint, ptHandleCoordSubmit, ptHandleEnter,
  ptStartTool, ptCancel,
  ptCommitRotate, ptCommitScale, ptCommitScale1D, ptCommitScale2D,
  registerHideCursorDot,
} from "./precision-transform";
import {
  _opPhase,
  opPhaseIsObjectSelect, opPhaseSupressesSnap,
  opFinish, opCancel,
  opHandleClick, opHandleEnter, opHandleCoordSubmit,
  opRaycastObject, opStartTool,
  getSelOverlay, clearSelOverlay, removeSelOverlay,
  runRectSel, runPolySel,
  opUpdateExtrudePreview,
  registerOpHideCursorDot, registerSelHelpers,
} from "./op-tool";
import {
  setMarker,
  clearTemporary,
  clearSketchShiftLine, updateSketchShiftLine,
  setSmartTrackPt, clearSmartTrack,
  moveCursorDot, hideCursorDot,
  updateRubberBand, commitUnlimited,
} from "./scene-helpers";
import { clearMultiSelHighlights, applyMultiSelHL } from "./select";

// ─── Re-exports (public surface) ──────────────────────────────────────────────

export { setPickerHint, setChooserHint } from "./state";
export { getSnapTarget } from "./snap";
export { getCreateSequence, clearCreateSequence } from "./state";

// ─── Wire up injection hooks (module init) ────────────────────────────────────

registerHideCursorDot(hideCursorDot);
registerOpHideCursorDot(hideCursorDot);
registerSelHelpers(clearMultiSelHighlights, applyMultiSelHL);

// ─── emitClickWorld ───────────────────────────────────────────────────────────

export function emitClickWorld(viewer: Viewer, world: { x: number; y: number; z?: number }, opts?: { tool?: string }): { mesh: THREE.Object3D; chain: string } | null {
  const tool = opts?.tool ?? readActiveTool();
  if (!tool) return null;
  const handler = TOOL_HANDLERS[tool];
  if (!handler) {
    const hint = TOOL_TODOS[tool] ?? "no kernel mapping yet";
    console.log(`[create-mode] tool '${tool}': ${hint}`);
    return null;
  }
  const newPending = [..._pending, world];
  setPending(newPending);
  // Show point marker on first click of multi-click or unlimited tools.
  if (newPending.length === 1 && handler.clicks !== 1) {
    setMarker(viewer, world);
  }
  // Unlimited tools: update hint, never auto-commit; wait for Enter or double-click.
  if (handler.clicks === -1) {
    setPickerHint(`${tool} — ${newPending.length} point${newPending.length > 1 ? "s" : ""}  [double-click, Enter, or Space] commit  [Esc] cancel`);
    return null;
  }
  if (newPending.length < handler.clicks) return null;

  // All clicks collected — build final mesh.
  clearTemporary(viewer);
  clearSmartTrack(viewer);
  const out = handler.handler(newPending);
  setPending([]);
  viewer.addMesh(out.mesh, out.mesh.userData.kind ?? "brep");
  pushToCreateSequence(out.chain);
  pushAction(out.mesh, out.chain);
  if ((out as { dispatchOnCommit?: { verb: string; args: Record<string, unknown> } }).dispatchOnCommit) {
    const d = (out as { dispatchOnCommit: { verb: string; args: Record<string, unknown> } }).dispatchOnCommit;
    dispatchSync(d.verb, d.args);
    document.dispatchEvent(new CustomEvent("viewer:clip-changed"));
  }
  dispatchSync("setActiveTool", { toolId: "select" });

  if (tool === "level") {
    const levelId = (out as { levelId?: string }).levelId;
    if (levelId) showLevelChip(viewer, levelId, _lastPointerClient.x, _lastPointerClient.y);
  }

  return out;
}

// ─── resetPending ─────────────────────────────────────────────────────────────

export function resetPending(): void {
  if (_viewer) { clearTemporary(_viewer); clearSmartTrack(_viewer); }
  hideCursorDot();
  setPickerHint(null);
  setPending([]);
  setShiftAxisChoice(null);
}

// ─── initCreateMode ───────────────────────────────────────────────────────────

export function initCreateMode(viewer: Viewer): void {
  setViewerRef(viewer);
  setPtViewer(viewer);

  const vpBody =
    document.getElementById("viewport-area-host") ??
    document.querySelector<HTMLElement>("#viewport-2 .vp-body") ??
    viewer.getCanvas();

  const pickerPromptEl = document.createElement("div");
  pickerPromptEl.className = "picker-prompt";
  vpBody.appendChild(pickerPromptEl);
  setPickerPromptEl(pickerPromptEl);

  const chooserEl = document.createElement("div");
  chooserEl.className = "chooser-overlay";
  vpBody.appendChild(chooserEl);
  setChooserElVar(chooserEl);

  // Precision transform coord input overlay.
  const ptWrap = document.createElement("div");
  ptWrap.className = "pt-coord-wrap";
  const ptInput = document.createElement("input");
  ptInput.type = "text";
  ptInput.className = "pt-coord-input";
  ptInput.setAttribute("autocomplete", "off");
  ptInput.setAttribute("spellcheck", "false");
  ptWrap.appendChild(ptInput);
  vpBody.appendChild(ptWrap);
  setPtCoordWrapEl(ptWrap);
  setPtCoordInputEl(ptInput);

  ptInput.addEventListener("keydown", (ev) => {
    if (_ptPhase && _ptPhase.kind !== "start" && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey) {
      const k = ev.key.toLowerCase();
      if (k === "x" || k === "y" || k === "z") {
        ev.preventDefault();
        setPtAxisLock(k as "x" | "y" | "z");
        const basePt = ptGetAxisBase();
        if (basePt) ptSetAxisLockLine(viewer, basePt);
      }
    }
    ev.stopPropagation();
    if (ev.key === "Enter" || ev.key === " ") {
      const raw = ptInput.value.trim();
      if (raw) {
        if (_opPhase) opHandleCoordSubmit(viewer, raw);
        else ptHandleCoordSubmit(viewer, raw);
      } else {
        if (_opPhase) opHandleEnter(viewer);
        else ptHandleEnter(viewer);
      }
      ptInput.value = "";
      if (ev.key === " ") ev.preventDefault();
    } else if (ev.key === "Escape") {
      if (_ptPhase) ptCancel(viewer);
      else if (_opPhase) opCancel(viewer);
    }
  });

  const OP_TOOLS = new Set(["extrude", "boolean", "fillet", "aligned-dim", "angular-dim", "area-dim", "volume-dim", "sel-window", "sel-lasso", "sel-boundary"]);

  window.addEventListener("viewer:select", () => {
    if (!_selHLOwned) { clearMultiSelHighlights(); clearMultiSelected(); }
  });

  subscribe("activeTool", (tool) => {
    if (tool === "move" || tool === "rotate" || tool === "scale" || tool === "scale-1d" || tool === "scale-2d") {
      if (_ptPhase) ptCancel(viewer);
      if (_opPhase) opCancel(viewer);
      viewer.setGumballEnabled(false);
      ptStartTool(tool as "move" | "rotate" | "scale" | "scale-1d" | "scale-2d");
    } else if (OP_TOOLS.has(tool)) {
      if (_ptPhase) ptCancel(viewer);
      opStartTool(viewer, tool);
    } else {
      if (_ptPhase) ptCancel(viewer);
      if (_opPhase) opCancel(viewer);
      const h = tool ? TOOL_HANDLERS[tool] : null;
      if (h?.clicks === -1) {
        setPickerHint(`${tool} — click points  [double-click or Enter] commit  [Esc] cancel`);
      }
    }
  });

  vpBody.addEventListener("pointerdown", (ev) => {
    if (ev.button !== 0) return;
    const tool = readActiveTool();
    if (!tool) {
      if (_ptPhase) {
        const obj = ptGetTarget();
        if (!obj) {
          const hit = opRaycastObject(viewer, ev.clientX, ev.clientY);
          if (hit) {
            ev.stopImmediatePropagation();
            viewer.selectObject(hit.obj);
            setSelected({ topology: "mesh", uuid: hit.obj.uuid, object: hit.obj, transformTarget: hit.obj });
            window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: hit.obj.uuid } }));
            opSetHover(null);
            const ptTool = (_ptPhase as { kind: "start"; tool: string }).tool;
            if (ptTool === "rotate") {
              setPtPhase({ kind: "rotate_axis_a" });
              ptPrompt("Rotation axis — click start point of axis  (Enter = centroid)");
              ptHideCoordInput();
            } else if (ptTool === "scale-1d" || ptTool === "scale-2d") {
              const lbl: Record<string, string> = { "scale-1d": "Scale 1D", "scale-2d": "Scale 2D" };
              ptPrompt(`${lbl[ptTool]} — click anchor point, or Enter for centroid`);
              ptShowCoordInput("x, y  or  x, y, z");
            } else {
              const lbl: Record<string, string> = { move: "Move", scale: "Scale 3D" };
              ptPrompt(`${lbl[ptTool] ?? ptTool} — reference point: click, type x,y,z, or Enter for centroid`);
              ptShowCoordInput("x, y  or  x, y, z");
            }
          }
          return;
        }
        const axisBase = _ptPhase.kind === "rotate_axis_b" ? _ptPhase.axisA : ptGetAxisBase();
        let clickPt: THREE.Vector3 | null = null;
        if (_ptAxisLock && axisBase) {
          const rawPt = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, axisBase, ptEffectiveAxisDir());
          if (rawPt) {
            if (getSnap().snapOn && getSnap().gridOn) {
              const step = getSnap().step;
              if (_ptAxisLock === "x") rawPt.x = Math.round(rawPt.x / step) * step;
              else if (_ptAxisLock === "y") rawPt.y = Math.round(rawPt.y / step) * step;
              else rawPt.z = Math.round(rawPt.z / step) * step;
            }
            clickPt = rawPt;
          }
        }
        if (!clickPt) {
          const sv = nearestSnapVertex(viewer, ev.clientX, ev.clientY);
          if (sv) {
            clickPt = new THREE.Vector3(sv.x, sv.y, sv.z);
          } else if (_lastSurfaceHit) {
            clickPt = _lastSurfaceHit.clone();
          } else {
            const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
            if (!world) return;
            const snapped = snapWorldForView(viewer, world);
            clickPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z);
          }
        }
        ev.stopImmediatePropagation();
        ptHandlePoint(viewer, clickPt);
        return;
      }

      // Shift+click: multi-select toggle.
      if (ev.shiftKey && !_ptPhase && !_opPhase) {
        const hit = opRaycastObject(viewer, ev.clientX, ev.clientY);
        if (hit) {
          ev.stopImmediatePropagation();
          if (getMultiSelected().length === 0) {
            const cur = viewer.getTargetObject();
            if (cur) addToMultiSelected({ topology: "mesh", uuid: cur.uuid, object: cur, transformTarget: cur });
          }
          addToMultiSelected({ topology: "mesh", uuid: hit.obj.uuid, object: hit.obj, transformTarget: hit.obj });
          clearMultiSelHighlights();
          const multiSet = getMultiSelected();
          for (const s of multiSet) applyMultiSelHL(s.object);
          if (multiSet.length > 1) {
            viewer.setMultiTargets(multiSet.map(s => s.object));
          } else if (multiSet.length === 1) {
            viewer.selectObject(multiSet[0].object);
          }
        }
        return;
      }

      // Op-tool click.
      if (_opPhase) {
        ev.stopImmediatePropagation();
        if (_opPhase.kind === "sel_window") {
          setSelDragging(true);
          _opPhase.startX = ev.clientX;
          _opPhase.startY = ev.clientY;
        } else if (_opPhase.kind === "sel_lasso") {
          setSelDragging(true);
          _opPhase.points = [{ x: ev.clientX, y: ev.clientY }];
        } else {
          opHandleClick(viewer, ev.clientX, ev.clientY);
        }
        return;
      }

      const session = getActiveCommandSession();
      if (session?.state === "collecting_args") {
        const world = unprojectToXY(viewer, ev.clientX, ev.clientY);
        if (!world) return;
        ev.stopImmediatePropagation();
        const snapped = snapWorldForView(viewer, world);
        void provideSessionPick([snapped.x, snapped.y]).then((result) => {
          if (result.status === "needs_choice" && result.awaiting_text_choice) {
            setChooserHint(result.awaiting_text_choice);
          } else {
            setChooserHint(null);
            setPickerHint(result.status === "needs_input" ? (result.summary ?? null) : null);
          }
        });
      }
      return;
    }

    // Create-tool click.
    const world = (tool === "clip" ? unprojectForClipTool : unprojectToXY)(viewer, ev.clientX, ev.clientY);
    if (!world) return;
    ev.stopImmediatePropagation();
    setLastPointerClient({ x: ev.clientX, y: ev.clientY });
    const vertex = !ev.altKey ? nearestSnapVertex(viewer, ev.clientX, ev.clientY) : null;
    let snapped: { x: number; y: number; z?: number };
    if (vertex) {
      snapped = vertex;
    } else if (!ev.altKey && _lastSurfaceHit) {
      snapped = { x: _lastSurfaceHit.x, y: _lastSurfaceHit.y, z: _lastSurfaceHit.z };
    } else {
      snapped = snapWorldForView(viewer, world);
    }
    if (tool === "clip" && !vertex) {
      const av = viewer.activeView;
      const isElevation = av === "front" || av === "back" || av === "left" || av === "right";
      if (!isElevation) snapped = { ...snapped, z: world.z };
    }
    const clickShiftBase: { x: number; y: number; z?: number } | null =
      _pending.length > 0 ? _pending[_pending.length - 1] : (_smartTrackPt ?? null);
    if (ev.shiftKey && !ev.altKey && clickShiftBase) {
      const baseZ = clickShiftBase.z ?? 0;
      if (_shiftAxisChoice === "z") {
        const dz = screenYtoDz(viewer, ev.clientY, clickShiftBase);
        const step = getSnap().step;
        const rawZ = baseZ + dz;
        const lockedZ = getSnap().snapOn && getSnap().gridOn
          ? Math.round(rawZ / step) * step : Math.round(rawZ * 1000) / 1000;
        snapped = { x: clickShiftBase.x, y: clickShiftBase.y, z: lockedZ };
      } else {
        const axisSnapped = shiftAxisSnap(clickShiftBase, snapped, getSnap().step);
        snapped = { x: axisSnapped.x, y: axisSnapped.y, z: baseZ };
      }
      setShiftAxisChoice(null);
    }
    const hostCreators = HOST_TOOL_CREATORS[tool];
    if (hostCreators) {
      const host = findHostMesh(viewer, ev.clientX, ev.clientY, hostCreators);
      if (!host) {
        const label = hostCreators.length === 1 ? hostCreators[0] : hostCreators.join(" or ");
        setPickerHint(`click a ${label} to place`);
        return;
      }
      setPendingHostId((host.userData as { expressID?: string; uuid?: string }).expressID ?? host.uuid);
      setPickerHint(null);
    }
    const z = tool === "level" ? getGeometryZ(viewer, ev.clientX, ev.clientY) : snapped.z;
    const clickHandler = TOOL_HANDLERS[tool];
    if (clickHandler?.clicks === -1 && _pending.length >= 2) {
      const now = performance.now();
      const ddx = ev.clientX - _lastCreateClickX, ddy = ev.clientY - _lastCreateClickY;
      if (now - _lastCreateClickTs < 500 && ddx * ddx + ddy * ddy < 100) {
        setLastCreateClickTs(0);
        commitUnlimited(viewer);
        setPendingHostId(null);
        return;
      }
    }
    setLastCreateClickTs(performance.now());
    setLastCreateClickX(ev.clientX);
    setLastCreateClickY(ev.clientY);
    emitClickWorld(viewer, { ...snapped, z }, { tool });
    setPendingHostId(null);
  }, { capture: true });

  vpBody.addEventListener("pointermove", (ev) => {
    const tool = readActiveTool();
    if (!tool && !_ptPhase && !_opPhase) {
      const activeBtn = document.querySelector<HTMLElement>(".palette-btn.active");
      if (activeBtn?.dataset.tool === "select") {
        const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, false, true);
        opSetHover(hit ? hit.obj : null);
      } else {
        opSetHover(null);
      }
      hideCursorDot();
      setSnapTarget(null);
      return;
    }

    if (_selDragging && _opPhase?.kind === "sel_window") {
      const svg = getSelOverlay(viewer);
      clearSelOverlay();
      const canvas = viewer.getCanvas();
      const rect = canvas.getBoundingClientRect();
      const x1 = Math.min(_opPhase.startX, ev.clientX) - rect.left;
      const y1 = Math.min(_opPhase.startY, ev.clientY) - rect.top;
      const w = Math.abs(ev.clientX - _opPhase.startX);
      const h = Math.abs(ev.clientY - _opPhase.startY);
      const isWindow = _opPhase.subMode === "window";
      const r = document.createElementNS("http://www.w3.org/2000/svg", "rect");
      r.setAttribute("x", String(x1)); r.setAttribute("y", String(y1));
      r.setAttribute("width", String(w)); r.setAttribute("height", String(h));
      r.setAttribute("fill", isWindow ? "rgba(68,170,255,0.10)" : "rgba(68,255,170,0.10)");
      r.setAttribute("stroke", isWindow ? "#4af" : "#4fa");
      r.setAttribute("stroke-width", "1.5");
      r.setAttribute("stroke-dasharray", isWindow ? "none" : "4 3");
      svg.appendChild(r);
    } else if (_selDragging && _opPhase?.kind === "sel_lasso") {
      _opPhase.points.push({ x: ev.clientX, y: ev.clientY });
      const svg = getSelOverlay(viewer);
      clearSelOverlay();
      const canvas = viewer.getCanvas();
      const rect = canvas.getBoundingClientRect();
      if (_opPhase.points.length >= 2) {
        const pl = document.createElementNS("http://www.w3.org/2000/svg", "polyline");
        pl.setAttribute("points", _opPhase.points.map(p => `${p.x - rect.left},${p.y - rect.top}`).join(" "));
        pl.setAttribute("fill", "rgba(68,170,255,0.10)");
        pl.setAttribute("stroke", "#4af"); pl.setAttribute("stroke-width", "1.5");
        svg.appendChild(pl);
      }
    }

    if (_opPhase?.kind === "extrude_height") {
      opUpdateExtrudePreview(viewer, ev.clientX, ev.clientY, ev.shiftKey);
    }
    if (_opPhase && opPhaseIsObjectSelect(_opPhase)) {
      const profileOnly = _opPhase.kind === "extrude_select";
      const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, profileOnly, true);
      if (_opPhase.kind === "bool_b") {
        opSetHover(hit && hit.obj !== _opPhase.objA ? hit.obj : null);
      } else {
        opSetHover(hit ? hit.obj : null);
      }
    } else if (ptPhaseIsObjectSelect()) {
      const hit = opRaycastObject(viewer, ev.clientX, ev.clientY, false, true);
      opSetHover(hit ? hit.obj : null);
    } else {
      opSetHover(null);
    }

    if ((_opPhase && opPhaseSupressesSnap(_opPhase)) || ptPhaseIsObjectSelect()) {
      hideCursorDot();
      setSnapTarget(null);
      return;
    }

    const world = (tool === "clip" ? unprojectForClipTool : unprojectToXY)(viewer, ev.clientX, ev.clientY);
    if (!world) {
      if (_ptAxisLock && _ptPhase && _ptPhase.kind !== "start") {
        const axisBase = ptGetAxisBase();
        if (axisBase) {
          const constrained = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, axisBase, ptEffectiveAxisDir());
          if (constrained) {
            const screen = projectToScreen(viewer, constrained.x, constrained.y, constrained.z);
            moveCursorDot(viewer, constrained, screen?.x ?? ev.clientX, screen?.y ?? ev.clientY, false);
            return;
          }
        }
      }
      moveCursorDot(viewer, { x: 0, y: 0 }, ev.clientX, ev.clientY);
      return;
    }

    let snapped: { x: number; y: number; z?: number };
    if (ev.altKey) {
      setSnapTarget(null);
      setLastSnapEdgeDir(null);
      snapped = world;
    } else {
      const vertex = nearestSnapVertex(viewer, ev.clientX, ev.clientY);
      if (vertex) {
        setSnapTarget(vertex);
        if (!vertex.edgeDir) setLastSnapEdgeDir(null);
        snapped = vertex;
      } else {
        setSnapTarget(null);
        snapped = _lastSurfaceHit
          ? { x: _lastSurfaceHit.x, y: _lastSurfaceHit.y, z: _lastSurfaceHit.z }
          : snapWorldForView(viewer, world);
      }
    }
    if (tool === "clip") {
      const av = viewer.activeView;
      const isElevation = av === "front" || av === "back" || av === "left" || av === "right";
      if (!isElevation) snapped = { ...snapped, z: world.z };
    }

    if (!ev.altKey && tool && !_ptPhase && !_opPhase) {
      const curSnapTgt = getSnapTarget();
      const trackId = curSnapTgt
        ? curSnapTgt.id
        : (getSnap().snapOn && getSnap().gridOn)
          ? `g:${Math.round(snapped.x * 1000)},${Math.round(snapped.y * 1000)}`
          : null;
      if (trackId) {
        const trackPt = curSnapTgt ?? snapped;
        if (_smartTrackCandidate?.id !== trackId) {
          if (_smartTrackTimer) clearTimeout(_smartTrackTimer);
          setSmartTrackCandidate({ x: trackPt.x, y: trackPt.y, id: trackId });
          setSmartTrackTimer(setTimeout(() => {
            if (_smartTrackCandidate) setSmartTrackPt(viewer, _smartTrackCandidate);
            setSmartTrackTimer(null);
          }, SMART_TRACK_MS));
        }
      } else if (!ev.shiftKey) {
        if (_smartTrackTimer) { clearTimeout(_smartTrackTimer); setSmartTrackTimer(null); setSmartTrackCandidate(null); }
      }
    }

    const shiftBase: { x: number; y: number; z?: number } | null =
      _pending.length > 0 ? _pending[_pending.length - 1] : (_smartTrackPt ?? null);
    if (ev.shiftKey && !ev.altKey && !_ptPhase && !_opPhase && tool && shiftBase) {
      const dx = snapped.x - shiftBase.x;
      const dy = snapped.y - shiftBase.y;
      const dz = screenYtoDz(viewer, ev.clientY, shiftBase);
      const baseZ = shiftBase.z ?? 0;
      if (!_shiftAxisChoice) {
        const moved = Math.abs(dx) > 1e-4 || Math.abs(dy) > 1e-4 || Math.abs(dz) > 1e-4;
        if (moved) {
          setShiftAxisChoice(
            (Math.abs(dz) > Math.abs(dx) && Math.abs(dz) > Math.abs(dy)) ? "z"
            : Math.abs(dx) >= Math.abs(dy) ? "x" : "y",
          );
        }
      }
      if (_shiftAxisChoice === "z") {
        const step = getSnap().step;
        const rawZ = baseZ + dz;
        const lockedZ = getSnap().snapOn && getSnap().gridOn
          ? Math.round(rawZ / step) * step : Math.round(rawZ * 1000) / 1000;
        snapped = { x: shiftBase.x, y: shiftBase.y, z: lockedZ };
        updateSketchShiftLine(viewer, new THREE.Vector3(shiftBase.x, shiftBase.y, baseZ), "z");
      } else if (_shiftAxisChoice) {
        const axisSnapped = shiftAxisSnap(shiftBase, snapped, getSnap().step);
        snapped = { x: axisSnapped.x, y: axisSnapped.y, z: baseZ };
        updateSketchShiftLine(viewer, new THREE.Vector3(shiftBase.x, shiftBase.y, baseZ), _shiftAxisChoice);
      } else {
        clearSketchShiftLine(viewer);
      }
    } else {
      setShiftAxisChoice(null);
      clearSketchShiftLine(viewer);
    }

    if (_ptAxisLock && _ptPhase && _ptPhase.kind !== "start") {
      const axisBase = _ptPhase.kind === "rotate_axis_b" ? _ptPhase.axisA : ptGetAxisBase();
      if (axisBase) {
        const axisDir = ptEffectiveAxisDir();
        const constrained = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, axisBase, axisDir);
        if (constrained) {
          if (getSnap().snapOn && getSnap().gridOn) {
            const step = getSnap().step;
            if (_ptAxisLock === "x") constrained.x = Math.round(constrained.x / step) * step;
            else if (_ptAxisLock === "y") constrained.y = Math.round(constrained.y / step) * step;
            else constrained.z = Math.round(constrained.z / step) * step;
          }
          setSnapTarget(null);
          snapped = { x: constrained.x, y: constrained.y, z: constrained.z };
        }
      }
    }

    const screen = projectToScreen(viewer, snapped.x, snapped.y, snapped.z ?? 0);
    moveCursorDot(viewer, snapped, screen?.x ?? ev.clientX, screen?.y ?? ev.clientY, getSnapTarget() !== null);

    // PT live-preview readouts.
    if (_ptPhase?.kind === "start") {
      const ptObj = ptGetTarget();
      const tlMap: Record<string, string> = { move: "Move", rotate: "Rotate", scale: "Scale 3D", "scale-1d": "Scale 1D", "scale-2d": "Scale 2D" };
      const tl = tlMap[_ptPhase.tool] ?? _ptPhase.tool;
      if (!ptObj) ptPrompt(`${tl} — click to select an object`);
      else ptPrompt(`${tl} — reference point: click, type x,y,z, or Enter for centroid`);
    } else if (_ptPhase?.kind === "end_move") {
      let cursorPt: THREE.Vector3;
      if (_ptAxisLock) {
        const rawPt = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, _ptPhase.start, ptEffectiveAxisDir());
        if (rawPt) {
          if (getSnap().snapOn && getSnap().gridOn) {
            const step = getSnap().step;
            if (_ptAxisLock === "x") rawPt.x = Math.round(rawPt.x / step) * step;
            else if (_ptAxisLock === "y") rawPt.y = Math.round(rawPt.y / step) * step;
            else rawPt.z = Math.round(rawPt.z / step) * step;
          }
          cursorPt = rawPt;
        } else {
          cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
        }
      } else {
        cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      }
      const ptObj = ptGetTarget();
      if (ptObj && _ptInitPos) {
        ptObj.position.copy(_ptInitPos).add(cursorPt.clone().sub(_ptPhase.start));
        ptObj.updateMatrix(); ptObj.updateMatrixWorld(true);
      }
      ptSetPreviewLine(viewer, _ptPhase.start, cursorPt);
      const delta = cursorPt.clone().sub(_ptPhase.start);
      const lockTag = _ptAxisLock ? `  [${_ptAxisLock.toUpperCase()} LOCK]` : "";
      ptPrompt(`Target point — click, type x,y,z  [Δ ${delta.x.toFixed(2)}, ${delta.y.toFixed(2)}, ${delta.z.toFixed(2)}]${lockTag}`);
    } else if (_ptPhase?.kind === "rotate_axis_a") {
      const cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      ptPrompt(`Rotation axis — click start point  [${cursorPt.x.toFixed(2)}, ${cursorPt.y.toFixed(2)}, ${cursorPt.z.toFixed(2)}]`);
    } else if (_ptPhase?.kind === "rotate_axis_b") {
      let cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      if (_ptAxisLock) {
        const projected = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, _ptPhase.axisA, ptEffectiveAxisDir());
        if (projected) cursorPt = projected;
      }
      ptSetPreviewLine(viewer, _ptPhase.axisA, cursorPt);
      const dir = cursorPt.clone().sub(_ptPhase.axisA).normalize();
      const lockTag = _ptAxisLock ? `  [${_ptAxisLock.toUpperCase()} AXIS]` : "";
      ptPrompt(`Rotation axis — click end point  [dir ${dir.x.toFixed(2)}, ${dir.y.toFixed(2)}, ${dir.z.toFixed(2)}]${lockTag}`);
    } else if (_ptPhase?.kind === "angle_end") {
      const cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      const dx = world.x - _ptPhase.base.x;
      const dy = world.y - _ptPhase.base.y;
      const raw = Math.atan2(dy, dx) * 180 / Math.PI;
      const snap2 = getSnap();
      const deg = (snap2.snapOn && snap2.polarOn)
        ? Math.round(raw / snap2.angleStep) * snap2.angleStep : raw;
      const ptObj = ptGetTarget();
      if (ptObj && _ptInitPos && _ptInitQuat) {
        ptObj.position.copy(_ptInitPos);
        ptObj.quaternion.copy(_ptInitQuat);
        ptCommitRotate(ptObj, _ptPhase.base, deg, _ptPhase.axisDir);
      }
      ptSetPreviewLine(viewer, _ptPhase.base, cursorPt);
      ptPrompt(`Rotation angle — hover and click  [${Math.round(deg)}°]  or type degrees`);
    } else if (_ptPhase?.kind === "scale_ref") {
      const cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      ptSetPreviewLine(viewer, _ptPhase.base, cursorPt);
      const dist = cursorPt.distanceTo(_ptPhase.base);
      ptPrompt(`Scale — click reference start point  [dist from anchor: ${formatLength(dist)}]`);
    } else if (_ptPhase?.kind === "scale_end") {
      let cursorPt: THREE.Vector3;
      if (_ptAxisLock) {
        cursorPt = unprojectToAxisLine(viewer, ev.clientX, ev.clientY, _ptPhase.base, ptEffectiveAxisDir())
          ?? new THREE.Vector3(snapped.x, snapped.y, 0);
      } else {
        cursorPt = new THREE.Vector3(snapped.x, snapped.y, snapped.z ?? 0);
      }
      const refDist = _ptPhase.refPt.distanceTo(_ptPhase.base);
      const newDist = cursorPt.distanceTo(_ptPhase.base);
      const factor = refDist > 1e-6 ? newDist / refDist : 1;
      const ptObj = ptGetTarget();
      if (ptObj && _ptInitPos && _ptInitScale) {
        ptObj.position.copy(_ptInitPos);
        ptObj.scale.copy(_ptInitScale);
        if (_ptPhase.mode === "1d") {
          ptCommitScale1D(ptObj, _ptPhase.base, _ptPhase.refPt.clone().sub(_ptPhase.base), factor);
        } else if (_ptPhase.mode === "2d") {
          ptCommitScale2D(ptObj, _ptPhase.base, factor);
        } else {
          ptCommitScale(ptObj, _ptPhase.base, factor);
        }
      }
      ptSetPreviewLine(viewer, _ptPhase.base, cursorPt);
      const lockTag = _ptAxisLock ? `  [${_ptAxisLock.toUpperCase()} LOCK]` : "";
      const modeTag = _ptPhase.mode === "1d" ? " [1D]" : _ptPhase.mode === "2d" ? " [2D]" : "";
      ptPrompt(`Scale${modeTag} end — click  [factor: ${factor.toFixed(3)}]${lockTag}`);
    }

    if (!tool) return;
    if (_pending.length === 0) return;
    const handler = TOOL_HANDLERS[tool];
    if (!handler || (handler.clicks > 0 && handler.clicks < 2)) return;
    updateRubberBand(viewer, handler, snapped);
  });

  vpBody.addEventListener("pointerleave", () => {
    hideCursorDot();
    opSetHover(null);
  });

  vpBody.addEventListener("pointerup", (ev) => {
    if (!_selDragging) return;
    setSelDragging(false);
    if (_opPhase?.kind === "sel_window") {
      const x1 = Math.min(_opPhase.startX, ev.clientX);
      const y1 = Math.min(_opPhase.startY, ev.clientY);
      const x2 = Math.max(_opPhase.startX, ev.clientX);
      const y2 = Math.max(_opPhase.startY, ev.clientY);
      if (x2 - x1 > 4 || y2 - y1 > 4) {
        runRectSel(viewer, x1, y1, x2, y2, _opPhase.subMode);
        setTimeout(() => { removeSelOverlay(); opFinish(viewer); }, 600);
      } else {
        removeSelOverlay();
      }
    } else if (_opPhase?.kind === "sel_lasso" && _opPhase.points.length >= 3) {
      runPolySel(viewer, _opPhase.points, _opPhase.subMode);
      setTimeout(() => { removeSelOverlay(); opFinish(viewer); }, 600);
    } else {
      removeSelOverlay();
    }
  });

  window.addEventListener("keydown", (ev) => {
    const _tgt = ev.target as HTMLElement | null;
    if (_tgt && (_tgt.tagName === "INPUT" || _tgt.tagName === "TEXTAREA" || _tgt.isContentEditable)) return;
    if (_ptPhase && _ptPhase.kind !== "start"
        && ev.shiftKey && !ev.ctrlKey && !ev.metaKey && !ev.altKey
        && document.activeElement !== _ptCoordInputEl) {
      const key = ev.key.toLowerCase();
      if (key === "x" || key === "y" || key === "z") {
        ev.preventDefault();
        setPtAxisLock(key as "x" | "y" | "z");
        setLastSnapEdgeDir(null);
        const basePt = _ptPhase.kind === "rotate_axis_b" ? _ptPhase.axisA : ptGetAxisBase();
        if (basePt) ptSetAxisLockLine(viewer, basePt);
        return;
      }
    }
    if (ev.key === "Escape") {
      if (_ptPhase) { ptCancel(viewer); return; }
      if (_opPhase) { opCancel(viewer); return; }
      if (_pending.length > 0) {
        clearTemporary(viewer);
        clearSmartTrack(viewer);
        hideCursorDot();
        setPickerHint(null);
        setPending([]);
        dispatchSync("setActiveTool", { toolId: "select" });
      }
      if (getActiveCommandSession()?.state === "collecting_args") {
        clearCommandSession();
        setPickerHint(null);
        setChooserHint(null);
      }
      return;
    }
    if (ev.key === "Enter" || (ev.key === " " && document.activeElement !== _ptCoordInputEl)) {
      if (ev.key === " ") {
        if (!_ptPhase && !_opPhase && !readActiveTool() && _lastPtTool) {
          ev.preventDefault();
          dispatchSync("setActiveTool", { toolId: _lastPtTool });
          return;
        }
        ev.preventDefault();
      }
      if (_opPhase) { opHandleEnter(viewer); return; }
      if (_ptPhase && document.activeElement !== _ptCoordInputEl) { ptHandleEnter(viewer); return; }
      commitUnlimited(viewer);
      void commitCommandSession().then((r) => {
        if (r) {
          if (r.status === "needs_choice" && r.awaiting_text_choice) {
            setChooserHint(r.awaiting_text_choice);
          } else {
            setChooserHint(null);
            setPickerHint(r.status === "needs_input" ? (r.summary ?? null) : null);
          }
        }
      });
    }
  });

  window.addEventListener("keyup", (ev) => {
    if (ev.key === "Shift") {
      if (_ptAxisLock && _ptViewer) {
        setPtAxisLock(null);
        ptClearAxisLockLine(_ptViewer);
      }
      if (_viewer) clearSketchShiftLine(_viewer);
      setShiftAxisChoice(null);
    }
  });

  document.addEventListener("click", (ev) => {
    const t = ev.target as HTMLElement | null;
    if (!t) return;
    if (t.closest(".palette-btn")) resetPending();
  }, { capture: true });
}
