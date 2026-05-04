// Three.js viewer for replicad meshes.
//
// Receives a flat-array mesh from the worker, builds a BufferGeometry,
// and frames the camera on the result. Scissor-per-pane render loop
// supports single and quad viewport layouts. OrbitControls are per-pane.

import * as THREE from "three";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { TransformControls } from "three/examples/jsm/controls/TransformControls.js";
import { axesGizmoSVG } from "./icons.js";

type ViewName = "top" | "persp" | "front" | "right";
type Pane = {
  id: string;
  view: ViewName;
  el: HTMLElement;
  body: HTMLElement;
  camera: THREE.Camera;
  controls: OrbitControls;
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
  private axes: THREE.AxesHelper;
  private axisLabels: THREE.Sprite[] = [];
  private currentBounds: Bounds | null = null;
  private raycaster: THREE.Raycaster;
  private gizmo: TransformControls | null = null;

  constructor(canvas: HTMLCanvasElement, viewportAreaEl: HTMLElement) {
    this.canvas = canvas;
    this.renderer = new THREE.WebGLRenderer({
      canvas,
      antialias: true,
      alpha: true,
    });
    this.renderer.setPixelRatio(window.devicePixelRatio);
    this.renderer.setClearColor(0x000000, 0);
    this.renderer.shadowMap.enabled = false;
    this.renderer.autoClear = false;

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

    // Reference grid + axes.
    this.grid = new THREE.GridHelper(20, 20, 0x6f6f78, 0xc8c2b4);
    this.grid.rotation.x = Math.PI / 2;
    this.grid.renderOrder = -1;
    const gridMat = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
    for (const m of gridMat) { (m as THREE.LineBasicMaterial).depthWrite = false; }
    this.scene.add(this.grid);

    this.axes = new THREE.AxesHelper(2);
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
      this.panes.push({ id: el.id, view, el, body, camera, controls });

      const axesDiv = document.getElementById(`vp-axes-${idx + 1}`);
      if (axesDiv) axesDiv.innerHTML = axesGizmoSVG();
    });

    // Keep backward-compat controls reference pointing at persp pane.
    const perspPane = this.panes.find(p => p.view === "persp");
    if (perspPane) this.controls = perspPane.controls;

    this.handleResize();
    window.addEventListener("resize", () => this.handleResize());

    // Raycaster for object picking. Canvas mousedown → find hit pane →
    // compute NDC within that pane → cast ray → emit viewer:select event.
    this.raycaster = new THREE.Raycaster();
    this.canvas.addEventListener("mousedown", (e: MouseEvent) => this.onCanvasMouseDown(e));

    // TransformControls (gizmo) attached to the persp pane camera.
    if (perspPane && perspPane.camera instanceof THREE.PerspectiveCamera) {
      this.gizmo = new TransformControls(perspPane.camera, this.canvas);
      this.gizmo.addEventListener("dragging-changed", (ev) => {
        // Disable OrbitControls while dragging the gizmo.
        if (this.controls) this.controls.enabled = !(ev as THREE.Event & { value: boolean }).value;
      });
      this.scene.add(this.gizmo);
    }

    // G / R / S hotkeys switch gizmo mode; Del deselects.
    window.addEventListener("keydown", (e: KeyboardEvent) => {
      if (!this.gizmo || document.activeElement?.tagName === "INPUT" || document.activeElement?.tagName === "TEXTAREA") return;
      if (e.key === "g" || e.key === "G") this.gizmo.setMode("translate");
      if (e.key === "r" || e.key === "R") this.gizmo.setMode("rotate");
      if (e.key === "s" || e.key === "S") this.gizmo.setMode("scale");
      if (e.key === "Delete" || e.key === "Backspace") {
        if (this.gizmo.object) {
          this.scene.remove(this.gizmo.object);
          this.gizmo.detach();
          window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid: null } }));
        }
      }
    });

    this.animate();
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
    // Identify which pane was clicked by checking which pane rect contains the pointer.
    const cx = e.clientX, cy = e.clientY;
    const hitPane = this.panes.find(p => {
      const r = p.el.getBoundingClientRect();
      return cx >= r.left && cx <= r.right && cy >= r.top && cy <= r.bottom;
    });
    if (!hitPane) return;
    const pr = hitPane.el.getBoundingClientRect();
    const ndcX = ((cx - pr.left) / pr.width) * 2 - 1;
    const ndcY = -((cy - pr.top) / pr.height) * 2 + 1;
    this.raycaster.setFromCamera(new THREE.Vector2(ndcX, ndcY), hitPane.camera);
    const pickables = this.scene.children.filter(
      c => c !== this.grid && c !== this.axes && !(c instanceof THREE.Sprite) &&
           !(c instanceof THREE.DirectionalLight) && !(c instanceof THREE.AmbientLight) &&
           c !== this.gizmo
    );
    const hits = this.raycaster.intersectObjects(pickables, true);
    const hit = hits[0]?.object ?? null;
    const uuid = hit ? (hit.parent?.uuid ?? hit.uuid) : null;
    this.selectObject(hit?.parent instanceof THREE.Mesh || hit?.parent instanceof THREE.Group ? hit.parent : hit);
    window.dispatchEvent(new CustomEvent("viewer:select", { detail: { uuid } }));
  }

  /** Attach the transform gizmo to an object (null = detach). */
  selectObject(obj: THREE.Object3D | null): void {
    if (!this.gizmo) return;
    if (obj) this.gizmo.attach(obj);
    else this.gizmo.detach();
  }

  private animate = (): void => {
    requestAnimationFrame(this.animate);
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

      this.renderer.setScissor(x, gl_y, w, h);
      this.renderer.setScissorTest(true);
      this.renderer.setViewport(x, gl_y, w, h);
      this.renderer.clearDepth();
      pane.controls.update();
      this.renderer.render(this.scene, pane.camera);
    }
    this.renderer.setScissorTest(false);
  };

  private clearScene(): void {
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
  }

  setMesh(mesh: MeshIn, bounds: Bounds): void {
    this.clearScene();

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.BufferAttribute(mesh.vertices, 3));
    geometry.setAttribute("normal", new THREE.BufferAttribute(mesh.normals, 3));
    geometry.setIndex(new THREE.BufferAttribute(mesh.indices, 1));

    const material = new THREE.MeshStandardMaterial({
      color: 0x7ad3a3,
      roughness: 0.55,
      metalness: 0.05,
      flatShading: false,
    });
    const m = new THREE.Mesh(geometry, material);
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
    this.scene.add(edgeLines);
    this.currentEdges = edgeLines;

    this.fitCamera(bounds);
  }

  setObject(object: THREE.Object3D, bounds: Bounds): void {
    this.clearScene();
    this.scene.add(object);
    this.currentObject = object;
    this.fitCamera(bounds);
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

  getCamera(): THREE.PerspectiveCamera {
    return this.camera;
  }

  addMesh(mesh: THREE.Mesh, _kind?: string): void {
    this.scene.add(mesh);
  }

  removeObject(obj: THREE.Object3D): boolean {
    if (!this.scene.children.includes(obj)) return false;
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

    // Re-scale grid so it brackets the object.
    const gridSize = Math.max(20, Math.ceil(Math.max(dx, dy) * 2));
    if ((this.grid as any).__lastSize !== gridSize) {
      this.scene.remove(this.grid);
      this.grid.geometry.dispose();
      this.grid = new THREE.GridHelper(gridSize, gridSize, 0x444444, 0x2c2c34);
      this.grid.rotation.x = Math.PI / 2;
      this.grid.renderOrder = -1;
      const gMat2 = Array.isArray(this.grid.material) ? this.grid.material : [this.grid.material];
      for (const m of gMat2) { (m as THREE.LineBasicMaterial).depthWrite = false; }
      (this.grid as any).__lastSize = gridSize;
      this.scene.add(this.grid);
    }

    // Re-scale axis triad + labels.
    const triadLen = Math.max(2, Math.min(dx, dy, dz) * 0.5);
    this.scene.remove(this.axes);
    this.axes.dispose();
    this.axes = new THREE.AxesHelper(triadLen);
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

  setView(name: "top" | "bottom" | "front" | "back" | "left" | "right" | "iso" | "extents"): void {
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
    this.camera.position.set(cx + dir.x * dist, cy + dir.y * dist, cz + dir.z * dist);
    this.camera.updateProjectionMatrix();
    const perspPane = this.panes.find(p => p.view === "persp");
    if (perspPane) {
      perspPane.controls.target.set(cx, cy, cz);
      perspPane.controls.update();
    }
  }

  splitMode(mode: "single" | "quad"): void {
    const area = this.canvas.parentElement;
    if (!area) return;
    area.classList.toggle("split-quad", mode === "quad");
    area.classList.toggle("split-single", mode === "single");
    this.handleResize();
  }
}
