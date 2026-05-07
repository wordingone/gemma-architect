// Test helpers — build a Viewer-shaped object without spinning a real
// WebGLRenderer. We construct the same scene + camera + raycaster graph
// the viewer uses, plus the helper-mesh builder, and re-use Viewer's
// pick() logic via a thin reimplementation that calls the same internals.
//
// Why not use the real Viewer class? It instantiates THREE.WebGLRenderer in
// its constructor; that touches `<canvas>.getContext("webgl2")` which bun's
// jsdom-free environment can't satisfy without a full headless-gl stack.
// We mirror the relevant subset here. The selection-state.ts module is
// shared verbatim, so any logic that reads filters / writes selection lands
// in the same singleton.

import * as THREE from "three";
import {
  setSelected,
  clearSelected,
  topologyAllowed,
  type Selection,
  type Topology,
} from "../src/viewer/selection-state";

type SelectionHelper = {
  owner: THREE.Mesh;
  ownerKind: "brep" | "compound" | "mesh";
  vertices: THREE.Points;
  edgeTubes: THREE.Group;
  edgeLines: THREE.LineSegments;
};

export class TestViewer {
  scene: THREE.Scene;
  camera: THREE.Camera;
  raycaster: THREE.Raycaster;
  helpers: SelectionHelper[] = [];
  // Build-mode hook — last-added mesh, used by the create-mode tests so they
  // don't have to re-walk the scene.
  lastAdded: THREE.Mesh | null = null;
  // Replicad construction sequence — tests assert on this string. Mirrors
  // what the real main.ts will accumulate as create-mode operations land.
  replicadSequence: string[] = [];
  // IFC entity count — incremented per create-mode add, decremented per delete.
  ifcEntityCount = 0;

  constructor() {
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(45, 1, 0.01, 1000);
    this.camera.position.set(8, 8, 8);
    this.raycaster = new THREE.Raycaster();
    if (this.raycaster.params.Points) this.raycaster.params.Points.threshold = 0.15;
    if (this.raycaster.params.Line) this.raycaster.params.Line.threshold = 0.05;
  }

  // Mirror of Viewer.buildHelpersForMesh — same logic, no scene-add
  // dependency. Returns the helper.
  buildHelpersForMesh(
    mesh: THREE.Mesh,
    kind: "brep" | "compound" | "mesh",
    diag: number,
  ): SelectionHelper {
    const g = mesh.geometry as THREE.BufferGeometry;
    const edgesGeom = new THREE.EdgesGeometry(g, 25);
    const edgePos = edgesGeom.attributes.position?.array as Float32Array | undefined;

    const vertexMap = new Map<string, [number, number, number]>();
    const segments: Array<[number, number, number, number, number, number]> = [];
    if (edgePos) {
      const round = (v: number) => Math.round(v * 1e4) / 1e4;
      for (let i = 0; i < edgePos.length; i += 6) {
        const ax = edgePos[i + 0], ay = edgePos[i + 1], az = edgePos[i + 2];
        const bx = edgePos[i + 3], by = edgePos[i + 4], bz = edgePos[i + 5];
        const ka = `${round(ax)},${round(ay)},${round(az)}`;
        const kb = `${round(bx)},${round(by)},${round(bz)}`;
        if (!vertexMap.has(ka)) vertexMap.set(ka, [ax, ay, az]);
        if (!vertexMap.has(kb)) vertexMap.set(kb, [bx, by, bz]);
        segments.push([ax, ay, az, bx, by, bz]);
      }
    }
    const vertexPositions = new Float32Array(vertexMap.size * 3);
    let vi = 0;
    for (const [, p] of vertexMap) {
      vertexPositions[vi++] = p[0];
      vertexPositions[vi++] = p[1];
      vertexPositions[vi++] = p[2];
    }
    const vGeom = new THREE.BufferGeometry();
    vGeom.setAttribute("position", new THREE.BufferAttribute(vertexPositions, 3));
    const vMat = new THREE.PointsMaterial({
      color: 0xff8a5b,
      size: Math.max(0.03, diag * 0.012),
      sizeAttenuation: true,
      transparent: true,
      opacity: 0.0,
    });
    const vertices = new THREE.Points(vGeom, vMat);
    vertices.userData.helperFor = mesh.uuid;
    this.scene.add(vertices);

    const edgeTubes = new THREE.Group();
    edgeTubes.visible = false;
    const tubeRadius = Math.max(0.01, diag * 0.004);
    const tubeMat = new THREE.MeshBasicMaterial({ visible: false, transparent: true, opacity: 0 });
    const maxSegments = 2000;
    const tubeCount = Math.min(segments.length, maxSegments);
    for (let i = 0; i < tubeCount; i++) {
      const [ax, ay, az, bx, by, bz] = segments[i];
      const tube = makeEdgeTube(ax, ay, az, bx, by, bz, tubeRadius, tubeMat);
      tube.userData.segmentIndex = i;
      tube.userData.helperFor = mesh.uuid;
      edgeTubes.add(tube);
    }
    this.scene.add(edgeTubes);

    const edgeMat = new THREE.LineBasicMaterial({ color: 0x0e0e10, transparent: true, opacity: 0.55 });
    const edgeLines = new THREE.LineSegments(edgesGeom, edgeMat);
    this.scene.add(edgeLines);

    return { owner: mesh, ownerKind: kind, vertices, edgeTubes, edgeLines };
  }

