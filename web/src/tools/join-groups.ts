// join-groups.ts
// Universal structural join: whenever any structural element is placed,
// detect AABB overlaps with existing structural elements, compute CSG unions,
// and replace individual display meshes with the unioned display mesh.

import * as THREE from "three";
import { Brush, Evaluator, ADDITION } from "three-bvh-csg";

// Structural types eligible for boolean union.
// Walls are excluded: their junctions are solved parametrically by wall-corners.ts.
// Including walls in CSG causes broken geometry when non-indexed wallPrism meshes
// are unioned with slabs via three-bvh-csg.
const JOIN_CREATORS = new Set([
  "slab", "column", "beam", "stair", "roof",
  "foundation", "curtainwall", "ceiling",
]);

// Creators that must never be joined.
const SKIP_CREATORS = new Set([
  "section-box", "IfcGridLine", "IfcReferenceLine", "IfcLevel",
  "clip-plane", "space", "SdClippingPlane", "SdSectionBox",
]);

// Shared Evaluator instance (re-used across calls).
const _evaluator = new Evaluator();

// groupId → Set of logical mesh UUIDs in that group.
const _groups = new Map<string, Set<string>>();

// logical mesh UUID → groupId.
const _meshToGroup = new Map<string, string>();

// groupId → current display mesh UUID.
const _displayMesh = new Map<string, string>();

let _groupCounter = 0;
function _nextGroupId(): string {
  return `jg-${++_groupCounter}`;
}

function _isJoinable(mesh: THREE.Object3D): boolean {
  if (!(mesh instanceof THREE.Mesh)) return false;
  const creator = mesh.userData?.creator as string | undefined;
  if (!creator) return false;
  if (SKIP_CREATORS.has(creator)) return false;
  if (mesh.userData?.isJoinDisplay) return false;
  if (mesh.userData?.noSnap) return false;
  return JOIN_CREATORS.has(creator);
}

/** Build a world-space Brush from a mesh (position/rotation baked into geometry). */
function _worldBrush(mesh: THREE.Mesh): Brush {
  mesh.updateMatrixWorld(true);
  const cloned = mesh.geometry.clone();
  cloned.applyMatrix4(mesh.matrixWorld);
  const mat = Array.isArray(mesh.material) ? mesh.material[0] : mesh.material;
  const brush = new Brush(cloned, mat);
  brush.position.set(0, 0, 0);
  brush.rotation.set(0, 0, 0);
  brush.scale.set(1, 1, 1);
  brush.updateMatrixWorld(true);
  return brush;
}

/** Build a world-space CSG Brush from a mesh's literal geometry (no extension). */
function _brushForCsg(mesh: THREE.Mesh): Brush {
  return _worldBrush(mesh);
}

/** Remove an existing display mesh for a group from the scene. */
function _removeDisplayMesh(scene: THREE.Scene, groupId: string): void {
  const displayId = _displayMesh.get(groupId);
  if (!displayId) return;
  const existing = scene.getObjectByProperty("uuid", displayId);
  if (existing) {
    scene.remove(existing);
    if (existing instanceof THREE.Mesh) {
      existing.geometry.dispose();
    }
  }
  _displayMesh.delete(groupId);
}

/** Compute the CSG union of all logical meshes in a group and add the display mesh to the scene. */
function _rebuildGroupDisplay(scene: THREE.Scene, groupId: string, primaryMat: THREE.Material): void {
  const memberIds = _groups.get(groupId);
  if (!memberIds || memberIds.size === 0) return;

  // Collect live mesh objects (may have been removed from scene externally).
  const members: THREE.Mesh[] = [];
  for (const uuid of memberIds) {
    const obj = scene.getObjectByProperty("uuid", uuid);
    if (obj instanceof THREE.Mesh) members.push(obj);
  }

  if (members.length === 0) return;

  if (members.length === 1) {
    // Single member — show it directly, no CSG needed.
    // Join shells are invisible proxies for composite-geometry elements (e.g., curtain walls)
    // whose visual representation lives in a separate object — keep the shell hidden.
    if (!members[0].userData.isJoinShell) members[0].visible = true;
    return;
  }

  // Hide all logical members; display mesh will represent them.
  for (const m of members) m.visible = false;

  // Fold union: result = A ∪ B ∪ C ∪ …
  // Wall brushes are extended by t so corners fill without changing stored geometry.
  // Returns the folded Brush, or null if CSG fails.
  const buildUnion = (): Brush | null => {
    let acc: Brush = _brushForCsg(members[0]);
    for (let i = 1; i < members.length; i++) {
      const brushB = _brushForCsg(members[i]);
      const merged: Brush = _evaluator.evaluate(acc, brushB, ADDITION);
      if (i > 1) acc.geometry.dispose();
      brushB.geometry.dispose();
      acc = merged;
    }
    return acc;
  };

  let resultBrush: Brush;
  try {
    const union = buildUnion();
    if (!union) return;
    resultBrush = union;
  } catch (err) {
    console.warn("[join-groups] CSG union failed for group", groupId, err);
    window.dispatchEvent(new CustomEvent("sd:status", { detail: { msg: "Boolean join failed — geometry unchanged", kind: "warn" } }));
    for (const m of members) m.visible = true;
    return;
  }

  // Clone material so display mesh doesn't share emissive state with logical members.
  resultBrush.material = (primaryMat as THREE.Material).clone();
  resultBrush.userData.isJoinDisplay = true;
  resultBrush.userData.joinGroupId = groupId;
  resultBrush.userData.noSnap = true;

  scene.add(resultBrush);
  _displayMesh.set(groupId, resultBrush.uuid);
}

