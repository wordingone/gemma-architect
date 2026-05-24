// edge-classifier.ts — Architectural edge classification for 2D exports (#1804).
//
// Classifies each mesh edge per Rhino Make2D / AIA lineweight conventions:
//   section-cut  — edge intersects active section/clip plane
//   silhouette   — adjacent faces straddle the view plane (one faces cam, one away)
//   naked        — only one incident face (open mesh boundary: eave, slab edge)
//   hidden       — back-facing edge (visible in conventional dashed hidden-line style)
//   edge         — standard shared face boundary (default)
//   tangent      — adjacent faces nearly coplanar (smooth-surface boundary)
//
// Lineweight table (SVG stroke-width in panel px; PDF in mm via PX_TO_MM):
//   section-cut  2.0   (0.7mm equiv — THICKEST)
//   silhouette   1.4   (0.5mm equiv — THICK)
//   naked        1.0   (0.35mm equiv — MEDIUM)
//   edge         0.7   (0.25mm equiv — THIN)
//   tangent      0.5   (0.18mm equiv — HAIRLINE)
//   hidden       0.35  (0.13mm equiv — DASHED HAIRLINE)

import * as THREE from "three";
import { worldToPanelXY } from "./line-clip.js";

export type EdgeClass = "section-cut" | "silhouette" | "naked" | "edge" | "tangent" | "hidden";

export type ClassifiedEdgeSeg = {
  x1: number; y1: number; x2: number; y2: number;
  cls: EdgeClass;
};

/** stroke-width values for each EdgeClass (SVG px / PDF mm via scale). */
export const LINEWEIGHT: Record<EdgeClass, number> = {
  "section-cut": 2.0,
  "silhouette":  1.4,
  "naked":       1.0,
  "edge":        0.7,
  "tangent":     0.5,
  "hidden":      0.35,
};

/**
 * SVG stroke-dasharray value for each EdgeClass. Undefined = solid line.
 * "4 2" → 4px dash, 2px gap — standard architectural hidden-line dashes at panel scale.
 */
export const DASH_PATTERN: Partial<Record<EdgeClass, string>> = {
  "hidden": "4 2",
};

/**
 * DXF lineweight codes (group 370, AC1015+). Values are in hundredths of mm.
 * These map directly to the AutoCAD lweight enum.
 */
export const DXF_LWEIGHT: Record<EdgeClass, number> = {
  "section-cut": 70,
  "silhouette":  50,
  "naked":       35,
  "edge":        25,
  "tangent":     18,
  "hidden":      13,
};

/**
 * DXF linetype name per EdgeClass. "CONTINUOUS" for solid; "DASHED" for hidden.
 * The DASHED linetype must be defined in the LTYPE table.
 */
export const DXF_LINETYPE: Record<EdgeClass, string> = {
  "section-cut": "CONTINUOUS",
  "silhouette":  "CONTINUOUS",
  "naked":       "CONTINUOUS",
  "edge":        "CONTINUOUS",
  "tangent":     "CONTINUOUS",
  "hidden":      "DASHED",
};

// cos(20°) threshold for tangent-edge detection: faces with normal-dot > this
// are nearly coplanar → tangent.
const COS_TANGENT_THRESH = Math.cos((20 * Math.PI) / 180);

/**
 * Classify and project all edges of a mesh to panel XY.
 * Returns an array of ClassifiedEdgeSeg in panel pixel space.
 *
 * @param geom       BufferGeometry (indexed or non-indexed)
 * @param mat4       mesh.matrixWorld
 * @param projMat    camera projection × view matrix
 * @param viewDir    camera forward direction (world space)
 * @param panelW     panel width in px
 * @param panelH     panel height in px
 * @param sectionPlanes  active section/clip planes
 */