  // Mirror of Viewer.pick — returns a Selection or null based on the current
  // raycaster state and filter settings.
  pick(drilldown: boolean): Selection | null {
    if (topologyAllowed("vertex")) {
      for (const h of this.helpers) {
        const intersects = this.raycaster.intersectObject(h.vertices, false);
        if (intersects.length > 0) {
          const hit = intersects[0];
          return {
            topology: "vertex",
            uuid: h.vertices.uuid,
            object: h.vertices,
            parent: h.owner,
            parentUuid: h.owner.uuid,
            vertexIndex: hit.index ?? 0,
            transformTarget: h.owner,
          };
        }
      }
    }
    if (topologyAllowed("edge")) {
      for (const h of this.helpers) {
        const intersects = this.raycaster.intersectObjects(h.edgeTubes.children, false);
        if (intersects.length > 0) {
          const hit = intersects[0];
          const tube = hit.object as THREE.Mesh;
          const segIdx = (tube.userData?.segmentIndex as number) ?? 0;
          return {
            topology: "edge",
            uuid: tube.uuid,
            object: tube,
            parent: h.owner,
            parentUuid: h.owner.uuid,
            edgeIndex: segIdx,
            transformTarget: h.owner,
          };
        }
      }
    }
    const meshes = this.helpers.map((h) => h.owner);
    if (meshes.length === 0) return null;
    const hits = this.raycaster.intersectObjects(meshes, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const helper = this.helpers.find((h) => h.owner === hit.object);
    if (!helper) return null;
    const owner = helper.owner;
    if (drilldown && (helper.ownerKind === "brep" || helper.ownerKind === "compound")) {
      if (topologyAllowed("face")) {
        return {
          topology: "face",
          uuid: owner.uuid,
          object: owner,
          parent: owner,
          parentUuid: owner.uuid,
          faceIndex: hit.faceIndex ?? 0,
          transformTarget: owner,
        };
      }
    }
    let topology: Topology;
    if (helper.ownerKind === "brep") topology = "brep";
    else if (helper.ownerKind === "compound") topology = "compound";
    else topology = "mesh";

    if (!topologyAllowed(topology)) {
      if (topologyAllowed("face")) {
        return {
          topology: "face",
          uuid: owner.uuid,
          object: owner,
          parent: owner,
          parentUuid: owner.uuid,
          faceIndex: hit.faceIndex ?? 0,
          transformTarget: owner,
        };
      }
      if (topologyAllowed("mesh")) {
        return { topology: "mesh", uuid: owner.uuid, object: owner, transformTarget: owner };
      }
      return null;
    }
    return { topology, uuid: owner.uuid, object: owner, transformTarget: owner };
  }

  pickRay(origin: THREE.Vector3, direction: THREE.Vector3, opts?: { drilldown?: boolean }): Selection | null {
    this.raycaster.set(origin, direction.clone().normalize());
    const sel = this.pick(opts?.drilldown ?? false);
    if (sel) setSelected(sel);
    else clearSelected();
    return sel;
  }

  // Test-friendly mesh add — wraps in a group, builds helpers, returns mesh.
  addMesh(mesh: THREE.Mesh, kind: "brep" | "compound" | "mesh"): THREE.Mesh {
    mesh.userData.kind = kind;
    this.scene.add(mesh);
    this.helpers.push(this.buildHelpersForMesh(mesh, kind, 6));
    this.lastAdded = mesh;
    this.ifcEntityCount += 1;
    return mesh;
  }

  getScene(): THREE.Scene { return this.scene; }

  removeMesh(mesh: THREE.Mesh): boolean {
    const idx = this.helpers.findIndex((h) => h.owner === mesh);
    if (idx < 0) return false;
    const h = this.helpers[idx];
    this.scene.remove(h.vertices);
    this.scene.remove(h.edgeTubes);
    this.scene.remove(h.edgeLines);
    this.helpers.splice(idx, 1);
    this.scene.remove(mesh);
    this.ifcEntityCount = Math.max(0, this.ifcEntityCount - 1);
    return true;
  }
}

function makeEdgeTube(
  ax: number, ay: number, az: number,
  bx: number, by: number, bz: number,
  radius: number,
  material: THREE.Material,
): THREE.Mesh {
  const start = new THREE.Vector3(ax, ay, az);
  const end = new THREE.Vector3(bx, by, bz);
  const dir = new THREE.Vector3().subVectors(end, start);
  const length = dir.length();
  if (length === 0) {
    const g = new THREE.BufferGeometry();
    return new THREE.Mesh(g, material);
  }
  const geom = new THREE.CylinderGeometry(radius, radius, length, 6, 1, true);
  geom.translate(0, length / 2, 0);
  const mesh = new THREE.Mesh(geom, material);
  mesh.position.copy(start);
  mesh.quaternion.setFromUnitVectors(
    new THREE.Vector3(0, 1, 0),
    dir.clone().normalize(),
  );
  return mesh;
}

export function makeTestViewer(): TestViewer {
  return new TestViewer();
}

// Build a wall-shaped brep at the origin (per tier1 conventions:
// centered in X/Y, base-at-origin in Z).
export function addBoxBrep(v: TestViewer, w: number, d: number, h: number): THREE.Mesh {
  const geom = new THREE.BoxGeometry(w, d, h);
  // Box is centered; shift up by h/2 so base is at z=0.
  geom.translate(0, 0, h / 2);
  const mat = new THREE.MeshStandardMaterial({ color: 0x7ad3a3 });
  const mesh = new THREE.Mesh(geom, mat);
  v.addMesh(mesh, "brep");
  return mesh;
}
