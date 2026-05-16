// nurbs-curves-catmullrom.test.ts — Parity + round-trip tests for
// createCatmullRomAsNurbs (#710). All tests run under `bun test` (no DOM/WebGPU).

import { describe, expect, test } from "bun:test";
import { createCatmullRomAsNurbs, tessellate, pointAt } from "../src/nurbs/nurbs-curves";
import type { Point3 } from "../src/nurbs/nurbs-primitives";

const TOL = 1e-6;

// ── Reference Catmull-Rom evaluator ──────────────────────────────────────────
// Matches THREE.CatmullRomCurve3(pts, closed, "catmullrom", 0.5).getPoints(N).

function hermite(t: number, p0: number, p1: number, p2: number, p3: number): number {
  const v0 = (p2 - p0) * 0.5;
  const v1 = (p3 - p1) * 0.5;
  const t2 = t * t;
  const t3 = t * t2;
  return (2 * p1 - 2 * p2 + v0 + v1) * t3 + (-3 * p1 + 3 * p2 - 2 * v0 - v1) * t2 + v0 * t + p1;
}

function refCatmullRom(pts: Point3[], closed: boolean, N: number): Point3[] {
  const l = pts.length;
  const n = closed ? l : l - 1;
  const result: Point3[] = [];
  for (let s = 0; s <= N; s++) {
    const t = s / N;
    const point = t * n;
    const i = Math.min(Math.floor(point), n - 1);
    const w = point - i;
    const idx = (k: number) =>
      closed ? ((k % l) + l) % l : Math.max(0, Math.min(l - 1, k));
    const p0 = pts[idx(i - 1)];
    const p1 = pts[idx(i)];
    const p2 = pts[idx(i + 1)];
    const p3 = pts[idx(i + 2)];
    result.push({
      x: hermite(w, p0.x, p1.x, p2.x, p3.x),
      y: hermite(w, p0.y, p1.y, p2.y, p3.y),
      z: hermite(w, p0.z, p1.z, p2.z, p3.z),
    });
  }
  return result;
}

function maxErr(a: Point3[], b: Point3[]): number {
  let max = 0;
  for (let i = 0; i < Math.min(a.length, b.length); i++) {
    const dx = a[i].x - b[i].x;
    const dy = a[i].y - b[i].y;
    const dz = a[i].z - b[i].z;
    max = Math.max(max, Math.sqrt(dx * dx + dy * dy + dz * dz));
  }
  return max;
}

// ── Test data seeds ───────────────────────────────────────────────────────────

