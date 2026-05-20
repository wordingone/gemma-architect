import * as THREE from "three";

// Liang-Barsky line-clip against a set of half-space planes.
// Returns the clipped [a, b] pair, or null if the segment is fully outside.
// Each plane's positive half-space is "inside" (distanceToPoint >= 0).
export function clipSegByPlanes(
  a: THREE.Vector3, b: THREE.Vector3, planes: THREE.Plane[],
): [THREE.Vector3, THREE.Vector3] | null {
  if (planes.length === 0) return [a, b];
  let t0 = 0, t1 = 1;
  const dx = b.x - a.x, dy = b.y - a.y, dz = b.z - a.z;
  for (const pl of planes) {
    const dA = pl.distanceToPoint(a);
    const dB = pl.distanceToPoint(b);
    const dot = dB - dA;
    if (Math.abs(dot) < 1e-10) { if (dA < 0) return null; continue; }
    const t = -dA / dot;
    if (dot < 0) { if (t < t1) t1 = t; }
    else         { if (t > t0) t0 = t; }
    if (t0 > t1 + 1e-10) return null;
  }
  if (t0 > t1 + 1e-10) return null;
  return [
    new THREE.Vector3(a.x + dx * t0, a.y + dy * t0, a.z + dz * t0),
    new THREE.Vector3(a.x + dx * t1, a.y + dy * t1, a.z + dz * t1),
  ];
}

// Project a world-space point to panel-local [x, y] in pixels.
// Returns null if the point is outside the NDC frustum.
export function worldToPanelXY(
  pt: THREE.Vector3, projMat: THREE.Matrix4, pw: number, ph: number,
): [number, number] | null {
  const v = pt.clone().applyMatrix4(projMat);
  if (v.z > 1.001 || v.z < -1.001) return null;
  return [(v.x * 0.5 + 0.5) * pw, (-v.y * 0.5 + 0.5) * ph];
}
