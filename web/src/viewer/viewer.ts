// Three.js viewer for replicad meshes.
//
// Receives a flat-array mesh from the worker, builds a BufferGeometry,
// and frames the camera on the result. Scissor-per-pane render loop
// supports single and quad viewport layouts. OrbitControls are per-pane.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { axesGizmoSVG } from "../ui/icons.js";
import { getState, subscribe } from "../app-state.js";
import { setSelected, clearSelected } from "./selection-state.js";
import { emitChainFragment } from "./transforms.js";
import { getSnap, subscribeSnap } from "./snap-state.js";
import { showHandlesFor, clearHandles, isSubObjectHandle, getHandles, getHandleParent, refitParentGeometry } from "./sub-object-handles.js";
import { getCurrentDispatchCtx } from "../commands/dispatch.js";
import { WORLD_XY, resolveCPlane, type CPlane } from "./cplane.js";
import { CPlaneGizmo } from "./cplane-gizmo.js";
import { applyDrafting, removeDrafting, isDrafting, withoutDrafting } from "../geometry/drafting.js";
import { pushAction, pushDeleteAction, pushReplaceAction, pushTransformAction, captureTransform, beginTransaction, endTransaction, type TransformSnapshot } from "../history.js";
import { dissolveGroupForMesh, isOpening, nearestGroupMember, onElementCommitted, rerecutVoid, restoreVoidCut } from "../tools/join-groups.js";
import { resetWallCorners, recomputeWallEndpoints, attemptWallCornerJoins } from "../tools/wall-corners.js";
import { ClipFillManager } from "./clip-fill.js";
import { getLayerForCreator } from "../geometry/layers.js";
import { drawingLayerStore } from "../geometry/drawing-layers.js";

type ViewName = "top" | "persp" | "front" | "right";
type Pane = {
  id: string;
  view: ViewName;
  el: HTMLElement;
  body: HTMLElement;
  camera: THREE.Camera;
  controls: OrbitControls;
  /** Last pixel dimensions at which this pane was actually rendered. Persists when the MODEL tab is hidden so renderThumbnailTo can compute a stable scale reference without relying on camera.aspect (which is only updated on browser-window resize). */
  lastRenderedW: number;
  lastRenderedH: number;
};

export type MeshIn = {
  vertices: Float32Array;
  normals: Float32Array;
  indices: Uint32Array;
};

export type Bounds = {
  min: [number, number, number];
  max: [number, number, number];
};

export class Viewer {
  private canvas: HTMLCanvasElement;
  private scene: THREE.Scene;
  private camera: THREE.PerspectiveCamera;
  private renderer: THREE.WebGLRenderer;
  private controls: OrbitControls | null = null;
  private panes: Pane[] = [];
  private currentMesh: THREE.Mesh | null = null;
  private currentEdges: THREE.LineSegments | null = null;
  private currentObject: THREE.Object3D | null = null;
  private grid: THREE.GridHelper;
  private _workingPlaneZ = 0;
  private axes: THREE.AxesHelper;
  private axisLabels: THREE.Sprite[] = [];
  private currentBounds: Bounds | null = null;
  private raycaster: THREE.Raycaster;
  // Rhino-style Gumball — three TransformControls instances on the same
  // selection at once: translate arrows + rotation rings + scale boxes all
  // visible. Each only raycasts its own handle group, so clicks disambiguate
  // by which handle the pointer hits. Gumball mode hotkeys (G/R/S) and the
  // palette Move/Rotate/Scale buttons are no longer required for switching.
  private gizmos: TransformControls[] = [];
  private gizmoCaptured: { position: THREE.Vector3; quaternion: THREE.Quaternion; scale: THREE.Vector3 } | null = null;
  private _gumballEnabled = true;
  // Pivot proxy — Rhino "relocate gumball" needs the gumball pose to be
  // separable from the geometry pose. The three TransformControls always
  // attach to this proxy, never directly to the geometry. The proxy's
  // matrix is computed each frame as targetObject.matrix * pivotOffset.
  // In normal mode, dragging the proxy is mirrored as a world-space delta
  // applied to targetObject (so geometry follows). In relocate mode,
  // dragging only updates pivotOffset — geometry stays put.
  private pivotProxy: THREE.Object3D | null = null;
  private pivotOffset: THREE.Matrix4 = new THREE.Matrix4();
  // Per-object pivot offset cache. Survives deselect → reselect cycles so a
  // user-relocated gumball returns to where the user put it on the last
  // visit, not back to the geometry origin.
  private pivotOffsetByUuid: Map<string, THREE.Matrix4> = new Map();
  private targetObject: THREE.Object3D | null = null;
  private pivotMatrixBeforeDrag: THREE.Matrix4 = new THREE.Matrix4();
  private targetMatrixBeforeDrag: THREE.Matrix4 = new THREE.Matrix4();
  // Multi-select: all selected objects. When length > 1, the gumball pivot
  // sits at their centroid and objectChange applies the delta to each.
  private multiTargets: THREE.Object3D[] = [];
  private multiTargetMatricesBeforeDrag: THREE.Matrix4[] = [];
  private relocateBadge: HTMLElement | null = null;
  private _themeObserver: MutationObserver | null = null;
  // Cursor-follow relocate: when active, normal gumball drag is disabled
  // and pointer-move updates the pivot directly until the user clicks to
  // exit. Mode + axis are captured at the dblclick that entered the mode.
  private relocate: {
    active: boolean;
    mode: "translate" | "rotate" | "scale";
    axis: string;        // "X" | "Y" | "Z" | "XY" | "XZ" | "YZ" | "XYZ"
    pivotStart: THREE.Matrix4;
    cursorStart: THREE.Vector3;
    pane: Pane | null;
  } = {
    active: false,
    mode: "translate",
    axis: "",
    pivotStart: new THREE.Matrix4(),
    cursorStart: new THREE.Vector3(),
    pane: null,
  };
  // Hover tracker — TC.axis can be transiently null between drags so we
  // record it ourselves on every pointermove. Read at dblclick-detect
  // time (pointerdown.detail===2) for a synchronous, race-free axis read.
  private lastHover: { mode: "translate" | "rotate" | "scale"; axis: string; ts: number } | null = null;
  // Manual double-click detection — e.detail can be unreliable on some
  // pointer hardware / OS. Track previous pointerdown timestamp+position;
  // if next down happens within 500ms and ≤10px, treat as dblclick.
  private lastClickTs: number = 0;
  private lastClickPos: { x: number; y: number } = { x: 0, y: 0 };
  // Snapshot of pivot+target matrices at the FIRST click of a dblclick
  // gesture. Used to roll back any tiny drag that happened in the gap
  // between the two clicks (e.g. a few-pixel mouse jitter). Distinct from
  // pivotMatrixBeforeDrag/targetMatrixBeforeDrag (which are populated by
  // TC's dragging-changed and only on actual movement — they go stale
  // across unrelated drags). Fixes the "geometry jumps to a previous
  // position" bug on relocate entry.
  private dblclickPivotStart: THREE.Matrix4 = new THREE.Matrix4();
  private dblclickTargetStart: THREE.Matrix4 = new THREE.Matrix4();
  // Cached orthographic camera for axis-aligned views (#331). Reused across setView() calls.
  private _orthoViewCamera: THREE.OrthographicCamera | null = null;
  // Per-axis arm-length factor for the scale gumball. 1.0 = default reach.
  // Mutated by scale-axis relocate (dblclick scale handle + cursor follow):
  // the gumball center stays put, but the cube tip + its picker box slide
  // out along the axis to track the cursor. The committed factor is what
  // determines where the cube sits visually; subsequent scale-drag math is
  // unaffected (TC scale uses cursor delta, not arm length).
  private scaleArmFactor: { X: number; Y: number; Z: number } = { X: 1, Y: 1, Z: 1 };
  // Cube + picker mesh references for each scale axis, captured once at
  // construction so we can mutate their geometries on stretch updates
  // without re-traversing the entire gizmo every move event. Each entry's
  // `sign` is +1 for the positive-direction mesh (X+ at +0.5) and -1 for
  // the negative-direction mesh (X- at -0.5).
  private scaleArmRefs: Map<"X" | "Y" | "Z", { cubes: Array<{ mesh: THREE.Mesh; sign: number }>; pickers: Array<{ mesh: THREE.Mesh; sign: number }> }> = new Map();
  // Arm world-distance at scale-axis-relocate entry. Used to convert cursor
  // distance into a stretch factor (factor = currentDist / startDist).
  private scaleArmStartLength: number = 1;
  // Host-geometry snap candidates — vertices, edge endpoints, edge
  // midpoints in world space. Built once on relocate entry from the
  // currently-selected target's mesh + edge geometry; cursor projections
  // snap to the nearest candidate within a pixel threshold.
  private snapCandidates: THREE.Vector3[] = [];
  // Edge segments (world-space pairs) used for continuous nearest-point
  // -on-edge snap. Built alongside snapCandidates; consumed in applyHostSnap
  // to add a per-edge candidate at the closest point on that edge to the
  // current cursor projection. Separate from snapCandidates because the
  // snap point is cursor-dependent (one candidate per edge, recomputed
  // each pointermove).
  private snapEdges: Array<{ a: THREE.Vector3; b: THREE.Vector3 }> = [];
  // Snap hysteresis. False when not currently snapped (use the narrow
  // SNAP_ENTER_PX threshold to enter a snap); true while snapped (widen
  // to SNAP_EXIT_PX so the gumball stays stuck through small cursor
  // wobble around the target). Without hysteresis the snap toggles on
  // and off every few pixels of mouse jitter near a candidate.
  private snapHysteresis = false;
  // Visible snap marker (small sphere at the snapped point during relocate).
  private snapMarker: THREE.Mesh | null = null;
  // Offscreen renderer for layout thumbnail panels.
  private _thumbCanvas: HTMLCanvasElement | null = null;
  private _thumbRenderer: THREE.WebGLRenderer | null = null;
  // Cached override materials for displayMode thumbnails — allocated once, reused every frame.
  private _thumbMatWireframe: THREE.MeshBasicMaterial | null = null;
  private _thumbMatGhosted: THREE.MeshBasicMaterial | null = null;
  // Sub-object handle selection: set when the gumball is attached to a CP handle.
  private subTargetObject: THREE.Object3D | null = null;
  // Isolation: stash visibility before hide-all-others, restore on off.
  private _isolatedUuid: string | null = null;
  private _preIsolationVisible: Map<string, boolean> = new Map();
  // Section box: 6 axis-aligned half-space planes derived from min/max corners.
  private _sectionPlanes: THREE.Plane[] = [];
  // Arbitrary named clipping planes (SdClippingPlane).
  private _clipPlanes: THREE.Plane[] = [];
  private _clipLabels: Map<string, THREE.Plane> = new Map();
  // Stencil-buffer cut-fill for cross-section poché (#836).
  private _clipFill = new ClipFillManager();
  private _fillMode = "shaded";
  // Construction plane (W-1). Updated by setView(); overridden by SdSetCPlane (W-4).
  activeView:   string = "persp";
  activeCPlane: CPlane = WORLD_XY;
  // CPlane gizmo (#361) — grid + axis lines rendered at the active construction plane.
  private _cplaneGizmo: CPlaneGizmo = new CPlaneGizmo();
  // W-6 host-pick (#343): when set, the next canvas click picks a face and derives a CPlane from its normal.
  private _hostPickCallback: ((cplane: CPlane) => void) | null = null;