const SEEDS: { label: string; pts: Point3[] }[] = [
  {
    label: "collinear-3",
    pts: [{ x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 }, { x: 2, y: 0, z: 0 }],
  },
  {
    label: "square-4",
    pts: [
      { x: 0, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
      { x: 1, y: 1, z: 0 }, { x: 0, y: 1, z: 0 },
    ],
  },
  {
    label: "zigzag-5",
    pts: [
      { x: 0, y: 0, z: 0 }, { x: 1, y: 2, z: 0 }, { x: 2, y: -1, z: 0 },
      { x: 3, y: 1.5, z: 0 }, { x: 4, y: 0, z: 0 },
    ],
  },
  {
    label: "3d-helix-6",
    pts: Array.from({ length: 6 }, (_, i) => ({
      x: Math.cos((i * Math.PI) / 3),
      y: Math.sin((i * Math.PI) / 3),
      z: i * 0.3,
    })),
  },
  {
    label: "random-8",
    pts: [
      { x: 0.1, y: 0.9, z: 0 }, { x: 0.5, y: 0.3, z: 0.2 },
      { x: 1.2, y: 0.7, z: 0.1 }, { x: 1.8, y: 0.2, z: 0.4 },
      { x: 2.1, y: 1.1, z: 0.3 }, { x: 2.7, y: 0.5, z: 0 },
      { x: 3.2, y: 0.8, z: 0.1 }, { x: 3.9, y: 0.1, z: 0 },
    ],
  },
];

// ── Visual parity: open ───────────────────────────────────────────────────────

describe("createCatmullRomAsNurbs — open parity vs THREE reference", () => {
  for (const { label, pts } of SEEDS) {
    test(label, () => {
      const N = 128;
      const nurbs = createCatmullRomAsNurbs(pts, { closed: false });
      const ours = tessellate(nurbs, N + 1);
      const ref  = refCatmullRom(pts, false, N);
      expect(ours.length).toBe(ref.length);
      const err = maxErr(ours, ref);
      expect(err).toBeLessThan(TOL);
    });
  }
});

// ── Visual parity: closed ─────────────────────────────────────────────────────

describe("createCatmullRomAsNurbs — closed parity vs THREE reference", () => {
  for (const { label, pts } of SEEDS) {
    // Need >= 3 for a meaningful closed curve
    if (pts.length < 3) continue;
    test(label, () => {
      const N = 128;
      const nurbs = createCatmullRomAsNurbs(pts, { closed: true });
      const ours = tessellate(nurbs, N + 1);
      const ref  = refCatmullRom(pts, true, N);
      expect(ours.length).toBe(ref.length);
      const err = maxErr(ours, ref);
      expect(err).toBeLessThan(TOL);
    });
  }
});

// ── Structural: curve passes through all data points (open) ──────────────────

describe("createCatmullRomAsNurbs — open interpolates data points", () => {
  for (const { label, pts } of SEEDS) {
    test(label, () => {
      const nurbs = createCatmullRomAsNurbs(pts, { closed: false });
      const n = pts.length - 1;
      for (let i = 0; i <= n; i++) {
        const p = pointAt(nurbs, i);  // knot values are integers
        expect(Math.abs(p.x - pts[i].x)).toBeLessThan(TOL);
        expect(Math.abs(p.y - pts[i].y)).toBeLessThan(TOL);
        expect(Math.abs(p.z - pts[i].z)).toBeLessThan(TOL);
      }
    });
  }
});

// ── Structural: closed curve closes at P[0] ───────────────────────────────────

describe("createCatmullRomAsNurbs — closed curve closes", () => {
  for (const { label, pts } of SEEDS) {
    if (pts.length < 3) continue;
    test(label, () => {
      const nurbs = createCatmullRomAsNurbs(pts, { closed: true });
      const n = pts.length; // domain [0, n]
      const pStart = pointAt(nurbs, 0);
      const pEnd   = pointAt(nurbs, n);
      expect(Math.abs(pEnd.x - pStart.x)).toBeLessThan(TOL);
      expect(Math.abs(pEnd.y - pStart.y)).toBeLessThan(TOL);
      expect(Math.abs(pEnd.z - pStart.z)).toBeLessThan(TOL);
    });
  }
});

// ── Edge cases ────────────────────────────────────────────────────────────────

test("createCatmullRomAsNurbs: 2-point open is straight line", () => {
  const pts: Point3[] = [{ x: 0, y: 0, z: 0 }, { x: 1, y: 1, z: 0 }];
  const nurbs = createCatmullRomAsNurbs(pts);
  const mid = pointAt(nurbs, 0.5);
  expect(Math.abs(mid.x - 0.5)).toBeLessThan(TOL);
  expect(Math.abs(mid.y - 0.5)).toBeLessThan(TOL);
});

test("createCatmullRomAsNurbs: cvCount = 3*(m-1)+1 for open", () => {
  for (const { pts } of SEEDS) {
    const nurbs = createCatmullRomAsNurbs(pts, { closed: false });
    expect(nurbs.cvCount).toBe(3 * (pts.length - 1) + 1);
    expect(nurbs.knots.length).toBe(nurbs.order + nurbs.cvCount - 2);
  }
});

test("createCatmullRomAsNurbs: cvCount = 3*m+1 for closed", () => {
  for (const { pts } of SEEDS) {
    if (pts.length < 3) continue;
    const nurbs = createCatmullRomAsNurbs(pts, { closed: true });
    expect(nurbs.cvCount).toBe(3 * pts.length + 1);
    expect(nurbs.knots.length).toBe(nurbs.order + nurbs.cvCount - 2);
  }
});