/** Dissolve the join group containing mesh `uuid`:
 *  removes the CSG display mesh, restores logical-member visibility,
 *  and clears all group bookkeeping so elements can be moved independently.
 */
export function dissolveGroupForMesh(uuid: string, scene: THREE.Scene): void {
  const groupId = _meshToGroup.get(uuid);
  if (!groupId) return;
  _removeDisplayMesh(scene, groupId);
  const members = _groups.get(groupId);
  if (members) {
    for (const id of members) {
      const obj = scene.getObjectByProperty("uuid", id);
      if (obj) obj.visible = true;
      _meshToGroup.delete(id);
    }
  }
  _groups.delete(groupId);
  _displayMesh.delete(groupId);
}

/** Among the logical members of `groupId`, return the mesh whose bounding-box center
 *  is nearest to `point` in world space. Returns null if no live members exist. */
export function nearestGroupMember(groupId: string, point: THREE.Vector3, scene: THREE.Scene): THREE.Mesh | null {
  const memberIds = _groups.get(groupId);
  if (!memberIds) return null;
  let best: THREE.Mesh | null = null;
  let bestDist = Infinity;
  const center = new THREE.Vector3();
  for (const id of memberIds) {
    const obj = scene.getObjectByProperty("uuid", id);
    if (!(obj instanceof THREE.Mesh)) continue;
    obj.updateMatrixWorld(true);
    new THREE.Box3().setFromObject(obj).getCenter(center);
    const d = point.distanceTo(center);
    if (d < bestDist) { bestDist = d; best = obj; }
  }
  return best;
}

// ── Hover peek: wireframe overlay for the nearest logical member ──────────────

let _peekWireframe: THREE.LineSegments | null = null;
let _peekMemberUuid: string | null = null;

/** Show an edge-wireframe outline of the logical member nearest to `hitPoint`
 *  inside `groupId`. Safe to call on every pointermove — no-ops when same member. */
export function peekNearestMember(groupId: string, hitPoint: THREE.Vector3, scene: THREE.Scene): void {
  const nearest = nearestGroupMember(groupId, hitPoint, scene);
  if (nearest?.uuid === _peekMemberUuid) return; // Same member — skip rebuild
  clearMemberPeek(scene);
  if (!nearest) return;
  nearest.updateMatrixWorld(true);
  const edges = new THREE.EdgesGeometry(nearest.geometry);
  const mat = new THREE.LineBasicMaterial({ color: 0x44aaff, depthTest: false });
  const wf = new THREE.LineSegments(edges, mat);
  wf.matrix.copy(nearest.matrixWorld);
  wf.matrixAutoUpdate = false;
  wf.renderOrder = 10;
  wf.userData.isPeekWireframe = true;
  scene.add(wf);
  _peekWireframe = wf;
  _peekMemberUuid = nearest.uuid;
}

/** Remove any active member peek wireframe. */
export function clearMemberPeek(scene: THREE.Scene): void {
  if (!_peekWireframe) return;
  scene.remove(_peekWireframe);
  (_peekWireframe.geometry as THREE.BufferGeometry).dispose();
  (_peekWireframe.material as THREE.Material).dispose();
  _peekWireframe = null;
  _peekMemberUuid = null;
}

/**
 * Call immediately after any structural mesh is added to the scene.
 * Detects AABB overlaps with existing structural elements, merges into join groups,
 * and rebuilds CSG union display meshes.
 */