  constructor(canvas: HTMLCanvasElement, viewportAreaEl: HTMLElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.shadowMap.enabled = false;
    this.renderer.autoClear = false;
    this._applyClearColor();
    // Re-sync clear color when theme toggles (data-mode attribute changes).
    this._themeObserver = new MutationObserver(() => this._applyClearColor());
    this._themeObserver.observe(document.documentElement, {
      attributes: true, attributeFilter: ["data-mode"],
    });
    // Track render mode for fill color (shaded→gray, technical→black, wireframe→dark-gray).
    window.addEventListener("render-mode-changed", (e) => {
      const detail = (e as CustomEvent).detail as { mode: string };
      this._fillMode = detail.mode;
      this._clipFill.updateColor(detail.mode);
    });

    this.scene = new THREE.Scene();

    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(8, 8, 8);
    this.camera.up.set(0, 0, 1);

    // Lights — keyfill + rim for shape readability without shadows.
    const ambient = new THREE.AmbientLight(0xffffff, 0.45);
    this.scene.add(ambient);
    const key = new THREE.DirectionalLight(0xffffff, 0.85);
    key.position.set(10, 10, 12);
    this.scene.add(key);
    const fill = new THREE.DirectionalLight(0x99ccff, 0.35);
    fill.position.set(-8, -6, 4);
    this.scene.add(fill);

    // Reference grid + axes — lighter lineweight so drawn geometry reads over it.
    // Divisions derive from snap step so visible lines coincide with snap targets
    // from the first frame; rebuildGrid uses the same formula on snap changes.
    const initSize = 20;
    const initStep = Math.max(0.001, getSnap().step);
    const initDivs = Math.min(500, Math.max(4, Math.round(initSize / initStep)));
    this.grid = new THREE.GridHelper(initSize, initDivs, 0xa8a8b0, 0xd8d4cc);
    (this.grid as unknown as { __lastSize?: number }).__lastSize = initSize;
    this.grid.rotation.x = Math.PI / 2;
    this.grid.renderOrder = -1;
    const gridMat = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
    for (const m of gridMat) {
      const lm = m as THREE.LineBasicMaterial;
      lm.depthWrite = false;
      lm.transparent = true;
      lm.opacity = 0.55;
      lm.needsUpdate = true;
    }
    this.grid.userData.noSnap = true;
    this.grid.userData.noRenderMode = true;
    this.scene.add(this.grid);

    // CPlane gizmo (#361) — subscribe to cplane-changed, update on each event.
    this.scene.add(this._cplaneGizmo.group);
    window.addEventListener("viewer:cplane-changed", (e) => {
      const cplane = (e as CustomEvent).detail?.cplane as CPlane | undefined;
      if (cplane) this._cplaneGizmo.update(cplane);
    });

    // Layer panel child-row click → programmatic selection by UUID.
    window.addEventListener("viewer:select-uuid", (e) => {
      const uuid = (e as CustomEvent).detail?.uuid as string | undefined;
      if (!uuid) return;
      const obj = this.scene.getObjectByProperty("uuid", uuid) ?? null;
      this.selectObject(obj);
      if (obj) {
        setSelected({ topology: "mesh", uuid: obj.uuid, object: obj, transformTarget: obj });
        window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: obj.uuid } }));
      } else {
        clearSelected();
        window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
      }
    });

    this.axes = new THREE.AxesHelper(2);
    this.axes.userData.noSnap = true;
    this.axes.userData.noRenderMode = true;
    this.scene.add(this.axes);
    this.createAxisLabels();

    // Build per-pane cameras and controls from DOM.
    viewportAreaEl.querySelectorAll<HTMLElement>(".viewport[data-view]").forEach((el, idx) => {
      const view = el.dataset.view as ViewName;
      const body = el.querySelector<HTMLElement>(".vp-body") ?? el;
      let camera: THREE.Camera;
      if (view === "persp") {
        camera = this.camera;
      } else {
        const half = 5;
        camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.01, 1000);
      }
      switch (view) {
        case "top":   camera.position.set(0, 0, 50);  camera.up.set(0, 1, 0); break;
        case "front": camera.position.set(0, -50, 0); camera.up.set(0, 0, 1); break;
        case "right": camera.position.set(50, 0, 0);  camera.up.set(0, 0, 1); break;
        case "persp": break;
      }
      camera.lookAt(0, 0, 0);
      const controls = new OrbitControls(camera, body);
      controls.enableDamping = true;
      controls.dampingFactor = 0.1;
      if (camera instanceof THREE.OrthographicCamera) controls.screenSpacePanning = true;
      body.addEventListener("contextmenu", (e) => e.preventDefault());
      this.panes.push({ id: el.id, view, el, body, camera, controls, lastRenderedW: 0, lastRenderedH: 0 });

      const axesDiv = document.getElementById(`vp-axes-${idx + 1}`);
      if (axesDiv) axesDiv.innerHTML = axesGizmoSVG();
    });

    // Keep backward-compat controls reference pointing at persp pane.
    const perspPane = this.panes.find(p => p.view === "persp");
    if (perspPane) this.controls = perspPane.controls;

    this.handleResize();
    window.addEventListener("resize", () => this.handleResize());
    // Defense-in-depth: catch layout-driven canvas size changes (e.g. sidebar
    // tab switches that grow/shrink the workbench row) that don't fire window.resize.
    new ResizeObserver(() => this.handleResize()).observe(this.canvas);

    // Raycaster for object picking. The canvas has CSS pointer-events:none
    // (lets clicks fall through to the per-pane .vp-body which hosts the
    // OrbitControls), so binding to canvas never fires. Bind to the parent
    // viewport-area-host instead — events bubble up there from .vp-body.
    //
    // Use pointerdown not mousedown: OrbitControls (three 0.162) calls
    // event.preventDefault() inside its pointerdown handler when state
    // becomes ROTATE/PAN/DOLLY, which suppresses the corresponding
    // compatibility mousedown event entirely. Pointerdown listeners stack
    // — preventDefault on the same pointerdown does NOT stop other
    // pointerdown listeners on the same event.
    this.raycaster = new THREE.Raycaster();
    this.raycaster.params.Line.threshold = 0.15;
    this.raycaster.params.Points.threshold = 0.2;
    viewportAreaEl.addEventListener("pointerdown", (e: PointerEvent) => this.onCanvasMouseDown(e));

    // Three TransformControls — translate / rotate / scale — all visible at
    // once on the same selection. Each is bound to perspPane.body (NOT the
    // canvas, which has pointer-events:none and cannot receive drag events).
    // Each TransformControls only raycasts its own handle group, so clicks
    // disambiguate naturally: hitting a translate arrow drives translate,
    // hitting a rotation ring drives rotate, hitting a scale box drives
    // scale. Pointer capture means whichever TC starts dragging keeps the
    // pointer until release; the other two stay idle.
    if (perspPane && perspPane.camera instanceof THREE.PerspectiveCamera) {
      // Pivot proxy — invisible Object3D the gumballs always attach to.
      // Synced from targetObject + pivotOffset between drags.
      this.pivotProxy = new THREE.Object3D();
      this.pivotProxy.userData.noSnap = true;
      this.pivotProxy.userData.noRenderMode = true;
      this.scene.add(this.pivotProxy);

      const r4 = (n: number) => Math.round(n * 1e4) / 1e4;
      const makeGumball = (mode: "translate" | "rotate" | "scale") => {
        const g = new TransformControls(perspPane.camera, perspPane.body);
        // Snapshots captured at drag-start so drag-end can push to undo stack.
        let _dragStartSnapshot: TransformSnapshot | null = null;
        let _dragStartMultiSnapshots: TransformSnapshot[] = [];
        let _dragResetNeighborIds: string[] = [];
        g.setMode(mode);
        g.setSpace("local");
        if (mode === "translate") g.size = 1.0;
        if (mode === "rotate")    g.size = 1.5;
        // Picker layout (×camFactor) with the visible-cube enlargement
        // applied below in tightenAxisPickers:
        //   scale:     [0.041, 0.097]   (size 0.55, picker box 0.4)
        //   translate: [0.094, 0.156]   (size 1.0,  picker box 0.25)
        //   rotate:    [0.173, 0.203]   (size 1.5,  torus tube 0.04)
        // Tiny 0.003 overlap between scale and translate — clicks there
        // route to translate via priority. Cube center (0.069) is well
        // inside scale-only zone.
        if (mode === "scale")     g.size = 0.55;
        // Live transform: objectChange fires every time TransformControls
        // mutates pivotProxy.position/quaternion/scale during a drag. We
        // recompute targetObject's matrix from the pivot delta on each
        // tick so the geometry follows the gumball in real-time instead
        // of jumping at release.
        g.addEventListener("objectChange", () => {
          if (this.relocate.active) return;          // relocate mode: pivot only, geometry untouched
          if (!this.pivotProxy || !this.targetObject) return;
          this.pivotProxy.updateMatrix();             // refresh from p/q/s that TC just mutated
          const dWorld = new THREE.Matrix4().copy(this.pivotProxy.matrix).multiply(this.pivotMatrixBeforeDrag.clone().invert());
          // IFC element meshes live inside a rotated wrapper group (Rx+90 Z-up conversion).
          // Apply the world-space delta in parent-local space so dragging Y moves along world Y,
          // not local Z. For direct scene children (parent = scene), parent matrix = identity.
          const applyDeltaToLocal = (target: THREE.Object3D, localBefore: THREE.Matrix4): THREE.Matrix4 => {
            if (!target.parent || target.parent === this.scene) {
              return new THREE.Matrix4().copy(dWorld).multiply(localBefore);
            }
            target.parent.updateMatrixWorld();
            const pInv = target.parent.matrixWorld.clone().invert();
            return pInv.clone().multiply(dWorld).multiply(target.parent.matrixWorld).multiply(localBefore);
          };
          const newMatrix = applyDeltaToLocal(this.targetObject, this.targetMatrixBeforeDrag);
          newMatrix.decompose(this.targetObject.position, this.targetObject.quaternion, this.targetObject.scale);
          // Apply the same world-space delta to every additional multi-select target.
          for (let _mi = 0; _mi < this.multiTargets.length; _mi++) {
            const _mt = this.multiTargets[_mi];
            if (_mt === this.targetObject) continue;
            const _mtBefore = this.multiTargetMatricesBeforeDrag[_mi];
            if (!_mtBefore) continue;
            const _mtNew = applyDeltaToLocal(_mt, _mtBefore);
            _mtNew.decompose(_mt.position, _mt.quaternion, _mt.scale);
          }
          // Sync clip-plane math when user moves/rotates the visualization mesh.
          if (this.targetObject.userData.creator === "SdClippingPlane") {
            const label = this.targetObject.userData.clipLabel as string | undefined;
            if (label) this.updateClippingPlane(label, this.targetObject as THREE.Mesh);
          }
          // Sub-object: live refit parent geometry as handle moves.
          if (this.subTargetObject && mode === "translate") {
            const cpIndex = this.subTargetObject.userData.cpIndex as number;
            const parent = getHandleParent();
            if (parent && Array.isArray(parent.userData.controlPoints)) {
              const local = parent.worldToLocal(this.subTargetObject.position.clone());
              (parent.userData.controlPoints as THREE.Vector3[])[cpIndex].copy(local);
              refitParentGeometry(parent);
            }
          }
          // When the parent object (not a handle) is transformed, sync handle world positions.
          if (!this.subTargetObject) {
            const handleParent = getHandleParent();
            if (handleParent && handleParent === this.targetObject) {
              const cps = handleParent.userData.controlPoints as THREE.Vector3[] | undefined;
              const handles = getHandles();
              if (cps) {
                handleParent.updateMatrixWorld(true);
                for (let i = 0; i < handles.length && i < cps.length; i++) {
                  handles[i].position.copy(handleParent.localToWorld(cps[i].clone()));
                }
              }
            }
          }
        });

        g.addEventListener("dragging-changed", (ev) => {
          const dragging = (ev as THREE.Event & { value: boolean }).value;
          if (this.controls) this.controls.enabled = !dragging;
          for (const other of this.gizmos) {
            if (other !== g) other.enabled = !dragging;
          }
          // Snap settings — read at drag start.
          if (dragging) {
            const snap = getSnap();
            if (mode === "translate") {
              g.setTranslationSnap(snap.snapOn && snap.gridOn ? snap.step : null);
            } else if (mode === "rotate") {
              g.setRotationSnap(snap.snapOn && snap.polarOn ? (snap.angleStep * Math.PI) / 180 : null);
            } else if (mode === "scale") {
              g.setScaleSnap(snap.snapOn ? 0.1 : null);
            }
          }
          if (dragging && this.pivotProxy && this.targetObject) {
            // Dissolve the join group at drag start so the selected element
            // can move independently (group stays intact on mere click).
            if (this.targetObject instanceof THREE.Mesh) {
              dissolveGroupForMesh(this.targetObject.uuid, this.scene);
              resetWallCorners(this.targetObject);
              // Reset corners of walls that share an endpoint with the moved wall.
              // They keep miter-cut geometry otherwise, visible after separation.
              _dragResetNeighborIds = [];
              if (this.targetObject.userData?.creator === "wall") {
                const movedEps = this.targetObject.userData.endpoints as Array<{x: number; y: number}> | undefined;
                if (movedEps) {
                  const NEIGHBOR_EPS = 0.05;
                  this.scene.traverse((obj) => {
                    if (!(obj instanceof THREE.Mesh) || obj === this.targetObject) return;
                    if (obj.userData?.creator !== "wall") return;
                    const otherEps = obj.userData.endpoints as Array<{x: number; y: number}> | undefined;
                    if (!otherEps) return;
                    for (const ep of movedEps) {
                      for (const oep of otherEps) {
                        if (Math.hypot(ep.x - oep.x, ep.y - oep.y) < NEIGHBOR_EPS) {
                          resetWallCorners(obj);
                          _dragResetNeighborIds.push(obj.uuid);
                          return;
                        }
                      }
                    }
                  });
                }
              }
            }
            // Capture both pivot and target matrices at drag start so
            // objectChange can compute the live world-space delta.
            this.pivotMatrixBeforeDrag.copy(this.pivotProxy.matrix);
            this.targetMatrixBeforeDrag.copy(this.targetObject.matrix);
            this.multiTargetMatricesBeforeDrag = this.multiTargets.map(mt => mt.matrix.clone());
            // Capture transform snapshots for undo stack (recorded at drag-end).
            _dragStartSnapshot = captureTransform(this.targetObject);
            _dragStartMultiSnapshots = this.multiTargets.map(mt => captureTransform(mt));
          } else if (!dragging && this.pivotProxy && this.targetObject) {
            // Drag complete — geometry already updated live by objectChange.
            // Emit a chain fragment from the final world-space delta.
            const before = this.pivotMatrixBeforeDrag;
            const dWorld = new THREE.Matrix4().copy(this.pivotProxy.matrix).multiply(before.clone().invert());
            let fragment = "";
            if (mode === "translate") {
              const dx = r4(dWorld.elements[12]);
              const dy = r4(dWorld.elements[13]);
              const dz = r4(dWorld.elements[14]);
              if (dx !== 0 || dy !== 0 || dz !== 0) fragment = `.translate([${dx}, ${dy}, ${dz}])`;
            } else if (mode === "rotate") {
              const dPos = new THREE.Vector3();
              const dQuat = new THREE.Quaternion();
              const dScl = new THREE.Vector3();
              dWorld.decompose(dPos, dQuat, dScl);
              const s = Math.sqrt(1 - dQuat.w * dQuat.w);
              const axis = s < 1e-4 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(dQuat.x / s, dQuat.y / s, dQuat.z / s);
              const deg = r4((2 * Math.acos(Math.max(-1, Math.min(1, dQuat.w))) * 180) / Math.PI);
              if (deg !== 0) fragment = `.rotate(${deg}, [0,0,0], [${r4(axis.x)},${r4(axis.y)},${r4(axis.z)}])`;
            } else if (mode === "scale") {
              const dPos = new THREE.Vector3();
              const dQuat = new THREE.Quaternion();
              const dScl = new THREE.Vector3();
              dWorld.decompose(dPos, dQuat, dScl);
              const f = r4((dScl.x + dScl.y + dScl.z) / 3);
              if (f !== 1) fragment = `.scale(${f})`;
            }
            if (fragment && !this.subTargetObject) emitChainFragment(fragment);
            // Re-sync proxy from new target + current offset.
            this.syncPivot();
            // After a structural mesh is moved, re-evaluate join state.
            if (!this.subTargetObject && this.targetObject instanceof THREE.Mesh) {
              const _movedCreator = this.targetObject.userData?.creator as string | undefined;
              if (_movedCreator === "wall") {
                // Update stale world endpoints, then re-attempt parametric corner joins.
                recomputeWallEndpoints(this.targetObject);
                attemptWallCornerJoins(this.targetObject, this.scene);
                // Re-attempt joins for neighbors that were reset at drag-start,
                // so they reconnect to any remaining adjacent walls.
                for (const uuid of _dragResetNeighborIds) {
                  const neighbor = this.scene.getObjectByProperty("uuid", uuid);
                  if (neighbor instanceof THREE.Mesh) {
                    recomputeWallEndpoints(neighbor);
                    attemptWallCornerJoins(neighbor, this.scene);
                  }
                }
                _dragResetNeighborIds = [];
              } else if (isOpening(_movedCreator) && _dragStartSnapshot) {
                // AC3 (#875): restore old void, cut new void at current position.
                const _rerect = rerecutVoid(this.targetObject, this.scene);
                if (_rerect) {
                  beginTransaction("move-opening");
                  pushTransformAction(this.targetObject, _dragStartSnapshot);
                  pushReplaceAction(_rerect.newGroup, [_rerect.oldGroup], "wall-void-recut");
                  endTransaction();
                  _dragStartSnapshot = null;  // consumed by transaction — skip default push below
                }
              }
              onElementCommitted(this.targetObject, this.scene);
            }
            // Record transform on undo stack. Skip sub-object drags (control-point edits
            // rebuild geometry in-place and don't have a clean before/after snapshot).
            if (_dragStartSnapshot && !this.subTargetObject) {
              pushTransformAction(this.targetObject, _dragStartSnapshot);
              for (let _i = 0; _i < this.multiTargets.length; _i++) {
                if (_dragStartMultiSnapshots[_i]) pushTransformAction(this.multiTargets[_i], _dragStartMultiSnapshots[_i]);
              }
            }
            _dragStartSnapshot = null;
            _dragStartMultiSnapshots = [];
          }
        });
        g.userData.noSnap = true;
        g.userData.noRenderMode = true;
        g.traverse((child) => { child.userData.noSnap = true; child.userData.noRenderMode = true; });
        this.scene.add(g);
        return g;
      };
      this.gizmos = [makeGumball("translate"), makeGumball("rotate"), makeGumball("scale")];

      // Tighten axis-handle pickers + decouple line-shaft highlight.
      //
      // Selectability: three.js TC ships axis pickers as 0.6-long cones
      // running from origin to past the visible cube/arrow tip. Clicks
      // anywhere along the shaft therefore hit the picker, even though the
      // user clearly aimed for the cube/arrow. Replace each axis picker's
      // geometry with a small box at the actual tip (±0.5) so only direct
      // hits on the visible handle register.
      //
      // Highlight: the visible line-shaft mesh shares its axis name (X/Y/Z)
      // and material instance with the arrow/cube on that axis. TC's update
      // loop highlights every mesh whose name === current axis, so the line
      // turns yellow alongside the arrow. Rename the line-shaft meshes so
      // the name no longer matches the axis — highlight stays on the
      // arrow/cube only.
      const tightenAxisPickers = (g: TransformControls, mode: "translate" | "scale"): void => {
        const internal = g as unknown as { _gizmo: { picker: Record<string, THREE.Object3D>; gizmo: Record<string, THREE.Object3D> } };
        const pickerGroup = internal._gizmo.picker[mode];
        // Picker box dimensions (in handle-local). Tuned with `g.size` so
        // world-space pickers don't overlap (see size-selection comment in
        // makeGumball). Translate gets 0.25 because its arrow tip is at
        // world 0.125·camFactor and we want the picker to span [0.094,
        // 0.156]; scale gets 0.4 (generous because the visible cube is
        // tiny) and lands at world [0.0375, 0.0875].
        const pickerSize = mode === "scale" ? 0.4 : 0.25;
        if (pickerGroup) {
          pickerGroup.traverse((o: THREE.Object3D) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            if (o.name !== "X" && o.name !== "Y" && o.name !== "Z") return;
            // setupGizmo bakes the placement matrix into the geometry, so
            // boundingBox center reveals which side (+/-) of the origin the
            // picker sits on. Rebuild as a small box at ±0.5 along the
            // axis matching the handle's name.
            mesh.geometry.computeBoundingBox();
            const bb = mesh.geometry.boundingBox!;
            const cx = (bb.min.x + bb.max.x) / 2;
            const cy = (bb.min.y + bb.max.y) / 2;
            const cz = (bb.min.z + bb.max.z) / 2;
            let tx = 0, ty = 0, tz = 0;
            if (o.name === "X") tx = cx >= 0 ? 0.5 : -0.5;
            if (o.name === "Y") ty = cy >= 0 ? 0.5 : -0.5;
            if (o.name === "Z") tz = cz >= 0 ? 0.5 : -0.5;
            const newGeo = new THREE.BoxGeometry(pickerSize, pickerSize, pickerSize);
            newGeo.translate(tx, ty, tz);
            mesh.geometry.dispose();
            mesh.geometry = newGeo;
          });
        }
        const gizmoGroup = internal._gizmo.gizmo[mode];
        if (gizmoGroup) {
          gizmoGroup.traverse((o: THREE.Object3D) => {
            const mesh = o as THREE.Mesh;
            if (!mesh.isMesh) return;
            if (o.name !== "X" && o.name !== "Y" && o.name !== "Z") return;
            const geo = mesh.geometry as THREE.BufferGeometry & { parameters?: { radiusTop?: number; radiusBottom?: number } };
            const p = geo.parameters;
            // The line shaft is a thin CylinderGeometry (radius 0.0075).
            // The arrow head / scale cube has different geometry params or
            // none. Skip-renaming preserves the arrow/cube as the only
            // mesh that lights up on hover.
            if (p && p.radiusTop === 0.0075 && p.radiusBottom === 0.0075) {
              o.name = `${o.name}_shaft`;
            }
          });
        }
      };
      tightenAxisPickers(this.gizmos[0], "translate");
      tightenAxisPickers(this.gizmos[2], "scale");

      // Tighten the rotate-ring picker tubes. Three.js TC ships rotate
      // pickers with TorusGeometry tube radius 0.1 — 13× wider than the
      // visible ring tube (0.0075). Clicks anywhere within that fat tube
      // register as rotate hits, including the area between the visible
      // ring and adjacent axis-line content. Slim the picker tube to
      // 0.04 (still 5× the visible ring for clickability) so near-miss
      // clicks aimed at scale cubes or translate arrows don't bleed into
      // the rotate ring's hit zone.
      //
      // Also shrink the XYZE center-rotation sphere from 0.25 to 0.04.
      // The default 0.25 sphere has world radius ~0.094·camFactor —
      // engulfing the scale cube (at 0.0625·camFactor) and the entire
      // gumball interior. When the cursor lands inside that sphere,
      // rotate.axis sets to "XYZE", and the highlight loop's
      // `axis.split('').some(a => handle.name === a)` clause yellows
      // every X/Y/Z/E handle simultaneously (visible in screenshots as
      // "all rings glowing"). Tiny sphere = no accidental engulfing.
      {
        const internal = this.gizmos[1] as unknown as { _gizmo: { picker: { rotate: THREE.Object3D } } };
        internal._gizmo.picker.rotate.traverse((o: THREE.Object3D) => {
          const mesh = o as THREE.Mesh;
          if (!mesh.isMesh) return;
          if (o.name === "X" || o.name === "Y" || o.name === "Z") {
            const newGeo = new THREE.TorusGeometry(0.5, 0.04, 4, 24);
            mesh.geometry.dispose();
            mesh.geometry = newGeo;
          } else if (o.name === "XYZE") {
            mesh.geometry.dispose();
            mesh.geometry = new THREE.SphereGeometry(0.04, 8, 6);
          }
        });
      }

      // Capture per-axis cube + picker references on the scale gumball so
      // scale-axis relocate (cursor-follow stretch) can mutate them without
      // re-walking the gizmo every pointermove. Sign distinguishes the +/-
      // mesh on each axis, derived from boundingBox center.
      {
        const internal = this.gizmos[2] as unknown as { _gizmo: { gizmo: { scale: THREE.Object3D }; picker: { scale: THREE.Object3D } } };
        for (const axis of ["X", "Y", "Z"] as const) {
          const cubes: Array<{ mesh: THREE.Mesh; sign: number }> = [];
          const pickers: Array<{ mesh: THREE.Mesh; sign: number }> = [];
          internal._gizmo.gizmo.scale.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh || o.name !== axis) return;
            m.geometry.computeBoundingBox();
            const bb = m.geometry.boundingBox!;
            const c = axis === "X" ? (bb.min.x + bb.max.x) / 2 : axis === "Y" ? (bb.min.y + bb.max.y) / 2 : (bb.min.z + bb.max.z) / 2;
            cubes.push({ mesh: m, sign: c >= 0 ? 1 : -1 });
          });
          internal._gizmo.picker.scale.traverse((o) => {
            const m = o as THREE.Mesh;
            if (!m.isMesh || o.name !== axis) return;
            m.geometry.computeBoundingBox();
            const bb = m.geometry.boundingBox!;
            const c = axis === "X" ? (bb.min.x + bb.max.x) / 2 : axis === "Y" ? (bb.min.y + bb.max.y) / 2 : (bb.min.z + bb.max.z) / 2;
            pickers.push({ mesh: m, sign: c >= 0 ? 1 : -1 });
          });
          this.scaleArmRefs.set(axis, { cubes, pickers });
        }
      }

      // Cursor-follow relocate: double-click a gumball handle to enter
      // relocate mode anchored to that handle's axis/plane. Pointer-move
      // updates the pivot in real time. A single click anywhere exits.
      //
      // Hover-tracking listener — bubble phase, runs after TC's hover
      // updates so we read the freshly-set axis. Without this, TC.axis is
      // stale by the time `dblclick` fires (both pointerup events ran
      // first) and the dblclick handler can't tell which handle was hit.
      // Clearing on hover-off prevents stale-entry false positives.
      perspPane.body.addEventListener("pointermove", () => {
        for (const g of this.gizmos) {
          const a = (g as unknown as { axis: string | null }).axis;
          if (a) {
            this.lastHover = {
              mode: (g as unknown as { mode: "translate" | "rotate" | "scale" }).mode,
              axis: a,
              ts: performance.now(),
            };
            return;
          }
        }
        this.lastHover = null;
      });
      // Pointermove drives the cursor-follow update while in relocate mode.
      perspPane.body.addEventListener("pointermove", (e: PointerEvent) => this.onRelocateMove(e, perspPane));
      // Capture-phase pointerdown handles BOTH dblclick-entry and exit.
      // Manual dblclick detection — e.detail is unreliable across pointer
      // hardware / OS combos. Track timestamp+position of the previous
      // pointerdown; treat a second down within 500ms and ≤10px as the
      // "second click" of a double-click gesture. This fires SYNCHRONOUSLY
      // with the user's second mousedown, BEFORE TC's bubble handler can
      // start a fresh drag, so stopImmediatePropagation cleanly blocks
      // the redundant TC drag-start.
      perspPane.body.addEventListener("pointerdown", (e: PointerEvent) => {
        const now = performance.now();
        const dx = e.clientX - this.lastClickPos.x;
        const dy = e.clientY - this.lastClickPos.y;
        const isDbl = (now - this.lastClickTs) < 500 && Math.hypot(dx, dy) < 10;

        if (this.relocate.active) {
          // Any pointerdown while in relocate exits. Don't refresh
          // lastClick because exit clicks aren't drag starts.
          this.onRelocateExit(e);
          return;
        }
        // Visible breadcrumb so we can verify the path runs.
        console.log("[relocate] pointerdown detail=", e.detail, "isDbl=", isDbl, "lastHover=", this.lastHover);
        if (isDbl) {
          this.onDblclickHandle(e, perspPane);
          if (this.relocate.active) {
            e.preventDefault();
            e.stopImmediatePropagation();
            e.stopPropagation();
          }
          // Reset so a triple-click doesn't double-fire.
          this.lastClickTs = 0;
          this.lastClickPos = { x: 0, y: 0 };
          return;
        }
        // Normal first click — record for future dblclick detection.
        // Also snapshot the current pivot+target matrices so a subsequent
        // dblclick can roll back to this exact pose (independent of
        // whether TC.dragging-changed fired in between — see field doc).
        this.lastClickTs = now;
        this.lastClickPos = { x: e.clientX, y: e.clientY };
        if (this.pivotProxy && this.targetObject) {
          this.pivotProxy.updateMatrix();
          this.targetObject.updateMatrix();
          this.dblclickPivotStart.copy(this.pivotProxy.matrix);
          this.dblclickTargetStart.copy(this.targetObject.matrix);
        }
        // Closest-hit gumball priority: when the click overlaps multiple
        // gumball pickers (translate vs scale on the same axis), three.js
        // would otherwise hand the click to whichever TC was registered
        // first (translate), so scale handles never get to drive a drag.
        // Disable the losers for the duration of THIS click so the winner
        // is the only TC that processes pointerdown.
        this.resolveGumballPriority(e, perspPane);
      }, true);
    }

    // Palette Move/Rotate/Scale + G/R/S hotkeys are still wired in app-state
    // but no longer toggle a single gizmo mode (all three modes visible at
    // all times in the Rhino-style Gumball). The activeTool subscription
    // intentionally goes nowhere on the viewer side now — palette selection
    // still affects sketch tools (Wall/Slab/Line/etc.) via tools/index.ts.
    subscribe("activeTool", () => { /* no-op for gumball; tools/index.ts owns sketch tools */ });

    // Del / Backspace removes the selected object. Operates on
    // targetObject (the geometry) rather than gizmo.object (the pivot
    // proxy) since the gumball is always attached to the proxy.
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (this.gizmos.length === 0 || document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
      // ESC: sub-object → parent → none (Rhino sub-object model)
      if (e.key === "Escape") {
        if (this.subTargetObject) {
          this.clearSubSelection();
          e.preventDefault();
          return;
        }
        if (this.targetObject) {
          this.selectObject(null);
          clearSelected();
          window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
          e.preventDefault();
          return;
        }
      }
      if (e.key === "f" || e.key === "F") {
        this.frameAllVisible();
        e.preventDefault();
        return;
      }
      if (e.key === "Delete" || e.key === "Backspace") {
        // Ignore Delete while in sub-object mode — ESC back to parent first.
        if (this.subTargetObject) return;
        // deleteSelected() handles both direct scene children and IFC sub-meshes
        // (children of the IFC wrapper Group, not direct scene children).
        this.deleteSelected();
      }
    });

    // Floating badge in the persp pane that flips visible/hidden when
    // relocate mode toggles. Inserted into viewport-area-host so it
    // sits above the canvas without disturbing the workbench layout.
    this.relocateBadge = document.createElement("div");
    this.relocateBadge.className = "relocate-badge";
    this.relocateBadge.textContent = "RELOCATE GUMBALL";
    this.relocateBadge.style.display = "none";
    viewportAreaEl.appendChild(this.relocateBadge);

    // Rebuild the grid whenever the snap step changes so the visible grid
    // lines match the snap increment exactly. Without this, dragging snaps
    // to a step that has no visible reference and looks wrong.
    subscribeSnap(() => this.rebuildGrid());
    // Sync initial grid to the snap step that was set before this constructor
    // ran (e.g. imperial 0.3048 m from PR #799 unitSystem init in snap-state.ts).
    this.rebuildGrid();

    this.animate();
  }

  // Rebuild this.grid using the current bounds + snap step. Called on
  // first scene load (via fitCamera) and whenever the user changes STEP
  // in the snap dock. Divisions = sceneSize / step (clamped to a sane
  // upper bound so a 1mm step on a 100m scene doesn't hang the GPU).
  private rebuildGrid(): void {
    const sceneSize = (this.grid as unknown as { __lastSize?: number }).__lastSize ?? 20;
    const step = Math.max(0.001, getSnap().step);
    const divisions = Math.min(500, Math.max(4, Math.round(sceneSize / step)));
    this.scene.remove(this.grid);
    this.grid.geometry.dispose();
    this.grid = new THREE.GridHelper(sceneSize, divisions, 0xa8a8b0, 0xd8d4cc);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.renderOrder = -1;
    const gMat = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
    for (const m of gMat) {
      const lm = m as THREE.LineBasicMaterial;
      lm.depthWrite = false;
      lm.transparent = true;
      lm.opacity = 0.55;
      lm.needsUpdate = true;
    }
    this.grid.userData.noSnap = true;
    this.grid.userData.noRenderMode = true;
    (this.grid as unknown as { __lastSize?: number }).__lastSize = sceneSize;
    this.scene.add(this.grid);
  }

  private _applyClearColor(): void {
    // Read the theme's paper-base color from CSS and use it as the opaque
    // clear color so the canvas owns the background (instead of .viewport CSS).
    const dummy = document.createElement("span");
    dummy.style.cssText = "position:fixed;left:-9999px;background:var(--canvas-bg)";
    document.body.appendChild(dummy);
    const bg = getComputedStyle(dummy).backgroundColor;
    document.body.removeChild(dummy);
    this.renderer.setClearColor(new THREE.Color(bg), 1.0);
  }

  private handleResize(): void {
    const rect = this.canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width));
    const h = Math.max(1, Math.floor(rect.height));
    this.renderer.setSize(w, h, false);
    for (const pane of this.panes) {
      if (pane.camera instanceof THREE.OrthographicCamera) {
        const pr = pane.el.getBoundingClientRect();
        const aspect = pr.width > 0 && pr.height > 0 ? pr.width / pr.height : 1;
        const half = 5;
        pane.camera.left = -half * aspect;
        pane.camera.right = half * aspect;
        pane.camera.top = half;
        pane.camera.bottom = -half;
        pane.camera.updateProjectionMatrix();
      } else if (pane.camera instanceof THREE.PerspectiveCamera) {
        const pr = pane.el.getBoundingClientRect();
        if (pr.width > 0 && pr.height > 0) {
          (pane.camera as THREE.PerspectiveCamera).aspect = pr.width / pr.height;
          pane.camera.updateProjectionMatrix();
        }
      }
    }
  }

  private onCanvasMouseDown(e: MouseEvent): void {
    // W-6 host-pick: intercept before all other logic.
    if (this._hostPickCallback) {
      const cb = this._hostPickCallback;
      this._hostPickCallback = null;
      this.canvas.style.cursor = "";
      const cx = e.clientX, cy = e.clientY;
      const hitPane = this.panes.find(p => {
        const r = p.el.getBoundingClientRect();
        return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
      });
      if (hitPane) {
        const pr = hitPane.el.getBoundingClientRect();
        const ndcX = ((cx - pr.left) / pr.width) * 2 - 1;
        const ndcY = -((cy - pr.top) / pr.height) * 2 + 1;
        this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), hitPane.camera);
        const gizmoSet = new Set<THREE.Object3D>(this.gizmos);
        const pickables = this.scene.children.filter(
          c => c !== this.grid && c !== this.axes && !(c instanceof THREE.Sprite) &&
               !(c instanceof THREE.DirectionalLight) && !(c instanceof THREE.AmbientLight) &&
               !gizmoSet.has(c) && c !== this.pivotProxy && c !== this._cplaneGizmo.group
        );
        const hits = this.raycaster.intersectObjects(pickables, true);
        const hit = hits[0];
        if (hit?.face) {
          const worldNormal = hit.face.normal.clone()
            .transformDirection(hit.object.matrixWorld)
            .normalize();
          const up = new THREE.Vector3(0, 0, 1);
          let xAxis = new THREE.Vector3().crossVectors(up, worldNormal);
          if (xAxis.lengthSq() < 1e-6) xAxis.set(1, 0, 0);
          xAxis.normalize();
          const yAxis = new THREE.Vector3().crossVectors(worldNormal, xAxis).normalize();
          const cplane: CPlane = {
            origin: hit.point.clone(),
            xAxis, yAxis,
            normal: worldNormal,
            name: "Host Face",
            kind: "host-derived" as const,
          };
          cb(cplane);
        }
      }
      return;
    }

    const tool = getState("activeTool");
    // move/rotate/scale mousedown just ensures the gizmo mode is set (already
    // wired via subscribe). Picking a new object is "select"-only — other
    // tools should not change the current selection on click.
    if (tool !== "select" && tool !== "move" && tool !== "rotate" && tool !== "scale") return;

    // Identify which pane was clicked by checking which pane rect contains the pointer.
    const cx = e.clientX, cy = e.clientY;
    const hitPane = this.panes.find(p => {
      const r = p.el.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    });
    if (!hitPane) return;

    // Transform tools skip re-picking when something is already selected so
    // OrbitControls/TransformControls own the drag natively. But with nothing
    // selected, fall through to the picker so the user can click to select.
    if ((tool === "move" || tool === "rotate" || tool === "scale") && this.targetObject !== null) return;
    // If a gumball handle is hovered/active (axis set) or dragging, do not
    // run selection picking on this pointerdown. Otherwise selection updates
    // race with TransformControls pointerdown and break handle drags.
    if (this.gizmos.some((g) => (g as unknown as { axis: string | null }).axis !== null)) return;
    if (this.isAnyGumballDragging()) return;

    const pr = hitPane.el.getBoundingClientRect();
    const ndcX = ((cx - pr.left) / pr.width) * 2 - 1;
    const ndcY = -((cy - pr.top) / pr.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), hitPane.camera);
    const gizmoSet = new Set<THREE.Object3D>(this.gizmos);
    const pickables = this.scene.children.filter(
      c => c !== this.grid && c !== this.axes && !(c instanceof THREE.Sprite) &&
           !(c instanceof THREE.DirectionalLight) && !(c instanceof THREE.AmbientLight) &&
           !gizmoSet.has(c) && c !== this.pivotProxy && c !== this._cplaneGizmo.group
    );
    const hits = this.raycaster.intersectObjects(pickables, true);
    // Handles render without depth-test so they must be selectable even when
    // geometrically behind walls. If any handle appears in the hit list (at any
    // depth), prefer it over closer wall hits.
    const handleSet = new Set(getHandles());
    const handleHit = hits.find(h => handleSet.has(h.object) || (h.object.parent !== null && handleSet.has(h.object.parent)));
    // #950: Three.js intersectObjects does not check visibility — filter out objects
    // whose effective visibility is false (hidden level, hidden layer, etc.).
    const visibleHit = hits.find(h => {
      let o: THREE.Object3D | null = h.object;
      while (o) { if (!o.visible) return false; o = o.parent; }
      // #964: skip objects on locked or hidden drawing layers.
      const dlId = h.object.userData.drawingLayerId as string | undefined;
      if (dlId) { const dl = drawingLayerStore.get(dlId); if (dl && (!dl.visible || dl.locked)) return false; }
      return true;
    });
    let hit = (handleHit ?? visibleHit)?.object ?? null;
    // CSG display mesh hit: redirect selection to the nearest logical member
    // WITHOUT dissolving the group — the join stays intact until the user drags.
    if (hit?.userData?.isJoinDisplay) {
      const groupId = hit.userData.joinGroupId as string | undefined;
      if (groupId) {
        const hitPoint = hits[0]?.point ?? new THREE.Vector3();
        const nearest = nearestGroupMember(groupId, hitPoint, this.scene);
        if (nearest) hit = nearest;
      }
    }
    // IFC-imported meshes carry expressID and represent individual elements —
    // use the hit mesh directly. Other objects: walk to parent group/mesh.
    const isIfcElement = (hit?.userData?.expressID) != null;
    const transformTarget = isIfcElement
      ? hit
      : (hit?.parent instanceof THREE.Mesh || hit?.parent instanceof THREE.Group ? hit.parent : hit);
    const uuid = transformTarget?.uuid ?? null;
    // Sub-object handle click: enter handle-level selection without clearing parent handles.
    if (transformTarget && isSubObjectHandle(transformTarget)) {
      this.selectSubObject(transformTarget);
      return;
    }
    if (transformTarget) {
      this.selectObject(transformTarget);
      setSelected({
        topology: "mesh",
        uuid: transformTarget.uuid,
        object: transformTarget,
        transformTarget,
      });
      window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid } }));
    } else {
      // Defer deselect to pointerup so orbit drags don't clear the gumball.
      const px0 = e.clientX, py0 = e.clientY;
      const host = e.currentTarget as HTMLElement;
      const clearOnUp = (up: PointerEvent) => {
        host.removeEventListener("pointerup", clearOnUp);
        if ((up.clientX - px0) ** 2 + (up.clientY - py0) ** 2 < 64) {
          this.selectObject(null);
          clearSelected();
          window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
        }
      };
      host.addEventListener("pointerup", clearOnUp);
    }
  }

  /** Attach the Rhino-style Gumball to an object (null = detach). The
   *  three TransformControls always attach to the pivot proxy, never to
   *  the geometry directly. A genuine selection change (different object)
   *  resets pivotOffset to identity so the gumball recenters on the new
   *  target. Re-selecting the SAME object preserves any prior relocate
   *  offset — otherwise every click after relocate would snap the gumball
   *  back to the centroid. */
  selectObject(obj: THREE.Object3D | null): void {
    this.multiTargets = [];
    this.multiTargetMatricesBeforeDrag = [];
    // Exit any active sub-selection before switching to a new parent target.
    this.subTargetObject = null;
    // Persist current target's pivotOffset before switching so a deselect →
    // reselect cycle (or a select → other-object → back) restores the user's
    // last relocated gumball position instead of resetting to the centroid.
    if (this.targetObject) {
      this.pivotOffsetByUuid.set(
        this.targetObject.uuid,
        this.pivotOffset.clone(),
      );
    }
    this.targetObject = obj;
    if (obj) {
      const cached = this.pivotOffsetByUuid.get(obj.uuid);
      if (cached) this.pivotOffset.copy(cached);
      else this.pivotOffset.identity();
    } else {
      this.pivotOffset.identity();
    }
    this.relocate.active = false;
    this.updateRelocateBadge();
    // Show CP handles for line/polyline/curve; clear for everything else.
    const handleCreators = new Set(["line", "polyline", "curve", "wall"]);
    if (obj && handleCreators.has(obj.userData.creator as string)) {
      showHandlesFor(obj, this);
    } else {
      clearHandles(this);
    }
    if (!this.pivotProxy) {
      // Constructor couldn't create one (no perspPane) — selection is a
      // no-op in that case.
      return;
    }
    if (obj) {
      this.syncPivot();
      if (this._gumballEnabled) {
        for (const g of this.gizmos) g.attach(this.pivotProxy);
      }
    } else {
      for (const g of this.gizmos) g.detach();
    }
  }

  /** Suppress or restore the gumball. Pass false while op-tools are running. */
  /** Set multiple selected objects. Positions gumball at their centroid;
   *  all objects move together when any gumball handle is dragged. */
  setMultiTargets(targets: THREE.Object3D[]): void {
    if (targets.length === 0) { this.selectObject(null); return; }
    this.multiTargets = [...targets];
    this.multiTargetMatricesBeforeDrag = [];
    this.subTargetObject = null;
    if (this.targetObject) {
      this.pivotOffsetByUuid.set(this.targetObject.uuid, this.pivotOffset.clone());
    }
    this.targetObject = targets[0];
    this.pivotOffset.identity();
    this.relocate.active = false;
    this.updateRelocateBadge();
    clearHandles(this);
    if (!this.pivotProxy) return;
    this.syncPivot();
    if (this._gumballEnabled) {
      for (const g of this.gizmos) g.attach(this.pivotProxy);
    }
  }

  getTargetObject(): THREE.Object3D | null { return this.targetObject; }

  /** Deselect + clear gizmo + fire viewer:select{uuid:null}. Used by history
   *  undo/redo when the selected object is removed from the scene. */
  deselectCurrent(): void {
    this.selectObject(null);
    clearSelected();
    window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
  }

  toggleCPlaneGizmo(): void {
    this._cplaneGizmo.toggle();
  }

  startHostPick(cb: (cplane: CPlane) => void): void {
    this._hostPickCallback = cb;
    this.canvas.style.cursor = "crosshair";
  }

  cancelHostPick(): void {
    this._hostPickCallback = null;
    this.canvas.style.cursor = "";
  }

  setGumballEnabled(enabled: boolean): void {
    this._gumballEnabled = enabled;
    if (!enabled) {
      for (const g of this.gizmos) g.detach();
    } else if (this.targetObject && this.pivotProxy) {
      this.syncPivot();
      for (const g of this.gizmos) g.attach(this.pivotProxy);
    }
  }

  setGridAxesVisible(visible: boolean): void {
    this.grid.visible = visible;
    this.axes.visible = visible;
    this._cplaneGizmo.group.visible = visible;
  }

  /** Enter sub-object mode: gumball attaches to the CP handle sphere.
   *  Handles stay visible; parent geometry refits live as the handle moves. */
  selectSubObject(handle: THREE.Object3D): void {
    this.subTargetObject = handle;
    if (this.targetObject) {
      this.pivotOffsetByUuid.set(this.targetObject.uuid, this.pivotOffset.clone());
    }
    this.targetObject = handle;
    this.pivotOffset.identity();
    this.relocate.active = false;
    this.updateRelocateBadge();
    if (!this.pivotProxy) return;
    this.syncPivot();
    for (const g of this.gizmos) g.attach(this.pivotProxy);
  }

  /** Exit sub-object mode: drop gumball back to the parent curve/line. */
  clearSubSelection(): void {
    if (!this.subTargetObject) return;
    this.subTargetObject = null;
    const parent = getHandleParent();
    if (parent && this.pivotProxy) {
      if (this.targetObject) {
        this.pivotOffsetByUuid.set(this.targetObject.uuid, this.pivotOffset.clone());
      }
      this.targetObject = parent;
      const cached = this.pivotOffsetByUuid.get(parent.uuid);
      if (cached) this.pivotOffset.copy(cached);
      else this.pivotOffset.identity();
      this.syncPivot();
      for (const g of this.gizmos) g.attach(this.pivotProxy);
    } else {
      this.targetObject = null;
      this.pivotOffset.identity();
      for (const g of this.gizmos) g.detach();
      clearHandles(this);
    }
  }

  /** Delete the currently selected object(s). Handles both single and multi-selection. */
  deleteSelected(): boolean {
    // Collect all targets: multiTargets when a multi-selection is active, else single targetObject.
    const targets: THREE.Object3D[] = this.multiTargets.length > 0
      ? [...this.multiTargets]
      : (this.targetObject ? [this.targetObject] : []);
    if (targets.length === 0) return false;

    let anyRemoved = false;
    for (const removed of targets) {
      // If this mesh is a logical member of a CSG join group, dissolve the group
      // first — removes the display mesh and makes all other members visible as
      // standalone walls. No-op when the mesh is not in any group.
      dissolveGroupForMesh(removed.uuid, this.scene);
      // If the deleted object is a clip plane, remove the mathematical plane so
      // the clipping effect is lifted along with the visualization mesh.
      const clipLabel = removed.userData.clipLabel as string | undefined;
      if (clipLabel) this.removeClippingPlane(clipLabel);
      // IFC sub-meshes are children of currentObject (not direct scene children);
      // remove from their actual parent so scene.remove() doesn't silently no-op.
      const removedParent = removed.parent;
      if (removed.parent === this.scene) {
        this.scene.remove(removed);
      } else if (removed.parent) {
        removed.parent.remove(removed);
      } else {
        continue;
      }
      // Geometry is NOT disposed here — pushDeleteAction keeps it alive so undo
      // can re-add the object. Disposal happens in clearHistory() on scene wipe.
      const _creator = (removed.userData as Record<string, unknown>).creator as string | undefined;
      const _voidRestore = isOpening(_creator)
        ? restoreVoidCut(removed, this.scene) : null;
      // Wrap delete + void-restore in one atomic undo group (#875).
      if (_voidRestore) beginTransaction("delete-opening");
      pushDeleteAction(removed, removedParent);
      if (_voidRestore) {
        pushReplaceAction(_voidRestore.newWall, [_voidRestore.oldGroup], "wall-void-restore");
        endTransaction();
      }
      this.pivotOffsetByUuid.delete(removed.uuid);
      anyRemoved = true;
    }

    if (anyRemoved) {
      this.targetObject = null;
      this.multiTargets = [];
      this.pivotOffset.identity();
      this.relocate.active = false;
      for (const g of this.gizmos) g.detach();
      this.updateRelocateBadge();
      emitChainFragment(`// removed: ${targets.length} object(s)`);
      clearSelected();
      window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
      // Rebuild fill so deleted solids' cross-sections disappear.
      if (this._sectionPlanes.length > 0 || this._clipPlanes.length > 0) this._rebuildFill();
    }
    return anyRemoved;
  }

  // Sync the pivot proxy from targetObject + pivotOffset. Called every
  // animation frame between drags so external transforms (e.g. agent
  // chain replays) don't strand the gumball at a stale pose.
  private syncPivot(): void {
    if (!this.pivotProxy) return;
    if (this.multiTargets.length > 1) {
      // Multi-select: place gumball at centroid of all selected objects.
      const centroid = new THREE.Vector3();
      for (const mt of this.multiTargets) centroid.add(new THREE.Vector3().setFromMatrixPosition(mt.matrix));
      centroid.divideScalar(this.multiTargets.length);
      this.pivotProxy.position.copy(centroid);
      this.pivotProxy.quaternion.identity();
      this.pivotProxy.scale.set(1, 1, 1);
      this.pivotProxy.updateMatrix();
      this.pivotProxy.matrixWorldNeedsUpdate = true;
      return;
    }
    if (!this.targetObject) return;
    // IFC element meshes bake geometry in world-space vertices; mesh.position is (0,0,0)
    // local, so the normal matrix path puts the gumball at the wrapper origin (shared by
    // all elements). Compute the world-space bbox centroid fresh each frame so the gumball
    // tracks correctly after undo/redo (stale cache caused gumball to lag behind).
    if (this.targetObject.userData?.expressID != null) {
      const box = new THREE.Box3().setFromObject(this.targetObject);
      box.getCenter(this.pivotProxy.position);
      this.pivotProxy.quaternion.identity();
      this.pivotProxy.scale.set(1, 1, 1);
      this.pivotProxy.updateMatrix();
      this.pivotProxy.matrixWorldNeedsUpdate = true;
      return;
    }
    this.pivotProxy.matrix.copy(this.targetObject.matrix).multiply(this.pivotOffset);
    this.pivotProxy.matrix.decompose(
      this.pivotProxy.position,
      this.pivotProxy.quaternion,
      this.pivotProxy.scale,
    );
    this.pivotProxy.matrixWorldNeedsUpdate = true;
  }

  private isAnyGumballDragging(): boolean {
    for (const g of this.gizmos) {
      if ((g as unknown as { dragging?: boolean }).dragging) return true;
    }
    return false;
  }

  // Show/hide the RELOCATE badge based on relocate.active + selection state.
  private updateRelocateBadge(): void {
    if (!this.relocateBadge) return;
    const visible = this.relocate.active && !!this.targetObject;
    this.relocateBadge.style.display = visible ? "flex" : "none";
    if (visible) {
      const verb = this.relocate.mode === "rotate" ? "ROTATE" : "MOVE";
      this.relocateBadge.textContent = `RELOCATE GUMBALL · ${verb} ${this.relocate.axis}`;
    }
  }

  // Cursor-follow relocate — Rhino-style. Double-click a translate arrow
  // (X/Y/Z) or plane handle (XY/XZ/YZ) and the gumball follows the cursor
  // along that axis/plane. Double-click a rotation ring (X/Y/Z) and the
  // gumball rotates around that axis with the cursor. Single-click anywhere
  // exits. Geometry stays put — only pivotOffset moves.
  //
  // Detection strategy: try lastHover first (set by the bubble-phase
  // pointermove tracker, fastest path). If null, fall back to a direct
  // raycast against each gumball's named handle children — no dependency
  // on TC's transient `axis` field.
  private onDblclickHandle(e: MouseEvent, pane: Pane): void {
    if (this.relocate.active) return;
    if (!this.pivotProxy || !this.targetObject) return;
    let mode: "translate" | "rotate" | "scale";
    let axis: string;
    if (this.lastHover) {
      mode = this.lastHover.mode;
      axis = this.lastHover.axis;
    } else {
      // Direct raycast fallback. Build a per-gumball target list of named
      // handle children, hit-test against the cursor ray, pick the closest.
      const pr = pane.el.getBoundingClientRect();
      const ndcX = ((e.clientX - pr.left) / pr.width) * 2 - 1;
      const ndcY = -((e.clientY - pr.top) / pr.height) * 2 + 1;
      this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), pane.camera);
      const HANDLE_NAMES = new Set(["X", "Y", "Z", "XY", "XZ", "YZ", "XYZ", "E", "XYZE"]);
      let best: { mode: "translate" | "rotate" | "scale"; axis: string; distance: number } | null = null;
      for (const g of this.gizmos) {
        const m = (g as unknown as { mode: "translate" | "rotate" | "scale" }).mode;
        const targets: THREE.Object3D[] = [];
        g.traverse((o) => { if (HANDLE_NAMES.has(o.name)) targets.push(o); });
        if (targets.length === 0) continue;
        const hits = this.raycaster.intersectObjects(targets, true);
        if (hits[0] && (best === null || hits[0].distance < best.distance)) {
          let node: THREE.Object3D | null = hits[0].object;
          while (node && !HANDLE_NAMES.has(node.name)) node = node.parent;
          if (node?.name) best = { mode: m, axis: node.name, distance: hits[0].distance };
        }
      }
      if (!best) {
        console.warn("[relocate] dblclick on no handle — raycast missed");
        return;
      }
      mode = best.mode;
      axis = best.axis;
    }
    e.preventDefault();
    e.stopPropagation();
    // Roll back any pose drift between the two clicks of the dblclick
    // gesture. We snapshot pivotProxy.matrix + targetObject.matrix on the
    // FIRST click of the dblclick (in the "Normal first click" branch of
    // the capture-phase pointerdown listener). Restoring from those
    // dedicated fields is correct regardless of whether TC.dragging-changed
    // fired between clicks — pivotMatrixBeforeDrag was unsafe here because
    // it could hold a stale value from an earlier unrelated drag, snapping
    // geometry to that prior pose on entry.
    this.dblclickPivotStart.decompose(
      this.pivotProxy.position,
      this.pivotProxy.quaternion,
      this.pivotProxy.scale,
    );
    this.pivotProxy.updateMatrix();
    this.dblclickTargetStart.decompose(
      this.targetObject.position,
      this.targetObject.quaternion,
      this.targetObject.scale,
    );
    this.targetObject.updateMatrix();
    this.relocate.pivotStart.copy(this.pivotProxy.matrix);
    this.relocate.mode = mode;
    this.relocate.axis = axis;
    this.relocate.pane = pane;
    // Pre-compute host-geometry snap candidates from the target's vertices
    // + edge midpoints for cursor-snap during cursor-follow motion.
    this.buildSnapCandidates();
    // For scale-axis relocate, capture the current arm world-length so we
    // can convert subsequent cursor distances into a stretch factor. The
    // gumball's per-frame world scale = factor * size / 4 (per TC.update),
    // so a unit-length axis vector in handle-local maps to that magnitude
    // in world. The cube tip sits at 0.5 in handle-local before stretch,
    // so default arm-world-length = (factor * size / 4) * 0.5 * armFactor.
    if (mode === "scale" && (axis === "X" || axis === "Y" || axis === "Z")) {
      const cam = pane.camera;
      const camPos = new THREE.Vector3();
      cam.getWorldPosition(camPos);
      const pivotPos = new THREE.Vector3();
      this.pivotProxy.getWorldPosition(pivotPos);
      let camFactor: number;
      if ((cam as THREE.OrthographicCamera).isOrthographicCamera) {
        const oc = cam as THREE.OrthographicCamera;
        camFactor = (oc.top - oc.bottom) / oc.zoom;
      } else {
        const pc = cam as THREE.PerspectiveCamera;
        camFactor = pivotPos.distanceTo(camPos) * Math.min(1.9 * Math.tan((Math.PI * pc.fov) / 360) / pc.zoom, 7);
      }
      const scaleSize = 0.55; // matches `g.size` for scale gumball (see makeGumball)
      this.scaleArmStartLength = camFactor * scaleSize / 4 * 0.5 * this.scaleArmFactor[axis];
    }
    const proj = this.projectCursorForHandle(e, pane, mode, axis);
    if (!proj) return;
    this.relocate.cursorStart.copy(proj);
    this.relocate.active = true;
    // Disable all gumballs and OrbitControls so pointer-move drives only
    // the pivot. Detach gumballs from the proxy so TC pointerdown handlers
    // can't even be reached on the second click of the dblclick gesture.
    for (const g of this.gizmos) g.enabled = false;
    if (this.controls) this.controls.enabled = false;
    this.updateRelocateBadge();
    // Visible breadcrumb in the browser console — use this to verify the
    // entry path is actually firing on Jun's session (look for it in the
    // Chrome DevTools Console after a dblclick).
    console.log("[relocate] entered:", mode, axis);
  }

  private onRelocateMove(e: PointerEvent, pane: Pane): void {
    if (!this.relocate.active || this.relocate.pane !== pane) return;
    if (!this.pivotProxy) return;
    const cursorAxisProj = this.projectCursorForHandle(e, pane, this.relocate.mode, this.relocate.axis);
    if (!cursorAxisProj) return;
    // Host-geometry snap. When snap fires, the gumball's CENTER lands on
    // the snap point — not the clicked handle's tip. Per Rhino's relocate-
    // gumball semantics, the snap point is the destination of the gumball
    // origin, not of the cursor or the dragged handle. When snap doesn't
    // fire, we fall back to cursor-tracking (delta-from-cursor-start) so
    // the clicked handle follows the cursor naturally.
    const snap = this.applyHostSnap(cursorAxisProj, pane);
    const proj = snap.point;

    const startPos = new THREE.Vector3();
    const startQuat = new THREE.Quaternion();
    const startScl = new THREE.Vector3();
    this.relocate.pivotStart.decompose(startPos, startQuat, startScl);

    if (this.relocate.mode === "rotate") {
      // Rotation: angle from (cursorStart→center) to (proj→center) in the
      // plane perpendicular to the rotation axis. Apply that delta to
      // pivotStart's orientation.
      const axisLocal = this.axisVectorLocal(this.relocate.axis);
      const axisWorld = axisLocal.clone().applyQuaternion(startQuat).normalize();
      const v0 = new THREE.Vector3().subVectors(this.relocate.cursorStart, startPos);
      const v1 = new THREE.Vector3().subVectors(proj, startPos);
      v0.sub(axisWorld.clone().multiplyScalar(v0.dot(axisWorld)));
      v1.sub(axisWorld.clone().multiplyScalar(v1.dot(axisWorld)));
      if (v0.lengthSq() < 1e-8 || v1.lengthSq() < 1e-8) return;
      v0.normalize();
      v1.normalize();
      const angle = Math.atan2(v0.clone().cross(v1).dot(axisWorld), v0.dot(v1));
      const dq = new THREE.Quaternion().setFromAxisAngle(axisWorld, angle);
      this.pivotProxy.position.copy(startPos);
      this.pivotProxy.quaternion.copy(startQuat).premultiply(dq);
      this.pivotProxy.scale.copy(startScl);
    } else if (this.relocate.mode === "scale" && (this.relocate.axis === "X" || this.relocate.axis === "Y" || this.relocate.axis === "Z")) {
      // Scale-axis relocate: gumball center stays put, the cube tip stretches
      // along the axis to track the cursor. Compute the cursor's signed
      // distance from pivot center along the rotated axis, divide by the
      // arm length captured at dblclick entry to get a stretch factor, and
      // apply via geometry rebuild. Pivot pose unchanged — only the visible
      // arm + invisible picker box move. Use raw (pre-snap) projection so
      // host-vertex snap doesn't pull the cursor off-axis and corrupt the
      // distance.
      const axisLocal = this.axisVectorLocal(this.relocate.axis);
      const axisWorld = axisLocal.clone().applyQuaternion(startQuat).normalize();
      const cursorOffset = new THREE.Vector3().subVectors(cursorAxisProj, startPos);
      const cursorDist = cursorOffset.dot(axisWorld);
      // Use absolute distance — the stretch is symmetric. User can have
      // clicked either the +/- cube; in both cases dragging away from the
      // pivot grows the arm and dragging toward it shrinks it. Clamp to
      // a sensible range so a flick doesn't fling the arm off-screen
      // (upper) or collapse it onto the origin (lower).
      const factor = Math.max(0.1, Math.min(8, Math.abs(cursorDist) / Math.max(1e-6, this.scaleArmStartLength)));
      this.setScaleArmFactor(this.relocate.axis as "X" | "Y" | "Z", factor);
      // Pivot pose stays identical — restoring from start is a no-op but
      // keeps invariants explicit.
      this.pivotProxy.position.copy(startPos);
      this.pivotProxy.quaternion.copy(startQuat);
      this.pivotProxy.scale.copy(startScl);
    } else {
      // Translate (and scale center/plane handles fall through here — only
      // the scale-axis case above gets the stretch treatment). SNAPPED:
      // gumball center == snap point. NOT SNAPPED: gumball moves by cursor
      // delta (so the grabbed handle tracks the cursor).
      if (snap.snapped) {
        this.pivotProxy.position.copy(proj);
      } else {
        const delta = new THREE.Vector3().subVectors(proj, this.relocate.cursorStart);
        this.pivotProxy.position.copy(startPos).add(delta);
      }
      this.pivotProxy.quaternion.copy(startQuat);
      this.pivotProxy.scale.copy(startScl);
    }
    this.pivotProxy.updateMatrix();
  }

  private onRelocateExit(e: PointerEvent): void {
    if (!this.relocate.active) return;
    // Capture-phase: eat this click before OrbitControls / TransformControls
    // / selection picker can act on it. The user's intent is "exit relocate"
    // — not "make a new selection".
    e.preventDefault();
    e.stopPropagation();
    if (typeof (e as Event & { stopImmediatePropagation?: () => void }).stopImmediatePropagation === "function") {
      (e as Event & { stopImmediatePropagation: () => void }).stopImmediatePropagation();
    }
    // Commit: pivotProxy.matrix == targetObject.matrix * pivotOffset, so
    // pivotOffset = targetObject.matrix^-1 * pivotProxy.matrix. The next
    // syncPivot tick will reproduce the same pose from this offset.
    if (this.pivotProxy && this.targetObject) {
      this.pivotProxy.updateMatrix();
      this.targetObject.updateMatrix();
      this.pivotOffset.copy(this.targetObject.matrix).invert().multiply(this.pivotProxy.matrix);
    }
    this.relocate.active = false;
    this.relocate.pane = null;
    this.relocate.axis = "";
    this.snapCandidates = [];
    this.snapEdges = [];
    this.snapHysteresis = false;
    this.hideSnapMarker();
    // Re-enable + force-reset every TC. We mutated pivotProxy directly during
    // relocate (bypassing TC's drag protocol), so each TC's cached internal
    // state — `axis`, `dragging`, `_positionStart`, `worldPositionStart`,
    // pointer-capture state — can desync from the new pivot pose. Without a
    // detach/re-attach round-trip three.js TC sometimes refuses subsequent
    // pointerdowns on translate/rotate handles (their `pointerDown` bails on
    // a stale `dragging===true` or null `axis`); only scale, which got
    // re-evaluated whenever the dblclick winner chose it, would remain live.
    // detach() clears object/axis/visibility; attach() re-binds + sets
    // visible=true; updateMatrixWorld(true) recomputes handle positions from
    // the current pivotProxy matrix immediately, before the next click can
    // race against the next render frame.
    if (this.pivotProxy) {
      for (const g of this.gizmos) {
        g.detach();
        g.attach(this.pivotProxy);
        g.enabled = true;
        // Force-reset TC's internal hit-test state. detach() clears `axis`
        // but not `dragging`, and after a relocate cycle the scale TC
        // sometimes lands with `dragging===true` left over from an aborted
        // drag-start that the capture-phase swallowed. While dragging is
        // truthy, pointerHover bails on every move and `axis` never gets
        // set on the next hover, so the next pointerDown sees a null axis
        // and refuses to start a drag — which surfaces as "scale handle
        // doesn't engage post-relocate." Translate/rotate happen to clear
        // their own dragging state through the dragging-changed handler
        // because they fire it once on entry; scale slips through.
        const tc = g as unknown as { dragging: boolean; axis: string | null; _gizmo: { gizmo: Record<string, THREE.Object3D> } };
        tc.dragging = false;
        tc.axis = null;
        g.updateMatrixWorld(true);
      }
    } else {
      for (const g of this.gizmos) g.enabled = true;
    }
    if (this.controls) this.controls.enabled = true;
    this.updateRelocateBadge();
  }

  // Cursor → world-space point appropriate for the active handle:
  //   axis handle (X/Y/Z): closest point on axis line to camera ray
  //   plane handle (XY/XZ/YZ): ray-plane intersection
  //   center handle (XYZ): camera-facing plane through pivot
  //   rotation ring (X/Y/Z): plane perpendicular to ring axis
  private projectCursorForHandle(
    e: MouseEvent,
    pane: Pane,
    mode: "translate" | "rotate" | "scale",
    axis: string,
  ): THREE.Vector3 | null {
    if (!this.pivotProxy) return null;
    const pr = pane.el.getBoundingClientRect();
    const ndcX = ((e.clientX - pr.left) / pr.width) * 2 - 1;
    const ndcY = -((e.clientY - pr.top) / pr.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), pane.camera);

    // Use pivotStart pose if relocate is active (so pointer projection
    // stays anchored to the pose at dblclick); use current pose otherwise.
    const center = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    const src = this.relocate.active ? this.relocate.pivotStart.clone() : this.pivotProxy.matrix.clone();
    src.decompose(center, rot, scl);

    if (mode === "rotate") {
      const axisLocal = this.axisVectorLocal(axis);
      const axisWorld = axisLocal.clone().applyQuaternion(rot).normalize();
      return this.intersectRayPlane(center, axisWorld);
    }
    if (axis.length === 1) {
      const axisLocal = this.axisVectorLocal(axis);
      const axisWorld = axisLocal.clone().applyQuaternion(rot).normalize();
      return this.closestPointOnLineToRay(center, axisWorld);
    }
    if (axis.length === 2) {
      const normalLocal = this.planeNormalLocal(axis);
      const normalWorld = normalLocal.clone().applyQuaternion(rot).normalize();
      return this.intersectRayPlane(center, normalWorld);
    }
    if (axis === "XYZ") {
      const normal = new THREE.Vector3();
      pane.camera.getWorldDirection(normal).negate();
      return this.intersectRayPlane(center, normal.normalize());
    }
    return null;
  }

  private axisVectorLocal(axis: string): THREE.Vector3 {
    if (axis === "X") return new THREE.Vector3(1, 0, 0);
    if (axis === "Y") return new THREE.Vector3(0, 1, 0);
    if (axis === "Z") return new THREE.Vector3(0, 0, 1);
    return new THREE.Vector3(1, 0, 0);
  }

  // Stretch the scale gumball's arm along one axis. Mutates the visible
  // cube + invisible picker geometries to sit at sign*0.5*factor along the
  // axis (vs. sign*0.5 at default factor=1). Pivot center untouched. Used
  // by scale-axis relocate (dblclick scale handle, cursor follows along
  // axis). Geometry is rebuilt each call — small cubes (24 verts) are
  // cheap, the dispose+assign churn is invisible at 60fps.
  private setScaleArmFactor(axis: "X" | "Y" | "Z", factor: number): void {
    const refs = this.scaleArmRefs.get(axis);
    if (!refs) return;
    this.scaleArmFactor[axis] = factor;
    for (const { mesh, sign } of refs.cubes) {
      mesh.geometry.dispose();
      const g = new THREE.BoxGeometry(0.08, 0.08, 0.08);
      // Match three.js TC's baked +0.04 Y offset on scaleHandleGeometry so
      // the cube sits where the user expects relative to the line shaft.
      if (axis === "X") g.translate(sign * 0.5 * factor, 0.04, 0);
      if (axis === "Y") g.translate(0, sign * 0.5 * factor + 0.04, 0);
      if (axis === "Z") g.translate(0, 0.04, sign * 0.5 * factor);
      mesh.geometry = g;
    }
    for (const { mesh, sign } of refs.pickers) {
      mesh.geometry.dispose();
      // Match the 0.4 picker box used in tightenAxisPickers — otherwise a
      // scale-arm-stretch silently shrinks the click target back to 0.18.
      const g = new THREE.BoxGeometry(0.4, 0.4, 0.4);
      if (axis === "X") g.translate(sign * 0.5 * factor, 0, 0);
      if (axis === "Y") g.translate(0, sign * 0.5 * factor, 0);
      if (axis === "Z") g.translate(0, 0, sign * 0.5 * factor);
      mesh.geometry = g;
    }
  }

  private planeNormalLocal(axis: string): THREE.Vector3 {
    if (axis === "XY") return new THREE.Vector3(0, 0, 1);
    if (axis === "XZ") return new THREE.Vector3(0, 1, 0);
    if (axis === "YZ") return new THREE.Vector3(1, 0, 0);
    return new THREE.Vector3(0, 0, 1);
  }

  private intersectRayPlane(center: THREE.Vector3, normal: THREE.Vector3): THREE.Vector3 | null {
    const n = normal.clone().normalize();
    const plane = new THREE.Plane(n, -n.dot(center));
    const out = new THREE.Vector3();
    return this.raycaster.ray.intersectPlane(plane, out) ? out : null;
  }

  private closestPointOnLineToRay(center: THREE.Vector3, dir: THREE.Vector3): THREE.Vector3 | null {
    // Closest point on line {center + s*u} to ray {origin + t*v}:
    //   s = (b·e - c·d) / (a·c - b²)  where a=u·u, b=u·v, c=v·v, d=u·w0, e=v·w0, w0=center-origin.
    const ray = this.raycaster.ray;
    const u = dir.clone().normalize();
    const v = ray.direction.clone().normalize();
    const w0 = new THREE.Vector3().subVectors(center, ray.origin);
    const a = u.dot(u);
    const b = u.dot(v);
    const c = v.dot(v);
    const d = u.dot(w0);
    const eDot = v.dot(w0);
    const denom = a * c - b * b;
    if (Math.abs(denom) < 1e-8) return null;
    const s = (b * eDot - c * d) / denom;
    return center.clone().add(u.multiplyScalar(s));
  }

  // Build the host-geometry snap-candidate list from the current target.
  // Vertices (deduped at 1mm tolerance) + edge endpoints + edge midpoints
  // — pulled from any LineSegments (the wireframe overlay) and any Mesh
  // children of the target. Computed once on relocate entry so on-move
  // costs are O(N) hit-checks not O(N+M) extraction.
  private buildSnapCandidates(): void {
    this.snapCandidates = [];
    this.snapEdges = [];
    if (!this.targetObject) return;
    // Gate by snap-state flags: vertex pulls endpoints + mesh verts (corners),
    // edge pulls edge midpoints AND raw segments for continuous nearest-point
    // -on-edge snap (consumed in applyHostSnap). With both off, both lists
    // stay empty and the relocate cursor flows freely along the axis/plane.
    const snap = getSnap();
    const wantVertex = snap.snapOn && snap.vertexSnapOn;
    const wantEdge = snap.snapOn && snap.edgeSnapOn;
    if (!wantVertex && !wantEdge) return;
    this.targetObject.updateMatrixWorld(true);
    const seen = new Set<string>();
    const tol = 1000; // 1/0.001 = 1mm dedupe
    const key = (v: THREE.Vector3): string =>
      `${Math.round(v.x * tol)},${Math.round(v.y * tol)},${Math.round(v.z * tol)}`;
    const add = (v: THREE.Vector3): void => {
      const k = key(v);
      if (!seen.has(k)) { seen.add(k); this.snapCandidates.push(v); }
    };
    this.targetObject.traverse((o) => {
      if ((o as THREE.LineSegments).isLineSegments) {
        const geom = (o as THREE.LineSegments).geometry as THREE.BufferGeometry;
        const pos = geom?.attributes?.position;
        if (!pos) return;
        const wm = o.matrixWorld;
        for (let i = 0; i + 1 < pos.count; i += 2) {
          const a = new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(wm);
          const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1).applyMatrix4(wm);
          if (wantVertex) { add(a); add(b); }
          if (wantEdge) {
            add(new THREE.Vector3().addVectors(a, b).multiplyScalar(0.5));
            // Stash the raw segment so applyHostSnap can compute nearest-
            // point-on-edge per pointermove (continuous edge snap, not
            // just the discrete midpoint).
            this.snapEdges.push({ a: a.clone(), b: b.clone() });
          }
        }
      } else if ((o as THREE.Mesh).isMesh) {
        if (!wantVertex) return;
        const geom = (o as THREE.Mesh).geometry as THREE.BufferGeometry;
        const pos = geom?.attributes?.position;
        if (!pos) return;
        const wm = o.matrixWorld;
        for (let i = 0; i < pos.count; i++) {
          add(new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(wm));
        }
      }
    });
  }

  // Project a world-space point through the active pane's camera to
  // viewport pixel coordinates. Used for snap-distance comparisons.
  private worldToPixel(p: THREE.Vector3, pane: Pane): { x: number; y: number } {
    const ndc = p.clone().project(pane.camera as THREE.PerspectiveCamera);
    const r = pane.el.getBoundingClientRect();
    return {
      x: r.left + ((ndc.x + 1) / 2) * r.width,
      y: r.top + ((1 - ndc.y) / 2) * r.height,
    };
  }

  // For each snap candidate, project onto the active relocate axis/plane,
  // then find the candidate whose projection is closest in screen space
  // to the cursor's projection (within SNAP_PX). Returns the snapped
  // projection (or the original cursor projection when no candidate is
  // close enough). Renders a small marker at the snap point.
  private applyHostSnap(cursorProj: THREE.Vector3, pane: Pane): { point: THREE.Vector3; snapped: boolean } {
    if (this.relocate.mode === "rotate") { this.hideSnapMarker(); this.snapHysteresis = false; return { point: cursorProj, snapped: false }; }
    if (this.snapCandidates.length === 0 && this.snapEdges.length === 0) {
      this.hideSnapMarker();
      this.snapHysteresis = false;
      return { point: cursorProj, snapped: false };
    }
    // Hysteresis: narrow threshold to ENTER a snap (acquisition is
    // intentional), wider threshold to EXIT once snapped (stickiness
    // through cursor jitter or fine-positioning).
    const SNAP_ENTER_PX = 14;
    const SNAP_EXIT_PX = 32;
    const SNAP_PX = this.snapHysteresis ? SNAP_EXIT_PX : SNAP_ENTER_PX;
    const center = new THREE.Vector3();
    const rot = new THREE.Quaternion();
    const scl = new THREE.Vector3();
    this.relocate.pivotStart.decompose(center, rot, scl);
    const projOf = (c: THREE.Vector3): THREE.Vector3 => {
      if (this.relocate.axis.length === 1) {
        const axisLocal = this.axisVectorLocal(this.relocate.axis);
        const axisWorld = axisLocal.clone().applyQuaternion(rot).normalize();
        const t = c.clone().sub(center).dot(axisWorld);
        return center.clone().add(axisWorld.clone().multiplyScalar(t));
      }
      if (this.relocate.axis.length === 2) {
        const normalLocal = this.planeNormalLocal(this.relocate.axis);
        const normalWorld = normalLocal.clone().applyQuaternion(rot).normalize();
        const d = c.clone().sub(center).dot(normalWorld);
        return c.clone().sub(normalWorld.clone().multiplyScalar(d));
      }
      return c.clone();
    };
    const cursorPx = this.worldToPixel(cursorProj, pane);
    let best: THREE.Vector3 | null = null;
    let bestPx = SNAP_PX;
    // Discrete candidates first (vertices, mesh corners, edge midpoints).
    for (const c of this.snapCandidates) {
      const cp = projOf(c);
      const cpPx = this.worldToPixel(cp, pane);
      const d = Math.hypot(cpPx.x - cursorPx.x, cpPx.y - cursorPx.y);
      if (d < bestPx) { bestPx = d; best = cp; }
    }
    // Continuous edge snap: for each edge segment, the candidate is the
    // closest point on the segment to cursorProj. Lets the gumball glide
    // along an edge instead of only catching at the discrete midpoint.
    for (const seg of this.snapEdges) {
      const ab = new THREE.Vector3().subVectors(seg.b, seg.a);
      const lenSq = ab.lengthSq();
      if (lenSq < 1e-8) continue;
      const t = Math.max(0, Math.min(1, new THREE.Vector3().subVectors(cursorProj, seg.a).dot(ab) / lenSq));
      const onEdge = seg.a.clone().addScaledVector(ab, t);
      const cp = projOf(onEdge);
      const cpPx = this.worldToPixel(cp, pane);
      const d = Math.hypot(cpPx.x - cursorPx.x, cpPx.y - cursorPx.y);
      if (d < bestPx) { bestPx = d; best = cp; }
    }
    if (best) {
      this.snapHysteresis = true;
      this.showSnapMarker(best);
      return { point: best, snapped: true };
    }
    this.snapHysteresis = false;
    this.hideSnapMarker();
    return { point: cursorProj, snapped: false };
  }

  private showSnapMarker(p: THREE.Vector3): void {
    if (!this.snapMarker) {
      const geom = new THREE.SphereGeometry(0.06, 12, 8);
      const mat = new THREE.MeshBasicMaterial({ color: 0x00ffaa, depthTest: false });
      this.snapMarker = new THREE.Mesh(geom, mat);
      this.snapMarker.renderOrder = 999;
      this.snapMarker.userData.noSnap = true;
      this.snapMarker.userData.noRenderMode = true;
      this.scene.add(this.snapMarker);
    }
    this.snapMarker.position.copy(p);
    this.snapMarker.visible = true;
  }
  private hideSnapMarker(): void {
    if (this.snapMarker) this.snapMarker.visible = false;
  }

  // Gumball priority resolver — three.js TC pickers are long thin cylinders
  // along each axis, so translate/rotate/scale handles overlap heavily near
  // the gizmo origin. Closest-camera-distance comparison can't disambiguate
  // because all three pickers sit on the same axis line at similar depths.
  //
  // Strategy: PRIORITY-based when multiple gumballs are hit (smaller, more
  // specific handles win): scale > rotate > translate. Distance-based only
  // when one gumball hits — i.e., the user clicked a region only covered
  // by one mode's handles. This matches Rhino's "specific over general"
  // gumball UX where the small scale cube can be clicked even when sitting
  // along the translate axis.
  //
  // Visibility filter: each TC has BOTH visible gizmo + invisible picker
  // subgroups for all 3 modes; only the active mode's two subgroups have
  // visible=true. Raycaster.intersectObjects doesn't skip invisible objects
  // so without this filter, translate-TC's hidden scale picker would
  // compete with scale-TC's visible scale picker.
  private resolveGumballPriority(e: PointerEvent, pane: Pane): void {
    if (this.relocate.active) return;
    if (e.button !== 0) return;
    const pr = pane.el.getBoundingClientRect();
    const ndcX = ((e.clientX - pr.left) / pr.width) * 2 - 1;
    const ndcY = -((e.clientY - pr.top) / pr.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), pane.camera);
    const HANDLE_NAMES = new Set(["X", "Y", "Z", "XY", "XZ", "YZ", "XYZ", "E", "XYZE"]);
    type Hit = { idx: number; mode: "translate" | "rotate" | "scale"; axis: string; dist: number };
    const allHits: Hit[] = [];
    for (let i = 0; i < this.gizmos.length; i++) {
      const g = this.gizmos[i];
      const mode = (g as unknown as { mode: "translate" | "rotate" | "scale" }).mode;
      const targets: THREE.Object3D[] = [];
      g.traverse((o) => {
        if (!HANDLE_NAMES.has(o.name)) return;
        if (!o.parent || !o.parent.visible) return;
        targets.push(o);
      });
      if (targets.length === 0) continue;
      const hits = this.raycaster.intersectObjects(targets, true);
      if (hits[0]) {
        // Walk up to the named-handle root in case the leaf hit was a
        // child mesh (line/cone/etc) inside a HANDLE_NAMES group.
        let node: THREE.Object3D | null = hits[0].object;
        while (node && !HANDLE_NAMES.has(node.name)) node = node.parent;
        if (node?.name) {
          allHits.push({ idx: i, mode, axis: node.name, dist: hits[0].distance });
        }
      }
    }
    if (allHits.length === 0) return; // click missed every handle
    let winner: Hit;
    if (allHits.length === 1) {
      winner = allHits[0];
    } else {
      // Primary: respect hover state. The TC whose handle is currently
      // highlighted (axis !== null from onPointerHover) is the one the
      // user aimed at. When exactly one TC has axis set, it wins
      // outright regardless of ray distance.
      //
      // The ray-distance fallback (below) can't solve the scale-vs-translate
      // conflict because all handle nodes share the same pivot position
      // (gizmo center), so no geometric signal differentiates them.
      // The hover axis IS the ground truth for user intent.
      // Filter to TCs that both (a) have a raycast hit and (b) had their
      // hover axis set by onPointerHover, matching the actual hit axis.
      // Matching axis prevents a stale hover on translate-X from promoting
      // translate when the click is on a scale-Y handle.
      const hoveredHits = allHits.filter(h => {
        const gAxis = this.gizmos[h.idx].axis;
        return gAxis !== null && gAxis === h.axis;
      });
      if (hoveredHits.length === 1) {
        // Unambiguous hover — this TC wins outright.
        winner = hoveredHits[0];
      } else if (hoveredHits.length > 1) {
        // Multiple TCs are highlighted at this position. The translate TC's
        // picker is a long shaft that extends past the scale cube, so it
        // fires even when the cursor is on the scale cube's visual face.
        // Priority: scale > rotate > translate.
        const MULTI_HOVER: Record<string, number> = { scale: 0, rotate: 1, translate: 2 };
        hoveredHits.sort((a, b) => MULTI_HOVER[a.mode] - MULTI_HOVER[b.mode]);
        winner = hoveredHits[0];
      } else {
        // No hover at all (axis === null on every TC) — fall back to ray distance.
        allHits.sort((a, b) => a.dist - b.dist);
        const closest = allHits[0];
        const tol = closest.dist * 0.01 + 0.01;
        const tied = allHits.filter(h => h.dist - closest.dist <= tol);
        if (tied.length === 1) {
          winner = closest;
        } else {
          const isCenter = (axis: string) => axis === "XYZ" || axis === "E" || axis === "XYZE";
          const allCenter = tied.every(h => isCenter(h.axis));
          const ORDER_CENTER: Record<string, number> = { scale: 0, rotate: 1, translate: 2 };
          const ORDER_AXIS: Record<string, number> = { translate: 0, rotate: 1, scale: 2 };
          const order = allCenter ? ORDER_CENTER : ORDER_AXIS;
          tied.sort((a, b) => order[a.mode] - order[b.mode]);
          winner = tied[0];
        }
      }
    }
    console.log("[gumball] won:", winner.mode, winner.axis, "of", allHits.length, "hits, dist=", winner.dist.toFixed(3));
    // Only disable losers when there's a true contention. Single-hit
    // cases never need the temporary disable, and avoiding the wasEnabled
    // capture/restore round-trip eliminates a class of state-leak bugs
    // where the restore handler outlives the click and mis-restores
    // a gizmo that another path (relocate exit, dragging-changed) just
    // re-enabled.
    if (allHits.length > 1) {
      const wasEnabled: boolean[] = [];
      for (let i = 0; i < this.gizmos.length; i++) {
        wasEnabled[i] = this.gizmos[i].enabled;
        if (i !== winner.idx) this.gizmos[i].enabled = false;
      }
      const restore = (): void => {
        for (let i = 0; i < this.gizmos.length; i++) {
          this.gizmos[i].enabled = wasEnabled[i];
        }
        pane.body.removeEventListener("pointerup", restore);
        pane.body.removeEventListener("pointercancel", restore);
      };
      pane.body.addEventListener("pointerup", restore);
      pane.body.addEventListener("pointercancel", restore);
    }
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
    // syncPivot recomputes pivotProxy.matrix from targetObject.matrix *
    // pivotOffset. Skip during relocate so pointer-driven pivot updates
    // aren't immediately overwritten next frame.
    if (!this.isAnyGumballDragging() && !this.relocate.active) this.syncPivot();
    const canvasRect = this.canvas.getBoundingClientRect();
    const canvasH = this.canvas.clientHeight;

    this.renderer.clear();

    for (const pane of this.panes) {
      const rect = pane.el.getBoundingClientRect();
      const x = Math.floor(rect.left - canvasRect.left);
      // Y-flip: WebGL origin is bottom-left, DOM origin is top-left.
      const gl_y = Math.floor(canvasH - (rect.top - canvasRect.top) - rect.height);
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w <= 0 || h <= 0) continue;
      pane.lastRenderedW = w;
      pane.lastRenderedH = h;

      this.renderer.setScissor(x, gl_y, w, h);
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(x, gl_y, w, h);
      this.renderer.clearDepth();
      pane.controls.update();
      // #714: per-pane grid orientation. The persp pane uses activeView (set by
      // setView); the fixed-direction quad panes use their own view field.
      const gridView = pane.view === "persp" ? this.activeView : pane.view;
      if (gridView === "front" || gridView === "back") {
        this.grid.rotation.set(0, 0, 0);
      } else if (gridView === "right" || gridView === "left") {
        this.grid.rotation.set(0, 0, Math.PI / 2);
      } else {
        this.grid.rotation.set(Math.PI / 2, 0, 0);
      }
      this.renderer.render(this.scene, pane.camera);
    }
    this.renderer.setScissorTest(false);
  };

  clearScene(): void {
    if (this.currentMesh) {
      this.scene.remove(this.currentMesh);
      this.currentMesh.geometry.dispose();
      (this.currentMesh.material as THREE.Material).dispose();
      this.currentMesh = null;
    }
    if (this.currentEdges) {
      this.scene.remove(this.currentEdges);
      this.currentEdges.geometry.dispose();
      (this.currentEdges.material as THREE.Material).dispose();
      this.currentEdges = null;
    }
    if (this.currentObject) {
      this.scene.remove(this.currentObject);
      this.currentObject.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (mesh.isMesh) {
          mesh.geometry?.dispose();
          const mat = mesh.material;
          if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
          else if (mat) (mat as THREE.Material).dispose();
        }
      });
      this.currentObject = null;
    }
    // Remove any remaining non-infrastructure scene children (dispatch-created
    // objects, IFC sample-picker loads not tracked by currentObject, etc.).
    const infraSet = new Set<THREE.Object3D>([
      this.grid, this.axes, ...this.axisLabels,
      ...(this.pivotProxy ? [this.pivotProxy] : []),
      ...(this.snapMarker ? [this.snapMarker] : []),
      ...this.gizmos,
      this._cplaneGizmo.group,
    ]);
    const toRemove = this.scene.children.filter(
      (c) => !infraSet.has(c) && !(c instanceof THREE.Light),
    );
    for (const obj of toRemove) {
      this.scene.remove(obj);
      obj.traverse((child) => {
        const m = child as THREE.Mesh;
        if (m.geometry) m.geometry.dispose();
        const mat = m.material;
        if (mat) {
          if (Array.isArray(mat)) (mat as THREE.Material[]).forEach((mm) => mm.dispose());
          else (mat as THREE.Material).dispose();
        }
      });
    }
    // Reset gumball / selection state.
    this.targetObject = null;
    this.pivotOffset.identity();
    this.relocate.active = false;
    for (const g of this.gizmos) g.detach();
    this.updateRelocateBadge();
  }

  setMesh(mesh: MeshIn, bounds: Bounds): void {
    this.clearScene();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

    // Recenter the geometry so the mesh's local origin sits at the
    // geometric centroid (= bounding-box center). The Gumball renders at
    // mesh.position; without this, vertices live in world coordinates and
    // mesh.position stays at (0,0,0) — so the gumball pin appears at the
    // origin rather than on the object. We translate vertices by -centroid
    // and offset mesh.position by +centroid so the visual location is
    // identical, but selection/transform now pivots around the centroid.
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    geometry.translate(-cx, -cy, -cz);

    const material = new THREE.MeshStandardMaterial({
      color: 0x7ad3a3,
      roughness: 0.55,
      metalness: 0.05,
      flatShading: false,
    });
    const m = new THREE.Mesh(geometry, material);
    m.position.set(cx, cy, cz);
    this.scene.add(m);
    this.currentMesh = m;

    const edges = new THREE.EdgesGeometry(geometry, 25);
    const edgeMat = new THREE.LineBasicMaterial({
      color: 0x0e0e10,
      linewidth: 1,
      opacity: 0.6,
      transparent: true,
    });
    const edgeLines = new THREE.LineSegments(edges, edgeMat);
    // Parent the edges UNDER the mesh so any transform (gumball drag, agent
    // translate/rotate/scale, future grouping) propagates via the standard
    // Three.js matrix-world chain. Adding them as a sibling of the mesh on
    // scene leaves them at the origin while the mesh moves — visible as
    // "ghost edges" of the original position.
    m.add(edgeLines);
    this.currentEdges = edgeLines;

    this.fitCamera(bounds);
  }

  setObject(object: THREE.Object3D, bounds: Bounds): void {
    this.clearScene();
    // Center the loaded object at world origin: XY centroid at (0,0), building
    // floor (bounds.min.z) at Z=0. IFC project base points land at a building
    // corner after COORDINATE_TO_ORIGIN — this re-centers on the bounding-box
    // footprint centroid and grounds the floor plane.
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = bounds.min[2]; // floor at Z=0
    const wrapper = new THREE.Group();
    wrapper.position.set(0, 0, 0);
    object.position.sub(new THREE.Vector3(cx, cy, cz));
    wrapper.add(object);
    this.scene.add(wrapper);
    this.currentObject = wrapper;
    // Recompute bounds relative to the centered position for fitCamera.
    const hw = (bounds.max[0] - bounds.min[0]) / 2;
    const hh = (bounds.max[1] - bounds.min[1]) / 2;
    const hd = bounds.max[2] - bounds.min[2];
    this.fitCamera({ min: [-hw, -hh, 0], max: [hw, hh, hd] });
  }

  getActiveObject(): THREE.Object3D | null {
    if (this.currentMesh) return this.currentMesh;
    if (this.currentObject) return this.currentObject;
    return null;
  }

  getScene(): THREE.Scene {
    return this.scene;
  }

  getCanvas(): HTMLCanvasElement {
    return this.canvas;
  }

  // Render a frame synchronously then read the framebuffer into a JPEG data URL.
  // Because we render and read in the same JS task, no preserveDrawingBuffer is needed.
  captureFrame(maxDim = 512): string | null {
    const canvasRect = this.canvas.getBoundingClientRect();
    const canvasH = this.canvas.clientHeight;
    this.renderer.clear();
    for (const pane of this.panes) {
      const rect = pane.el.getBoundingClientRect();
      const x = Math.floor(rect.left - canvasRect.left);
      const gl_y = Math.floor(canvasH - (rect.top - canvasRect.top) - rect.height);
      const w = Math.floor(rect.width);
      const h = Math.floor(rect.height);
      if (w <= 0 || h <= 0) continue;
      this.renderer.setScissor(x, gl_y, w, h);
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(x, gl_y, w, h);
      this.renderer.clearDepth();
      pane.controls.update();
      this.renderer.render(this.scene, pane.camera);
    }
    this.renderer.setScissorTest(false);
    const cw = this.canvas.width;
    const ch = this.canvas.height;
    if (cw === 0 || ch === 0) return null;
    const scale = Math.min(1, maxDim / Math.max(cw, ch));
    const sw = Math.max(1, Math.round(cw * scale));
    const sh = Math.max(1, Math.round(ch * scale));
    const off = document.createElement("canvas");
    off.width = sw;
    off.height = sh;
    const ctx = off.getContext("2d");
    if (!ctx) return null;
    try {
      ctx.drawImage(this.canvas, 0, 0, sw, sh);
    } catch {
      return null;
    }
    return off.toDataURL("image/jpeg", 0.82);
  }

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  // Returns the camera currently active for the main viewport pane.
  // In ortho views this is the OrthographicCamera; in persp it's this.camera.
  getActiveCamera(): THREE.Camera {
    const perspPane = this.panes.find(p => p.view === "persp");
    return perspPane?.camera ?? this.camera;
  }

  /** Raycast for hover highlighting — uses pane-rect NDC (same as selection picker).
   *  Returns the hit Object3D (possibly a CSG display mesh) or null. */
  raycastForHover(clientX: number, clientY: number): THREE.Object3D | null {
    const hitPane = this.panes.find(p => {
      const r = p.el.getBoundingClientRect();
      return clientX >= r.left && clientX <= r.right && clientY >= r.top && clientY <= r.bottom;
    });
    if (!hitPane) return null;
    const pr = hitPane.el.getBoundingClientRect();
    const ndcX = ((clientX - pr.left) / pr.width) * 2 - 1;
    const ndcY = -((clientY - pr.top) / pr.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), hitPane.camera);
    const gizmoSet = new Set<THREE.Object3D>(this.gizmos);
    const pickables = this.scene.children.filter(
      c => c !== this.grid && c !== this.axes && !(c instanceof THREE.Sprite) &&
           !(c instanceof THREE.DirectionalLight) && !(c instanceof THREE.AmbientLight) &&
           !gizmoSet.has(c) && c !== this.pivotProxy && c !== this._cplaneGizmo.group,
    );
    const hits = this.raycaster.intersectObjects(pickables, true);
    for (const h of hits) {
      const o = h.object;
      const isDisplay = !!o.userData.isJoinDisplay;
      if (o.userData.noSnap && !isDisplay) continue;
      // #950: skip objects whose effective visibility is false (level/layer hidden).
      if (!isDisplay) {
        let anc: THREE.Object3D | null = o;
        let effVisible = true;
        while (anc) { if (!anc.visible) { effVisible = false; break; } anc = anc.parent; }
        if (!effVisible) continue;
        // #964: skip objects on locked or hidden drawing layers.
        const dlId = o.userData.drawingLayerId as string | undefined;
        if (dlId) {
          const dl = drawingLayerStore.get(dlId);
          if (dl && (!dl.visible || dl.locked)) continue;
        }
      }
      // #953: roof children → resolve to parent Group so entire roof highlights.
      if (o.parent instanceof THREE.Group && o.parent.userData.creator === "roof") return o.parent;
      return o;
    }
    return null;
  }

  // noHistory: true opts out of the automatic undo push. Use for callers that
  // manage their own history entry (SdArray → pushBatchAction).
  addMesh(mesh: THREE.Object3D, _kind?: string, opts?: { noHistory?: boolean }): void {
    const ctx = getCurrentDispatchCtx();
    if (ctx && mesh.userData.dispatchArgs === undefined) {
      mesh.userData.dispatchVerb = ctx.canonical;
      mesh.userData.dispatchArgs = { ...ctx.args };
    }
    if (!mesh.userData.layerId && mesh.userData.creator) {
      mesh.userData.layerId = getLayerForCreator(mesh.userData.creator as string);
    }
    this.scene.add(mesh);
    this._applyActiveClipPlanesToSubtree(mesh);
    if (!opts?.noHistory) {
      pushAction(mesh, (mesh.userData.creator as string | undefined) ?? "object");
    }
    // Rebuild fill when a new solid is added into an active clip zone.
    if (this._sectionPlanes.length > 0 || this._clipPlanes.length > 0) this._rebuildFill();
  }

  /** Walk scene children; callback may mutate visible/material but not add/remove. */
  forEachSceneChild(fn: (obj: THREE.Object3D) => void): void {
    for (const child of this.scene.children) fn(child);
  }

  removeObject(obj: THREE.Object3D): boolean {
    if (!this.scene.children.includes(obj)) return false;
    const clipLabel = obj.userData.clipLabel as string | undefined;
    if (clipLabel) this.removeClippingPlane(clipLabel);
    obj.traverse((child) => {
      const labels = (child.userData as { dimLabelEls?: HTMLElement[] }).dimLabelEls;
      if (labels) labels.forEach((el) => el.remove());
    });
    this.scene.remove(obj);
    if (this.currentMesh === obj) this.currentMesh = null;
    if (this.currentEdges === obj) this.currentEdges = null;
    if (this.currentObject === obj) this.currentObject = null;
    return true;
  }

  getActiveMeshData(): { vertices: Float32Array; indices: Uint32Array } | null {
    if (this.currentMesh) {
      const g = this.currentMesh.geometry;
      const pos = g.attributes.position?.array as Float32Array | undefined;
      const idx = g.index?.array;
      if (!pos || !idx) return null;
      return { vertices: new Float32Array(pos), indices: new Uint32Array(idx) };
    }
    if (this.currentObject) {
      const verts: number[] = [];
      const idx: number[] = [];
      const tmp = new THREE.Vector3();
      const matWorld = new THREE.Matrix4();
      this.currentObject.updateMatrixWorld(true);
      this.currentObject.traverse((child) => {
        const mesh = child as THREE.Mesh;
        if (!mesh.isMesh) return;
        const g = mesh.geometry as THREE.BufferGeometry;
        const pos = g.attributes.position?.array as Float32Array | undefined;
        if (!pos) return;
        matWorld.copy(mesh.matrixWorld);
        const baseIndex = verts.length / 3;
        for (let i = 0; i < pos.length; i += 3) {
          tmp.set(pos[i], pos[i + 1], pos[i + 2]);
          tmp.applyMatrix4(matWorld);
          verts.push(tmp.x, tmp.y, tmp.z);
        }
        const indexAttr = g.index;
        if (indexAttr) {
          const a = indexAttr.array;
          for (let i = 0; i < a.length; i++) idx.push(a[i] + baseIndex);
        } else {
          const triCount = (pos.length / 3) | 0;
          for (let i = 0; i < triCount; i++) idx.push(baseIndex + i);
        }
      });
      if (verts.length === 0) return null;
      return {
        vertices: new Float32Array(verts),
        indices: new Uint32Array(idx),
      };
    }
    return null;
  }

  private fitCamera(bounds: Bounds): void {
    this.currentBounds = bounds;
    const cx = (bounds.min[0] + bounds.max[0]) / 2;
    const cy = (bounds.min[1] + bounds.max[1]) / 2;
    const cz = (bounds.min[2] + bounds.max[2]) / 2;
    const dx = bounds.max[0] - bounds.min[0];
    const dy = bounds.max[1] - bounds.min[1];
    const dz = bounds.max[2] - bounds.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));

    // Persp camera — architectural direction, 1.7× for grid visibility.
    const dist = diag * 1.7;
    const dir = new THREE.Vector3(1, 1, 1.5).normalize();
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.camera.updateProjectionMatrix();
    const perspPane = this.panes.find(p => p.view === "persp");
    if (perspPane) {
      perspPane.controls.target.set(cx, cy, cz);
      perspPane.controls.update();
    }

    // Ortho panes — position along view axis, scale frustum to fit scene.
    const half = diag * 0.55;
    for (const pane of this.panes) {
      if (!(pane.camera instanceof THREE.OrthographicCamera)) continue;
      switch (pane.view) {
        case "top":   pane.camera.position.set(cx, cy, cz + diag * 2); break;
        case "front": pane.camera.position.set(cx, cy - diag * 2, cz); break;
        case "right": pane.camera.position.set(cx + diag * 2, cy, cz); break;
      }
      pane.camera.lookAt(cx, cy, cz);
      const pr = pane.el.getBoundingClientRect();
      const aspect = pr.width > 0 && pr.height > 0 ? pr.width / pr.height : 1;
      pane.camera.left = -half * aspect;
      pane.camera.right = half * aspect;
      pane.camera.top = half;
      pane.camera.bottom = -half;
      pane.camera.updateProjectionMatrix();
      pane.controls.target.set(cx, cy, cz);
      pane.controls.update();
    }

    // Re-scale grid so it brackets the object. Divisions are locked to
    // the snap step (rebuildGrid handles the same formula). Re-running on
    // every fitCamera ensures the grid expands to fit a newly loaded
    // larger scene; rebuildGrid keeps it in sync when the user changes
    // STEP via the snap dock without a re-fit.
    const gridSize = Math.max(20, Math.ceil(Math.max(dx, dy) * 2));
    if ((this.grid as any).__lastSize !== gridSize) {
      (this.grid as any).__lastSize = gridSize;
      this.rebuildGrid();
    }

    // Re-scale axis triad + labels.
    const triadLen = Math.max(2, Math.min(dx, dy, dz) * 0.5);
    this.scene.remove(this.axes);
    this.axes.dispose();
    this.axes = new THREE.AxesHelper(triadLen);
    this.axes.userData.noSnap = true;
    this.scene.add(this.axes);
    this.createAxisLabels(triadLen);
  }

  private createAxisLabels(length = 2): void {
    for (const s of this.axisLabels) {
      this.scene.remove(s);
      s.material.map?.dispose();
      s.material.dispose();
    }
    this.axisLabels = [];
    const make = (text: string, color: string, pos: [number, number, number]): THREE.Sprite => {
      const c = document.createElement("canvas");
      c.width = 96; c.height = 96;
      const ctx = c.getContext("2d")!;
      ctx.clearRect(0, 0, 96, 96);
      ctx.fillStyle = color;
      ctx.font = "700 64px 'Inter', system-ui, sans-serif";
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillText(text, 48, 50);
      const tex = new THREE.CanvasTexture(c);
      tex.colorSpace = THREE.SRGBColorSpace;
      const mat = new THREE.SpriteMaterial({ map: tex, depthTest: false, depthWrite: false, transparent: true });
      const sprite = new THREE.Sprite(mat);
      sprite.position.set(pos[0], pos[1], pos[2]);
      const s = Math.max(0.4, length * 0.18);
      sprite.scale.set(s, s, 1);
      sprite.renderOrder = 999;
      return sprite;
    };
    const tip = length * 1.12;
    this.axisLabels = [
      make("X", "#ff5c5c", [tip, 0, 0]),
      make("Y", "#7ad36a", [0, tip, 0]),
      make("Z", "#5b8def", [0, 0, tip]),
    ];
    for (const s of this.axisLabels) this.scene.add(s);
  }

  frameObjectOnly(obj: THREE.Object3D): void {
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    if (box.isEmpty() || !isFinite(box.min.x) || !isFinite(box.max.x)) return;
    const cx = (box.min.x + box.max.x) / 2;
    const cy = (box.min.y + box.max.y) / 2;
    const cz = (box.min.z + box.max.z) / 2;
    const dx = box.max.x - box.min.x;
    const dy = box.max.y - box.min.y;
    const dz = box.max.z - box.min.z;
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const dist = diag * 1.7;
    const dir = new THREE.Vector3(1, 1, 1.5).normalize();
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.camera.updateProjectionMatrix();
    const perspPane = this.panes.find(p => p.view === "persp");
    if (perspPane) {
      perspPane.controls.target.set(cx, cy, cz);
      perspPane.controls.update();
    }
  }

  // ── Isolation: hide all objects except target + its ancestors/descendants ──────

  isolate(uuid: string): boolean {
    this.isolateOff();
    const target = this.scene.getObjectByProperty("uuid", uuid);
    if (!target) return false;
    const ancestors = new Set<string>();
    let cur: THREE.Object3D | null = target.parent;
    while (cur && cur !== this.scene) { ancestors.add(cur.uuid); cur = cur.parent; }
    const descendants = new Set<string>();
    target.traverse((c) => { descendants.add(c.uuid); });
    this.scene.traverse((obj) => {
      if (obj === this.scene) return;
      const keep = obj.uuid === uuid || ancestors.has(obj.uuid) || descendants.has(obj.uuid);
      this._preIsolationVisible.set(obj.uuid, obj.visible);
      if (!keep) obj.visible = false;
    });
    this._isolatedUuid = uuid;
    return true;
  }

  isolateOff(): void {
    if (this._isolatedUuid === null) return;
    this.scene.traverse((obj) => {
      const prev = this._preIsolationVisible.get(obj.uuid);
      if (prev !== undefined) obj.visible = prev;
    });
    this._preIsolationVisible.clear();
    this._isolatedUuid = null;
  }

  getIsolatedUuid(): string | null { return this._isolatedUuid; }

  // ── Section box (6 axis-aligned clipping planes from a min/max AABB) ──────────

  setSectionBox(min: [number, number, number], max: [number, number, number], enabled = true): void {
    this._sectionPlanes = [];
    if (enabled) {
      this._sectionPlanes = [
        new THREE.Plane(new THREE.Vector3( 1,  0,  0), -min[0]),
        new THREE.Plane(new THREE.Vector3(-1,  0,  0),  max[0]),
        new THREE.Plane(new THREE.Vector3( 0,  1,  0), -min[1]),
        new THREE.Plane(new THREE.Vector3( 0, -1,  0),  max[1]),
        new THREE.Plane(new THREE.Vector3( 0,  0,  1), -min[2]),
        new THREE.Plane(new THREE.Vector3( 0,  0, -1),  max[2]),
      ];
    }
    this._applyClippingPlanes();
  }

  clearSectionBox(): void {
    this._sectionPlanes = [];
    this._applyClippingPlanes();
  }

  getSectionBox(): { min: [number, number, number]; max: [number, number, number] } | null {
    if (this._sectionPlanes.length < 6) return null;
    return {
      min: [-this._sectionPlanes[0].constant, -this._sectionPlanes[2].constant, -this._sectionPlanes[4].constant],
      max: [ this._sectionPlanes[1].constant,  this._sectionPlanes[3].constant,  this._sectionPlanes[5].constant],
    };
  }

  // Plane layout (setSectionBox order):
  //   [0] normal(+1,0,0) constant=-min[0]  → -X face
  //   [1] normal(-1,0,0) constant=+max[0]  → +X face
  //   [2] normal(0,+1,0) constant=-min[1]  → -Y face
  //   [3] normal(0,-1,0) constant=+max[1]  → +Y face
  //   [4] normal(0,0,+1) constant=-min[2]  → -Z face
  //   [5] normal(0,0,-1) constant=+max[2]  → +Z face
  // For all faces: plane.constant += delta moves the face outward (positive = expand).
  private static readonly _FACE_IDX: Record<string, number> = {
    '+x': 1, '-x': 0, '+y': 3, '-y': 2, '+z': 5, '-z': 4,
  };

  pushSectionFace(face: '+x' | '-x' | '+y' | '-y' | '+z' | '-z', delta: number): void {
    if (this._sectionPlanes.length < 6) return;
    const idx = Viewer._FACE_IDX[face];
    this._sectionPlanes[idx].constant += delta;
    this._applyClippingPlanes();
  }

  // Returns the signed position of the face along its axis (scene units).
  // '+x' → max[0], '-x' → min[0], etc.
  getSectionFacePosition(face: '+x' | '-x' | '+y' | '-y' | '+z' | '-z'): number | null {
    if (this._sectionPlanes.length < 6) return null;
    const idx = Viewer._FACE_IDX[face];
    const plane = this._sectionPlanes[idx];
    // +faces store constant=+coord; -faces store constant=-coord
    return face.startsWith('+') ? plane.constant : -plane.constant;
  }

  // ── Arbitrary clipping planes ─────────────────────────────────────────────────

  addClippingPlane(origin: [number, number, number], normal: [number, number, number], label?: string): void {
    const n = new THREE.Vector3(...normal).normalize();
    const plane = new THREE.Plane(n, -n.dot(new THREE.Vector3(...origin)));
    this._clipPlanes.push(plane);
    if (label) this._clipLabels.set(label, plane);
    this._applyClippingPlanes();
  }

  clearClippingPlanes(): void {
    this._clipPlanes = [];
    this._clipLabels.clear();
    this._applyClippingPlanes();
  }

  removeClippingPlane(label: string): boolean {
    const plane = this._clipLabels.get(label);
    if (!plane) return false;
    this._clipPlanes = this._clipPlanes.filter((p) => p !== plane);
    this._clipLabels.delete(label);
    this._applyClippingPlanes();
    return true;
  }

  getClippingPlaneCount(): number {
    return this._clipPlanes.length;
  }

  getClippingPlanes(): Array<{ label: string; origin: [number, number, number]; normal: [number, number, number] }> {
    const labelByPlane = new Map<THREE.Plane, string>();
    this._clipLabels.forEach((plane, label) => labelByPlane.set(plane, label));
    return this._clipPlanes.map((plane, idx) => {
      const n = plane.normal;
      // Closest point on the plane to the world origin: p = -constant * normal
      const o = n.clone().multiplyScalar(-plane.constant);
      return {
        label: labelByPlane.get(plane) ?? `plane-${idx}`,
        origin: [o.x, o.y, o.z] as [number, number, number],
        normal: [n.x, n.y, n.z] as [number, number, number],
      };
    });
  }

  // Rebuild stencil fill geometry for the current clip + section planes.
  private _rebuildFill(): void {
    const all = [...this._sectionPlanes, ...this._clipPlanes];
    if (all.length === 0) { this._clipFill.dispose(this.scene); return; }
    this._clipFill.update(all, this.scene, this._fillMode);
  }

  // Switch to per-material local clipping so objects tagged excludeFromClip
  // (clip-plane visualization, gumball handles) are exempt from the clip set.
  private _applyClippingPlanes(): void {
    const all = [...this._sectionPlanes, ...this._clipPlanes];
    this.renderer.clippingPlanes = [];
    this.renderer.localClippingEnabled = all.length > 0;

    // Build gizmo-owned object set so handles are never clipped.
    const gizmoObjs = new Set<THREE.Object3D>();
    for (const g of this.gizmos) g.traverse((o) => gizmoObjs.add(o));
    if (this.pivotProxy) gizmoObjs.add(this.pivotProxy);

    this.scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const exclude = obj.userData.excludeFromClip === true || gizmoObjs.has(obj);
      const planes = exclude ? [] : all;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        if ((m as THREE.Material).clippingPlanes !== planes) {
          (m as THREE.Material).clippingPlanes = planes;
          (m as THREE.Material).needsUpdate = true;
        }
      }
    });
    this._rebuildFill();
  }

  // Apply active clip planes to a newly added object's subtree without
  // traversing the full scene.
  private _applyActiveClipPlanesToSubtree(root: THREE.Object3D): void {
    const all = [...this._sectionPlanes, ...this._clipPlanes];
    if (all.length === 0) return;
    root.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      if (obj.userData.excludeFromClip) return;
      const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
      for (const m of mats) {
        (m as THREE.Material).clippingPlanes = all;
        (m as THREE.Material).needsUpdate = true;
      }
    });
  }

  // Recompute the stored THREE.Plane from the clip-plane visualization mesh's
  // current world matrix. Call from objectChange when the gumball moves/rotates
  // a SdClippingPlane mesh so the clip math follows the visual in real time.
  updateClippingPlane(label: string, mesh: THREE.Mesh): void {
    const plane = this._clipLabels.get(label);
    if (!plane) return;
    mesh.updateMatrixWorld(true);
    // PlaneGeometry local normal = +Z. Transform through normal matrix to world.
    const m3 = new THREE.Matrix3().getNormalMatrix(mesh.matrixWorld);
    const normal = new THREE.Vector3(0, 0, 1).applyMatrix3(m3).normalize();
    const origin = new THREE.Vector3().setFromMatrixPosition(mesh.matrixWorld);
    plane.normal.copy(normal);
    plane.constant = -normal.dot(origin);
    // THREE.js reads plane.normal/.constant directly each frame — no reassign needed.
  }

  frameAllVisible(): void {
    this.scene.updateMatrixWorld(true);
    const box = new THREE.Box3();
    this.scene.traverse((obj) => {
      if (!(obj instanceof THREE.Mesh)) return;
      const ud = (obj as any).userData as Record<string, unknown>;
      if (ud?.kind !== "brep" && ud?.kind !== "compound") return;
      box.expandByObject(obj);
    });
    if (box.isEmpty() && this.currentBounds) {
      box.set(
        new THREE.Vector3(...this.currentBounds.min),
        new THREE.Vector3(...this.currentBounds.max),
      );
    }
    if (box.isEmpty() || !isFinite(box.min.x) || !isFinite(box.max.x)) return;
    const center = new THREE.Vector3();
    box.getCenter(center);
    const size = new THREE.Vector3();
    box.getSize(size);
    const maxDim = Math.max(size.x, size.y, size.z, 0.5);
    const dist = (maxDim / 2) / Math.tan((this.camera.fov / 2) * (Math.PI / 180)) * 1.4;
    const dir = new THREE.Vector3(1, 1, 1.5).normalize();
    // Restore perspective camera if an ortho view swap is active (#331).
    const perspPane = this.panes.find(p => p.view === "persp");
    // #709: flush accumulated OrbitControls sphericalDelta so stale damping
    // momentum doesn't drift the camera off the desired position.
    if (perspPane) {
      const prev = perspPane.controls.enableDamping;
      perspPane.controls.enableDamping = false;
      perspPane.controls.update();
      perspPane.controls.enableDamping = prev;
    }
    if (perspPane && perspPane.camera !== this.camera) {
      perspPane.camera = this.camera;
      perspPane.controls.object = this.camera;
      perspPane.controls.enableRotate = true;
      perspPane.controls.screenSpacePanning = false;
      perspPane.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      perspPane.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      perspPane.controls.zoomSpeed = 1;
      // #715: sync gizmo camera back to persp.
      for (const g of this.gizmos) g.camera = this.camera;
    }
    this.camera.position.set(center.x + dir.x * dist, center.y + dir.y * dist, center.z + dir.z * dist);
    this.camera.updateProjectionMatrix();
    if (perspPane) {
      perspPane.controls.target.set(center.x, center.y, center.z);
      perspPane.controls.update();
    }
    this.activeView = "persp";
  }

  setView(name: "top" | "bottom" | "front" | "back" | "left" | "right" | "iso" | "extents" | "persp"): void {
    this.activeView = name;
    window.dispatchEvent(new CustomEvent("viewer:cplane-derived", {
      detail: { cplane: resolveCPlane("SdBox", {}, this), view: name },
    }));
    const perspPane = this.panes.find(p => p.view === "persp");
    // #709: flush accumulated OrbitControls sphericalDelta before applying new view,
    // so stale damping momentum doesn't push camera off the exact desired position.
    if (perspPane) {
      const prev = perspPane.controls.enableDamping;
      perspPane.controls.enableDamping = false;
      perspPane.controls.update();
      perspPane.controls.enableDamping = prev;
    }
    if (name === "persp") {
      // Reset grid to XY (floor) plane — ortho views rotate it; perspective always uses XY.
      this.grid.rotation.set(Math.PI / 2, 0, 0);
      this.grid.position.set(0, 0, this._workingPlaneZ);
      // Restore perspective camera if we were in an ortho view.
      if (perspPane && perspPane.camera !== this.camera) {
        perspPane.camera = this.camera;
        perspPane.controls.object = this.camera;
        perspPane.controls.enableRotate = true;
        perspPane.controls.screenSpacePanning = false;
        perspPane.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
        perspPane.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
        perspPane.controls.zoomSpeed = 1;
        perspPane.controls.update();
        // #715: sync gizmo camera so TransformControls uses persp size math.
        for (const g of this.gizmos) g.camera = this.camera;
      }
      return;
    }
    const b = this.currentBounds ?? { min: [-5, -5, -5] as [number, number, number], max: [5, 5, 5] as [number, number, number] };
    const cx = (b.min[0] + b.max[0]) / 2;
    const cy = (b.min[1] + b.max[1]) / 2;
    const cz = (b.min[2] + b.max[2]) / 2;
    const dx = b.max[0] - b.min[0];
    const dy = b.max[1] - b.min[1];
    const dz = b.max[2] - b.min[2];
    const diag = Math.max(0.5, Math.sqrt(dx * dx + dy * dy + dz * dz));
    const dist = diag * 1.7;
    let dir: THREE.Vector3;
    switch (name) {
      case "top":     dir = new THREE.Vector3(0, 0, 1); break;
      case "bottom":  dir = new THREE.Vector3(0, 0, -1); break;
      case "front":   dir = new THREE.Vector3(0, -1, 0); break;
      case "back":    dir = new THREE.Vector3(0, 1, 0); break;
      case "right":   dir = new THREE.Vector3(1, 0, 0); break;
      case "left":    dir = new THREE.Vector3(-1, 0, 0); break;
      case "iso":     dir = new THREE.Vector3(1, 1, 1).normalize(); break;
      case "extents": dir = new THREE.Vector3(1, 1, 1.5).normalize(); break;
    }

    // #594: orient floor grid to match the ortho view's working plane.
    // Front/back → XZ plane (grid normal +Y); right/left → YZ (normal +X); else XY (normal +Z).
    switch (name) {
      case "front": case "back":
        this.grid.rotation.set(0, 0, 0);
        this.grid.position.set(0, 0, 0);
        break;
      case "right": case "left":
        this.grid.rotation.set(0, 0, Math.PI / 2);
        this.grid.position.set(0, 0, 0);
        break;
      default:
        this.grid.rotation.set(Math.PI / 2, 0, 0);
        this.grid.position.set(0, 0, this._workingPlaneZ);
        break;
    }
    const ORTHO_VIEWS = new Set(["top", "bottom", "front", "back", "left", "right", "iso"]);
    if (ORTHO_VIEWS.has(name) && perspPane) {
      // Switch persp pane to orthographic projection for axis-aligned and iso views (#331, #600).
      if (!this._orthoViewCamera) {
        this._orthoViewCamera = new THREE.OrthographicCamera(-5, 5, 5, -5, 0.01, 10000);
      }
      const oc = this._orthoViewCamera;
      const half = diag * 1.1;
      const pr = perspPane.el.getBoundingClientRect();
      const aspect = pr.width > 0 && pr.height > 0 ? pr.width / pr.height : 1;
      oc.left = -half * aspect;
      oc.right = half * aspect;
      oc.top = half;
      oc.bottom = -half;
      oc.near = 0.01;
      oc.far = diag * 200;
      // Plan views: Y is north. Elevation and iso views: Z is up.
      if (name === "top" || name === "bottom") oc.up.set(0, 1, 0);
      else oc.up.set(0, 0, 1);
      oc.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
      oc.lookAt(cx, cy, cz);
      oc.updateProjectionMatrix();
      perspPane.camera = oc;
      perspPane.controls.object = oc;
      perspPane.controls.enableRotate = true;
      perspPane.controls.screenSpacePanning = true;
      perspPane.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
      perspPane.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
      perspPane.controls.zoomSpeed = 1;
      perspPane.controls.target.set(cx, cy, cz);
      perspPane.controls.update();
      // #715: sync gizmo camera so TransformControls uses ortho size math.
      for (const g of this.gizmos) g.camera = oc;
    } else {
      // extents — restore perspective camera if needed.
      if (perspPane && perspPane.camera !== this.camera) {
        perspPane.camera = this.camera;
        perspPane.controls.object = this.camera;
        perspPane.controls.enableRotate = true;
        perspPane.controls.screenSpacePanning = false;
        perspPane.controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.DOLLY, RIGHT: THREE.MOUSE.PAN };
        perspPane.controls.touches = { ONE: THREE.TOUCH.ROTATE, TWO: THREE.TOUCH.DOLLY_PAN };
        perspPane.controls.zoomSpeed = 1;
        // #715: sync gizmo camera back to persp.
        for (const g of this.gizmos) g.camera = this.camera;
      }
      this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
      this.camera.updateProjectionMatrix();
      if (perspPane) {
        perspPane.controls.target.set(cx, cy, cz);
        perspPane.controls.update();
      }
    }
  }

  setWorkingPlaneZ(z: number): void {
    this._workingPlaneZ = z;
    // Only displace the XY grid (top/bottom/iso/persp). Front/back/left/right grids stay fixed.
    const activeView = this.activeView ?? "persp";
    const xyViews = new Set(["top", "bottom", "iso", "extents", "persp"]);
    if (xyViews.has(activeView)) {
      this.grid.position.z = z;
    }
  }

  setTargetElevation(z: number): void {
    const perspPane = this.panes.find(p => p.view === "persp");
    if (!perspPane) return;
    const dz = z - perspPane.controls.target.z;
    perspPane.controls.target.z = z;
    this.camera.position.z += dz;
    perspPane.controls.update();
    this.camera.updateProjectionMatrix();
  }

  splitMode(mode: "single" | "quad"): void {
    const area = this.canvas.parentElement;
    if (!area) return;
    area.classList.toggle("split-quad", mode === "quad");
    area.classList.toggle("split-single", mode === "single");
    this.handleResize();
  }

  createNavControls(view: string, domElement: HTMLElement): { dispose(): void } {
    const pane = this.panes.find(p => p.view === view);
    if (!pane) return { dispose() {} };
    const oc = new OrbitControls(pane.camera, domElement);
    if (pane.camera instanceof THREE.OrthographicCamera) {
      oc.enableRotate = false;
    }
    oc.enableDamping = false;
    return oc;
  }

  renderThumbnailTo(view: ViewName, dest: HTMLCanvasElement, anchorX = 0, anchorY = 0, snapW = 0, snapH = 0, displayMode?: string): void {
    const pane = this.panes.find(p => p.view === view);
    if (!pane) return;
    if (!this._thumbRenderer) {
      this._thumbCanvas = document.createElement("canvas");
      this._thumbRenderer = new THREE.WebGLRenderer({
        canvas: this._thumbCanvas,
        antialias: false,
        alpha: false,
      });
      this._thumbRenderer.setPixelRatio(1);
      this._thumbRenderer.autoClear = true;
      this._thumbRenderer.setClearColor(0x808080, 1);
    }
    const w = Math.max(1, dest.width);
    const h = Math.max(1, dest.height);
    this._thumbRenderer.setSize(w, h, false);
    let cam: THREE.Camera;
    // snapW/snapH are non-zero only during an active resize drag.
    // When dragging: use setViewOffset to produce window-crop behavior (geometry
    // stays anchored to the fixed edge while the panel resizes).
    // When not dragging: render with plain aspect=w/h so the thumbnail always
    // matches the model tab exactly regardless of aspect ratio differences.
    const dragging = snapW > 0 && snapH > 0;
    if (pane.camera instanceof THREE.OrthographicCamera) {
      const src = pane.camera;
      const worldTop    = src.top    || 5;
      const worldBottom = src.bottom || -5;
      const worldLeft   = src.left;
      const worldRight  = src.right;
      const worldH = worldTop - worldBottom;
      if (dragging) {
        // Window crop: fraction of the snap frame that fits the current canvas.
        const worldW = worldRight - worldLeft;
        const shownWorldH = worldH * h / snapH;
        const shownWorldW = worldW * w / snapW;
        const newLeft = anchorX === 0 ? worldLeft  : worldRight  - shownWorldW;
        const newTop  = anchorY === 0 ? worldTop   : worldBottom + shownWorldH;
        const tmp = new THREE.OrthographicCamera(
          newLeft, newLeft + shownWorldW,
          newTop,  newTop  - shownWorldH,
          src.near, src.far,
        );
        tmp.position.copy(src.position);
        tmp.quaternion.copy(src.quaternion);
        tmp.updateProjectionMatrix();
        cam = tmp;
      } else {
        // Sync with model tab: keep vertical extent, adapt horizontal to w/h.
        const half = worldH / 2;
        const tmp = new THREE.OrthographicCamera(
          -half * w / h, half * w / h, worldTop, worldBottom, src.near, src.far,
        );
        tmp.position.copy(src.position);
        tmp.quaternion.copy(src.quaternion);
        tmp.updateProjectionMatrix();
        cam = tmp;
      }
    } else {
      const src = pane.camera as THREE.PerspectiveCamera;
      const tmp = src.clone() as THREE.PerspectiveCamera;
      if (dragging) {
        // Window crop: render only the anchored portion of the snap-size frame.
        const offsetX = Math.round(anchorX * Math.max(0, snapW - w));
        const offsetY = Math.round(anchorY * Math.max(0, snapH - h));
        tmp.fov = src.fov;
        tmp.aspect = snapW / snapH;
        tmp.setViewOffset(snapW, snapH, offsetX, offsetY, w, h);
      } else {
        // Sync with model tab: same fov, adapt aspect to thumbnail canvas.
        tmp.fov = src.fov;
        tmp.aspect = w / h;
        if (tmp.view) tmp.clearViewOffset();
      }
      tmp.updateProjectionMatrix();
      cam = tmp;
    }
    this._thumbRenderer!.setClearColor(displayMode === "technical" ? 0xffffff : 0x808080, 1);
    const prevOverride = this.scene.overrideMaterial;
    if (displayMode === "wireframe") {
      if (!this._thumbMatWireframe) this._thumbMatWireframe = new THREE.MeshBasicMaterial({ color: 0x2a2a3a, wireframe: true });
      this.scene.overrideMaterial = this._thumbMatWireframe;
    } else if (displayMode === "ghosted") {
      if (!this._thumbMatGhosted) this._thumbMatGhosted = new THREE.MeshBasicMaterial({ color: 0x9ec5d8, transparent: true, opacity: 0.28, side: THREE.DoubleSide });
      this.scene.overrideMaterial = this._thumbMatGhosted;
    }
    // Drafting-apply-per-tick removed (#661): applyDrafting() walks every IFC mesh and
    // creates EdgesGeometry + LineSegments (~500 alloc/dealloc per tick for FZK-Haus).
    // Thumbnails now render whatever drafting state the scene already has.
    // Model and layout viewports are mutually exclusive by design, so the model viewport's
    // draft state is never active when this renders in the background.
    const needUndraftForThumb = displayMode !== "technical" && isDrafting(this.scene);
    const thumbRenderer = this._thumbRenderer!;
    if (needUndraftForThumb) {
      withoutDrafting(this.scene, () => thumbRenderer.render(this.scene, cam));
    } else {
      thumbRenderer.render(this.scene, cam);
    }
    this.scene.overrideMaterial = prevOverride;
    const ctx = dest.getContext("2d");
    if (ctx) ctx.drawImage(this._thumbCanvas!, 0, 0, w, h);
  }

  dispose(): void {
    this._themeObserver?.disconnect();
    this._themeObserver = null;
    this._thumbMatWireframe?.dispose();
    this._thumbMatGhosted?.dispose();
    this._clipFill.dispose(this.scene);
  }
}