export function classifyMeshEdges(
  geom: THREE.BufferGeometry,
  mat4: THREE.Matrix4,
  projMat: THREE.Matrix4,
  viewDir: THREE.Vector3,
  panelW: number,
  panelH: number,
  sectionPlanes: THREE.Plane[],
): ClassifiedEdgeSeg[] {
  const pos = geom.attributes.position?.array as Float32Array | undefined;
  if (!pos) return [];

  const idx = geom.index?.array as Uint32Array | Uint16Array | undefined;
  const triCount = idx ? Math.floor(idx.length / 3) : Math.floor(pos.length / 9);
  if (triCount === 0) return [];

  // Step 1: compute per-face world normals.
  const tmpA = new THREE.Vector3(), tmpB = new THREE.Vector3(), tmpC = new THREE.Vector3();
  const normalMat = new THREE.Matrix3().getNormalMatrix(mat4);
  const faceNormals: THREE.Vector3[] = [];

  for (let t = 0; t < triCount; t++) {
    let ai: number, bi: number, ci: number;
    if (idx) {
      ai = idx[t * 3] * 3;
      bi = idx[t * 3 + 1] * 3;
      ci = idx[t * 3 + 2] * 3;
    } else {
      ai = t * 9; bi = t * 9 + 3; ci = t * 9 + 6;
    }
    tmpA.set(pos[ai], pos[ai + 1], pos[ai + 2]).applyMatrix4(mat4);
    tmpB.set(pos[bi], pos[bi + 1], pos[bi + 2]).applyMatrix4(mat4);
    tmpC.set(pos[ci], pos[ci + 1], pos[ci + 2]).applyMatrix4(mat4);
    const n = new THREE.Vector3().crossVectors(
      tmpB.clone().sub(tmpA),
      tmpC.clone().sub(tmpA),
    ).normalize().applyMatrix3(normalMat).normalize();
    faceNormals.push(n);
  }

  // Step 2: build edge → face index map.
  // Edge key: "minI_maxI" for the two vertex indices.
  type EdgeEntry = { vi: [number, number]; faces: number[] };
  const edgeMap = new Map<string, EdgeEntry>();

  function addEdge(vi0: number, vi1: number, faceIdx: number) {
    const lo = Math.min(vi0, vi1), hi = Math.max(vi0, vi1);
    const key = `${lo}_${hi}`;
    const e = edgeMap.get(key);
    if (e) {
      if (!e.faces.includes(faceIdx)) e.faces.push(faceIdx);
    } else {
      edgeMap.set(key, { vi: [lo, hi], faces: [faceIdx] });
    }
  }

  for (let t = 0; t < triCount; t++) {
    let i0: number, i1: number, i2: number;
    if (idx) {
      i0 = idx[t * 3]; i1 = idx[t * 3 + 1]; i2 = idx[t * 3 + 2];
    } else {
      i0 = t * 3; i1 = t * 3 + 1; i2 = t * 3 + 2;
    }
    addEdge(i0, i1, t);
    addEdge(i1, i2, t);
    addEdge(i2, i0, t);
  }

  // Step 3: classify each edge and project.
  const out: ClassifiedEdgeSeg[] = [];
  const pA = new THREE.Vector3(), pB = new THREE.Vector3();

  for (const { vi, faces } of edgeMap.values()) {
    const [i0, i1] = vi;
    const p0 = i0 * 3, p1 = i1 * 3;
    pA.set(pos[p0], pos[p0 + 1], pos[p0 + 2]).applyMatrix4(mat4);
    pB.set(pos[p1], pos[p1 + 1], pos[p1 + 2]).applyMatrix4(mat4);

    let cls: EdgeClass;
    if (faces.length === 1) {
      const n = faceNormals[faces[0]];
      const d = n.dot(viewDir);
      // Naked back-facing → hidden dashed (structure behind cut visible as hidden line).
      // Naked front-facing → naked solid (open boundary: eave, slab edge).
      cls = d > 0 ? "hidden" : "naked";
    } else {
      const n1 = faceNormals[faces[0]];
      const n2 = faceNormals[faces[1]];
      const d1 = n1.dot(viewDir);
      const d2 = n2.dot(viewDir);
      const dot12 = n1.dot(n2);

      // Section-cut: edge is on or very near a section plane.
      const onSection = sectionPlanes.some((pl) => {
        const da = Math.abs(pl.distanceToPoint(pA));
        const db = Math.abs(pl.distanceToPoint(pB));
        return da < 0.05 && db < 0.05;
      });

      if (onSection) {
        cls = "section-cut";
      } else if (Math.sign(d1) !== Math.sign(d2)) {
        // Silhouette: adjacent faces straddle view direction (one front-facing, one back-facing).
        cls = "silhouette";
      } else if (d1 > 0 && d2 > 0) {
        // Both faces back-facing → hidden interior edge (dashed in architectural convention).
        cls = "hidden";
      } else if (dot12 > COS_TANGENT_THRESH) {
        // Tangent: faces nearly coplanar (smooth surface boundary).
        cls = "tangent";
      } else {
        cls = "edge";
      }
    }

    const a2 = worldToPanelXY(pA, projMat, panelW, panelH);
    const b2 = worldToPanelXY(pB, projMat, panelW, panelH);
    if (!a2 || !b2) continue;
    out.push({ x1: a2[0], y1: a2[1], x2: b2[0], y2: b2[1], cls });
  }

  return out;
}