export function onElementCommitted(newMesh: THREE.Mesh, scene: THREE.Scene): void {
  if (!_isJoinable(newMesh)) return;

  newMesh.updateMatrixWorld(true);
  const newBox = new THREE.Box3().setFromObject(newMesh);

  // Find all joinable scene meshes that overlap with newMesh.
  const overlapping: THREE.Mesh[] = [];
  scene.traverse((obj) => {
    if (!(obj instanceof THREE.Mesh)) return;
    if (obj === newMesh) return;
    if (!_isJoinable(obj)) return;
    obj.updateMatrixWorld(true);
    const box = new THREE.Box3().setFromObject(obj);
    if (newBox.intersectsBox(box)) overlapping.push(obj);
  });

  if (overlapping.length === 0) {
    // No overlaps — newMesh stays visible on its own; no group needed.
    return;
  }

  // Collect all group IDs that the overlapping meshes already belong to.
  const affectedGroupIds = new Set<string>();
  for (const m of overlapping) {
    const gid = _meshToGroup.get(m.uuid);
    if (gid) affectedGroupIds.add(gid);
  }

  // Determine or create the target group for newMesh.
  let targetGroupId: string;
  const existingGroupId = _meshToGroup.get(newMesh.uuid);

  if (affectedGroupIds.size === 0) {
    // No existing groups — create a fresh one.
    targetGroupId = existingGroupId ?? _nextGroupId();
  } else if (affectedGroupIds.size === 1) {
    // One existing group — merge newMesh into it.
    targetGroupId = [...affectedGroupIds][0];
  } else {
    // Multiple existing groups — merge all into the first (alphabetically by id is fine).
    const sorted = [...affectedGroupIds].sort();
    targetGroupId = sorted[0];

    // Absorb all other groups into targetGroupId.
    for (let i = 1; i < sorted.length; i++) {
      const srcId = sorted[i];
      const srcMembers = _groups.get(srcId);
      if (srcMembers) {
        let tgt = _groups.get(targetGroupId);
        if (!tgt) { tgt = new Set(); _groups.set(targetGroupId, tgt); }
        for (const uuid of srcMembers) {
          tgt.add(uuid);
          _meshToGroup.set(uuid, targetGroupId);
        }
        _groups.delete(srcId);
      }
      // Remove old display mesh for absorbed group.
      _removeDisplayMesh(scene, srcId);
      _displayMesh.delete(srcId);
    }
  }

  // Ensure target group exists.
  if (!_groups.has(targetGroupId)) _groups.set(targetGroupId, new Set());
  const targetGroup = _groups.get(targetGroupId)!;

  // Add newMesh and all overlapping meshes to the group.
  targetGroup.add(newMesh.uuid);
  _meshToGroup.set(newMesh.uuid, targetGroupId);
  for (const m of overlapping) {
    targetGroup.add(m.uuid);
    _meshToGroup.set(m.uuid, targetGroupId);
  }

  // Remove stale display mesh for this group before rebuilding.
  _removeDisplayMesh(scene, targetGroupId);

  // Use newMesh's material as the primary display material.
  const primaryMat = Array.isArray(newMesh.material)
    ? newMesh.material[0]
    : newMesh.material;

  _rebuildGroupDisplay(scene, targetGroupId, primaryMat);
}

// ── Boolean void cut for box-geometry walls (#324 / #754) ────────────────────
// Decomposes a BoxGeometry host into segments, replacing it with a Group that
// has a rectangular void at voidWorldCenter. Operates in the host's local space
// so works for any wall rotation. Silently skips if geometry is not a box.
export function cutRectVoidFromBoxMesh(
  host: THREE.Mesh,
  voidWorldCenter: THREE.Vector3,
  voidW: number,
  voidH: number,
): THREE.Group | null {
  host.updateMatrixWorld(true);
  const geom = host.geometry as THREE.BufferGeometry;
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb) return null;
  const wallLen   = bb.max.x - bb.min.x;
  const wallThick = bb.max.y - bb.min.y;
  const wallHt    = bb.max.z - bb.min.z;
  const wallZMin  = bb.min.z;

  // Void center in wall local space — only X and Z matter for a box wall.
  const localCenter = host.worldToLocal(voidWorldCenter.clone());
  const vX   = localCenter.x;
  const vZBot = localCenter.z - voidH / 2;
  const vZTop = localCenter.z + voidH / 2;

  const mat = (Array.isArray(host.material) ? host.material[0] : host.material) as THREE.Material;
  const seg = (segW: number, segH: number, ox: number, oz: number): THREE.Mesh => {
    const m = new THREE.Mesh(new THREE.BoxGeometry(segW, wallThick, segH), mat);
    m.position.set(bb.min.x + ox + segW / 2, 0, wallZMin + oz + segH / 2);
    return m;
  };

  const group = new THREE.Group();

  // Left of void
  const leftW = (vX - voidW / 2) - bb.min.x;
  if (leftW > 0.001) group.add(seg(leftW, wallHt, 0, 0));

  // Right of void
  const rightX = vX + voidW / 2;
  const rightW = bb.max.x - rightX;
  if (rightW > 0.001) group.add(seg(rightW, wallHt, rightX - bb.min.x, 0));

  // Below void (sill — for windows)
  const belowH = Math.max(0, vZBot - wallZMin);
  if (belowH > 0.001) group.add(seg(voidW, belowH, vX - voidW / 2 - bb.min.x, 0));

  // Above void
  const aboveBot = Math.min(vZTop, wallZMin + wallHt) - wallZMin;
  const aboveH   = (wallZMin + wallHt) - (wallZMin + aboveBot);
  if (aboveH > 0.001) group.add(seg(voidW, aboveH, vX - voidW / 2 - bb.min.x, aboveBot));

  // Copy host transform + metadata
  group.position.copy(host.position);
  group.rotation.copy(host.rotation);
  group.scale.copy(host.scale);
  group.userData = { ...host.userData };
  // Preserve the host uuid so scene.getObjectByProperty('uuid', wallUuid) still resolves
  // to the Group after void-cut (#1235). The mesh is removed from the scene immediately
  // below, so there is no uuid collision.
  group.uuid = host.uuid;

  // Swap host with group in parent
  const parent = host.parent;
  if (!parent) return null;
  parent.remove(host);
  geom.dispose();
  parent.add(group);

  // Store original wall dims + one-entry cut history in Group.
  group.userData.originalWallDims = { w: wallLen, d: wallThick, h: wallHt, zMin: wallZMin };
  group.userData.cutHistory = [{ cx: voidWorldCenter.x, cy: voidWorldCenter.y, cz: voidWorldCenter.z, w: voidW, h: voidH }];
  return group;
}

// ── Multi-void decomposition (#1520) ─────────────────────────────────────────
// Column-first decomposition: sorts all void X boundaries, then for each X strip
// computes the union of applicable Z holes. Handles N non-overlapping or overlapping
// voids in a single pass on a fresh solid wall Mesh.
// Internal — call addVoidToWallObject() from outside this module.
function _applyAllVoids(
  wallMesh: THREE.Mesh,
  voids: Array<{ center: THREE.Vector3; w: number; h: number }>,
): THREE.Group | null {
  wallMesh.updateMatrixWorld(true);
  const geom = wallMesh.geometry as THREE.BufferGeometry;
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb) return null;

  const wallLen   = bb.max.x - bb.min.x;
  const wallThick = bb.max.y - bb.min.y;
  const wallHt    = bb.max.z - bb.min.z;
  const wallZMin  = bb.min.z;
  const wallXMin  = bb.min.x;
  const wallXMax  = bb.max.x;
  const wallZMax  = wallZMin + wallHt;

  const mat = (Array.isArray(wallMesh.material) ? wallMesh.material[0] : wallMesh.material) as THREE.Material;

  // Convert void world centers → wall local space; clamp to wall bounds.
  type LocalVoid = { xMin: number; xMax: number; zBot: number; zTop: number };
  const localVoids: LocalVoid[] = voids.map(v => {
    const lc = wallMesh.worldToLocal(v.center.clone());
    return {
      xMin: Math.max(lc.x - v.w / 2, wallXMin),
      xMax: Math.min(lc.x + v.w / 2, wallXMax),
      zBot: Math.max(lc.z - v.h / 2, wallZMin),
      zTop: Math.min(lc.z + v.h / 2, wallZMax),
    };
  }).filter(v => v.xMin < v.xMax - 0.001 && v.zBot < v.zTop - 0.001);

  if (localVoids.length === 0) return null;

  // Collect all X-axis boundaries from all voids.
  const xBoundsSet = new Set<number>([wallXMin, wallXMax]);
  for (const v of localVoids) { xBoundsSet.add(v.xMin); xBoundsSet.add(v.xMax); }
  const xBounds = [...xBoundsSet].sort((a, b) => a - b);

  const group = new THREE.Group();

  const addSeg = (x0: number, x1: number, z0: number, z1: number) => {
    const sw = x1 - x0, sh = z1 - z0;
    if (sw <= 0.001 || sh <= 0.001) return;
    const m = new THREE.Mesh(new THREE.BoxGeometry(sw, wallThick, sh), mat);
    m.position.set(x0 + sw / 2, 0, z0 + sh / 2);
    group.add(m);
  };

  for (let xi = 0; xi < xBounds.length - 1; xi++) {
    const x0 = xBounds[xi];
    const x1 = xBounds[xi + 1];

    // Voids that fully cover this X strip.
    const active = localVoids.filter(v => v.xMin <= x0 + 0.0001 && v.xMax >= x1 - 0.0001);

    if (active.length === 0) {
      addSeg(x0, x1, wallZMin, wallZMax);
    } else {
      // Merge overlapping Z holes, then build wall segments around them.
      const holes = active.map(v => ({ z0: v.zBot, z1: v.zTop })).sort((a, b) => a.z0 - b.z0);
      const merged: { z0: number; z1: number }[] = [];
      for (const h of holes) {
        if (merged.length > 0 && h.z0 < merged[merged.length - 1].z1) {
          merged[merged.length - 1].z1 = Math.max(merged[merged.length - 1].z1, h.z1);
        } else {
          merged.push({ ...h });
        }
      }
      let prev = wallZMin;
      for (const h of merged) {
        addSeg(x0, x1, prev, h.z0);
        prev = h.z1;
      }
      addSeg(x0, x1, prev, wallZMax);
    }
  }

  // Copy transform + metadata; preserve uuid so wall lookups still resolve.
  group.position.copy(wallMesh.position);
  group.rotation.copy(wallMesh.rotation);
  group.scale.copy(wallMesh.scale);
  group.userData = { ...wallMesh.userData };
  group.uuid = wallMesh.uuid;

  const parent = wallMesh.parent;
  if (!parent) return null;
  parent.remove(wallMesh);
  geom.dispose();
  parent.add(group);

  group.userData.originalWallDims = { w: wallLen, d: wallThick, h: wallHt, zMin: wallZMin };
  group.userData.cutHistory = voids.map(v => ({
    cx: v.center.x, cy: v.center.y, cz: v.center.z, w: v.w, h: v.h,
  }));
  return group;
}

/** Void-cut helper that preserves all prior voids (#1520 compound-void preservation).
 *  Call this instead of cutRectVoidFromBoxMesh whenever the host wall may already
 *  be a Group (previously void-cut). Replays all prior cuts + the new cut in a single
 *  column-decomposition pass so no voids are lost.
 *
 *  Works on both Mesh (fresh wall) and Group (already void-cut wall). */
export function addVoidToWallObject(
  wallObj: THREE.Object3D,
  voidWorldCenter: THREE.Vector3,
  voidW: number,
  voidH: number,
): THREE.Group | null {
  type CutEntry = { cx: number; cy: number; cz: number; w: number; h: number };
  const newEntry = { center: voidWorldCenter, w: voidW, h: voidH };

  if (wallObj instanceof THREE.Mesh) {
    return _applyAllVoids(wallObj, [newEntry]);
  }

  if (wallObj instanceof THREE.Group) {
    const dims = wallObj.userData.originalWallDims as
      { w: number; d: number; h: number; zMin?: number } | undefined;
    if (!dims) return null;

    const history = (wallObj.userData.cutHistory as CutEntry[] | undefined) ?? [];

    // Rebuild solid wall from stored dims.
    let srcMat: THREE.Material | null = null;
    wallObj.traverse(c => {
      if (!srcMat && c instanceof THREE.Mesh)
        srcMat = (Array.isArray(c.material) ? c.material[0] : c.material) as THREE.Material;
    });
    const mat = srcMat
      ? (srcMat as THREE.Material).clone()
      : new THREE.MeshStandardMaterial({ color: 0xcccccc });

    const geo = new THREE.BoxGeometry(dims.w, dims.d, dims.h);
    // Restore non-default Z origin if needed (walls translated so bottom at z=0).
    const defaultZMin = -dims.h / 2;
    const zShift = (dims.zMin ?? defaultZMin) - defaultZMin;
    if (Math.abs(zShift) > 0.001) geo.translate(0, 0, zShift);

    const solid = new THREE.Mesh(geo, mat);
    solid.position.copy(wallObj.position);
    solid.quaternion.copy(wallObj.quaternion);
    solid.scale.copy(wallObj.scale);
    solid.userData = { ...wallObj.userData };
    delete (solid.userData as Record<string, unknown>).originalWallDims;
    delete (solid.userData as Record<string, unknown>).cutHistory;
    solid.uuid = wallObj.uuid;
    solid.updateMatrix();
    solid.updateMatrixWorld(true);

    const parent = wallObj.parent;
    if (!parent) return null;
    parent.remove(wallObj);
    parent.add(solid);

    // Apply ALL voids (history + new) in one pass.
    const allVoids = [
      ...history.map(e => ({ center: new THREE.Vector3(e.cx, e.cy, e.cz), w: e.w, h: e.h })),
      newEntry,
    ];
    return _applyAllVoids(solid, allVoids);
  }

  return null;
}

// ── Stair void cut for slabs (#900) ──────────────────────────────────────────
// Cuts a rectangular opening in a horizontal slab mesh (XY cut, opposite of
// cutRectVoidFromBoxMesh which cuts in XZ). Returns a Group in place of the slab,
// or null if the slab cannot be cut (not a box, or void doesn't overlap).
export function cutSlabVoidFromBoxMesh(
  slab: THREE.Mesh,
  voidMinX: number, voidMinY: number,
  voidMaxX: number, voidMaxY: number,
): THREE.Group | null {
  slab.updateMatrixWorld(true);
  const geom = slab.geometry as THREE.BufferGeometry;
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb) return null;

  // Convert void world XY to slab local space
  const toLocal = (wx: number, wy: number) => {
    const local = slab.worldToLocal(new THREE.Vector3(wx, wy, 0));
    return { x: local.x, y: local.y };
  };
  const lMin = toLocal(voidMinX, voidMinY);
  const lMax = toLocal(voidMaxX, voidMaxY);
  const vxMin = Math.min(lMin.x, lMax.x), vxMax = Math.max(lMin.x, lMax.x);
  const vyMin = Math.min(lMin.y, lMax.y), vyMax = Math.max(lMin.y, lMax.y);

  // No overlap
  if (vxMax <= bb.min.x || vxMin >= bb.max.x || vyMax <= bb.min.y || vyMin >= bb.max.y) return null;

  const slabZ = bb.min.z, slabH = bb.max.z - bb.min.z;
  const slabXMin = bb.min.x, slabXMax = bb.max.x;
  const slabYMin = bb.min.y, slabYMax = bb.max.y;
  const mat = (Array.isArray(slab.material) ? slab.material[0] : slab.material) as THREE.Material;

  const clampedVxMin = Math.max(vxMin, slabXMin);
  const clampedVxMax = Math.min(vxMax, slabXMax);
  const clampedVyMin = Math.max(vyMin, slabYMin);
  const clampedVyMax = Math.min(vyMax, slabYMax);

  const group = new THREE.Group();

  const seg = (x0: number, x1: number, y0: number, y1: number) => {
    const w = x1 - x0, d = y1 - y0;
    if (w <= 0.001 || d <= 0.001) return;
    const g = new THREE.BoxGeometry(w, d, slabH);
    const m = new THREE.Mesh(g, mat);
    m.position.set((x0 + x1) / 2, (y0 + y1) / 2, slabZ + slabH / 2);
    group.add(m);
  };

  // Left strip
  seg(slabXMin, clampedVxMin, slabYMin, slabYMax);
  // Right strip
  seg(clampedVxMax, slabXMax, slabYMin, slabYMax);
  // Bottom strip (between void x-extents)
  seg(clampedVxMin, clampedVxMax, slabYMin, clampedVyMin);
  // Top strip
  seg(clampedVxMin, clampedVxMax, clampedVyMax, slabYMax);

  group.position.copy(slab.position);
  group.rotation.copy(slab.rotation);
  group.scale.copy(slab.scale);
  group.userData = { ...slab.userData, stairVoidCut: true };
  group.uuid = slab.uuid;

  const parent = slab.parent;
  if (!parent) return null;
  parent.remove(slab);
  geom.dispose();
  parent.add(group);
  return group;
}

// ── Void restore for door/window delete (#875) ────────────────────────────────
// Call before removing a door or window from the scene. Finds the host wall
// Group (created by cutRectVoidFromBoxMesh) and replaces it with a solid Mesh.
// Returns { newWall, oldGroup } for undo recording, or null if nothing to restore.
export function restoreVoidCut(
  opening: THREE.Object3D,
  scene: THREE.Scene,
): { newWall: THREE.Mesh; oldGroup: THREE.Group } | null {
  const hostId = (opening.userData as Record<string, unknown>).hostExpressID as string | undefined;
  if (!hostId) return null;

  // Find the host wall Group (inherits expressID from the original wall Mesh).
  let hostGroup: THREE.Group | null = null;
  scene.traverse((obj) => {
    if (hostGroup || !(obj instanceof THREE.Group)) return;
    const uid = (obj.userData as Record<string, unknown>).expressID as string | undefined;
    if (uid === hostId || obj.uuid === hostId) hostGroup = obj as THREE.Group;
  });
  if (!hostGroup) return null;
  // TS control-flow loses the narrowing after the traverse closure — re-assert.
  const hg = hostGroup as THREE.Group;

  // Get stored dims — written by cutRectVoidFromBoxMesh above.
  const dims = (hg.userData as Record<string, unknown>).originalWallDims as
    { w: number; d: number; h: number } | undefined;
  if (!dims) return null;

  // Get material from first child Mesh.
  let srcMat: THREE.Material | null = null;
  hg.traverse((child) => {
    if (!srcMat && child instanceof THREE.Mesh) {
      srcMat = Array.isArray(child.material) ? child.material[0] : child.material as THREE.Material;
    }
  });
  const mat = srcMat ? (srcMat as THREE.Material).clone() : new THREE.MeshStandardMaterial({ color: 0x888888 });

  // Rebuild solid wall.
  const geom = new THREE.BoxGeometry(dims.w, dims.d, dims.h);
  const newWall = new THREE.Mesh(geom, mat);
  newWall.position.copy(hg.position);
  newWall.quaternion.copy(hg.quaternion);
  newWall.scale.copy(hg.scale);
  newWall.userData = { ...hg.userData };
  delete (newWall.userData as Record<string, unknown>).originalWallDims;
  newWall.updateMatrix();
  newWall.updateMatrixWorld(true);

  // Swap Group → Mesh in scene.
  const parent = hg.parent;
  if (!parent) return null;
  parent.remove(hg);
  parent.add(newWall);

  return { newWall, oldGroup: hg };
}

// ── Opening helpers (#875 AC3) ─────────────────────────────────────────────────

// All creator values that identify a placed door or window.
export function isOpening(creator: string | undefined): boolean {
  return creator === "door" || creator === "window" ||
         creator === "SdDoor" || creator === "SdWindow";
}

// Move-restore: restore old void, then cut a new void at opening's current world position.
// Requires opening.userData.voidW / voidH (set at placement by SdDoor/SdWindow handlers
// and by the tool-click path). Falls back to FZK defaults if missing.
// Returns { newGroup, oldGroup } for undo recording, or null if no host wall found.
export function rerecutVoid(
  opening: THREE.Object3D,
  scene: THREE.Scene,
): { newGroup: THREE.Group; oldGroup: THREE.Group } | null {
  const restore = restoreVoidCut(opening, scene);
  if (!restore) return null;

  const ud = opening.userData as Record<string, unknown>;
  const voidW = (ud.voidW as number | undefined) ?? 0.885;  // FZK_DOOR_W fallback
  const voidH = (ud.voidH as number | undefined) ?? 2.01;   // FZK_DOOR_H fallback

  // Void center: opening world position is at the bottom of the opening, so center is +voidH/2.
  opening.updateMatrixWorld(true);
  const voidCenter = new THREE.Vector3();
  opening.getWorldPosition(voidCenter);
  voidCenter.z += voidH / 2;

  const newGroup = cutRectVoidFromBoxMesh(restore.newWall, voidCenter, voidW, voidH);
  if (!newGroup) return null;

  return { newGroup, oldGroup: restore.oldGroup };
}

// ── Cross-wall opening rehost (#1221) ─────────────────────────────────────────
// Like rerecutVoid but handles the case where the opening has been dragged to a
// DIFFERENT wall. Restores the old host wall (Wall A) and cuts into the nearest
// wall at the new position (Wall B).
//
// Return shape carries enough info for a full two-replace undo transaction:
//   isCrossWall=false → single pushReplaceAction(newVoidGroup, [oldVoidGroup])
//   isCrossWall=true  → two pushReplaceActions:
//     restoredWallMesh ← [oldVoidGroup]   (undo Wall A restore)
//     newVoidGroup     ← [newHostMesh]    (undo Wall B void cut)
export interface RehostResult {
  newVoidGroup: THREE.Group;
  oldVoidGroup: THREE.Group | null;
  restoredWallMesh: THREE.Mesh | null;  // Wall A solid (cross-wall) or null (same-wall)
  newHostMesh: THREE.Object3D;          // Wall B before cut (Mesh or Group if already void-cut)
  isCrossWall: boolean;
  newHostExpressID: string;
}

export function rehostVoidCut(
  opening: THREE.Object3D,
  scene: THREE.Scene,
): RehostResult | null {
  const ud = opening.userData as Record<string, unknown>;
  const voidW = (ud.voidW as number | undefined) ?? 0.885;
  const voidH = (ud.voidH as number | undefined) ?? 2.01;

  opening.updateMatrixWorld(true);
  const voidCenter = new THREE.Vector3();
  opening.getWorldPosition(voidCenter);
  voidCenter.z += voidH / 2;

  // Restore old host wall (replaces Group→Mesh in scene).
  const restore = restoreVoidCut(opening, scene);

  // Try same-wall repositioning — only if void still overlaps the old wall's bounding box.
  if (restore?.newWall && _voidOverlapsWall(restore.newWall, voidCenter, voidW, voidH)) {
    const newVoidGroup = cutRectVoidFromBoxMesh(restore.newWall, voidCenter, voidW, voidH);
    if (newVoidGroup) {
      const hostId = (restore.newWall.userData as Record<string, unknown>).expressID as string | undefined ?? restore.newWall.uuid;
      return {
        newVoidGroup,
        oldVoidGroup: restore.oldGroup,
        restoredWallMesh: null,   // consumed by cutRect; not tracked separately for same-wall
        newHostMesh: restore.newWall,
        isCrossWall: false,
        newHostExpressID: hostId,
      };
    }
  }
  // Old wall restored as solid Mesh (restore.newWall still in scene). Fall through to cross-wall.

  // Cross-wall: find nearest wall (Mesh or Group) at new position (exclude just-restored old wall).
  const excludeUuid = restore?.newWall?.uuid;
  const nearest = _findNearestWallMesh(voidCenter, scene, 3, excludeUuid);
  if (!nearest) return null;

  // addVoidToWallObject handles both Mesh and Group hosts (#1536).
  const newVoidGroup = addVoidToWallObject(nearest, voidCenter, voidW, voidH);
  if (!newVoidGroup) return null;

  const newId = (nearest.userData as Record<string, unknown>).expressID as string | undefined ?? nearest.uuid;
  ud.hostExpressID = newId;

  return {
    newVoidGroup,
    oldVoidGroup: restore?.oldGroup ?? null,
    restoredWallMesh: restore?.newWall ?? null,
    newHostMesh: nearest,
    isCrossWall: true,
    newHostExpressID: newId,
  };
}

// Returns true if the void rectangle (centered at voidCenter, width voidW, height voidH)
// overlaps the wall's local-space bounding box in both X and Z.
function _voidOverlapsWall(
  wall: THREE.Mesh,
  voidCenter: THREE.Vector3,
  voidW: number,
  voidH: number,
): boolean {
  wall.updateMatrixWorld(true);
  const geom = wall.geometry as THREE.BufferGeometry;
  geom.computeBoundingBox();
  const bb = geom.boundingBox;
  if (!bb) return false;
  const local = wall.worldToLocal(voidCenter.clone());
  const overlapX = (local.x + voidW / 2 > bb.min.x + 0.01) && (local.x - voidW / 2 < bb.max.x - 0.01);
  const overlapZ = (local.z + voidH / 2 > bb.min.z + 0.01) && (local.z - voidH / 2 < bb.max.z - 0.01);
  return overlapX && overlapZ;
}

function _findNearestWallMesh(
  pos: THREE.Vector3,
  scene: THREE.Scene,
  maxDist: number,
  excludeUuid?: string,
): THREE.Object3D | null {
  let nearest: THREE.Object3D | null = null;
  let minDist = maxDist;
  scene.traverse((obj) => {
    // Accept both Mesh walls and Group walls (Group arises after addVoidToWallObject cuts a prior void).
    if (!(obj instanceof THREE.Mesh) && !(obj instanceof THREE.Group)) return;
    if (excludeUuid && obj.uuid === excludeUuid) return;
    const creator = obj.userData?.creator as string | undefined;
    if (creator !== "wall" && creator !== "SdWall") return;
    const bb = new THREE.Box3().setFromObject(obj);
    const center = bb.getCenter(new THREE.Vector3());
    const dist = pos.distanceTo(new THREE.Vector3(center.x, center.y, pos.z));
    if (dist < minDist) { minDist = dist; nearest = obj; }
  });
  return nearest;
}
