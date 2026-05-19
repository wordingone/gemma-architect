// idb-quota.test.ts — §C-idb (#990) IDB quota guard + LRU eviction.
//
// Mirrors the quota check logic from:
//   skill-store.ts → _storageUsageFraction(), _evictOldestFrom(), _guardQuota()
//   drafter-cache.ts → quota guard before idbPut

import { describe, expect, test } from "bun:test";

// ── Mirror of skill-store.ts quota helpers ────────────────────────────────────
// Keep in sync with web/src/skills/skill-store.ts §C-idb section.

const IDB_QUOTA_THRESHOLD = 0.9;
const IDB_EVICT_PER_WRITE = 3;

type MockEntry = { id: string; createdAt: number };

// In-memory store substitute for IDB.
class MockStore {
  private _entries: MockEntry[] = [];

  add(entry: MockEntry): void { this._entries.push(entry); }
  getAll(): MockEntry[] { return [...this._entries]; }
  delete(id: string): void { this._entries = this._entries.filter(e => e.id !== id); }
  count(): number { return this._entries.length; }
}

// Mirror of _evictOldestFrom (LRU by createdAt, capped at n)
function evictOldestFrom(store: MockStore, n: number): number {
  const all = store.getAll().sort((a, b) => a.createdAt - b.createdAt);
  const toEvict = all.slice(0, Math.min(n, all.length));
  for (const e of toEvict) store.delete(e.id);
  return toEvict.length;
}

// Mirror of _guardQuota: returns true if write may proceed, throws if quota still exceeded.
function guardQuota(
  store: MockStore,
  usageFraction: () => number,
): { guarded: boolean; evicted: number } {
  const fill = usageFraction();
  if (fill <= IDB_QUOTA_THRESHOLD) return { guarded: false, evicted: 0 };
  const evicted = evictOldestFrom(store, IDB_EVICT_PER_WRITE);
  const afterFill = usageFraction();
  if (afterFill > IDB_QUOTA_THRESHOLD) {
    throw new Error("IDB quota exceeded: storage full after eviction");
  }
  return { guarded: true, evicted };
}

// Mirror of drafter-cache.ts idbPut quota guard (threshold 0.85, no eviction — just skip).
function drafterQuotaCheck(usageFraction: number): boolean {
  return usageFraction < 0.85;
}

// ── Quota guard tests ─────────────────────────────────────────────────────────

describe("#990 §C-idb — skill-store quota guard + LRU eviction", () => {

  test("quota below threshold: no eviction, write proceeds", () => {
    const store = new MockStore();
    store.add({ id: "s1", createdAt: 1000 });
    store.add({ id: "s2", createdAt: 2000 });
    const { guarded, evicted } = guardQuota(store, () => 0.5);
    expect(guarded).toBe(false);
    expect(evicted).toBe(0);
    expect(store.count()).toBe(2); // nothing evicted
  });

  test("quota at threshold: no eviction (threshold is exclusive >)", () => {
    const store = new MockStore();
    store.add({ id: "s1", createdAt: 1000 });
    const { guarded } = guardQuota(store, () => IDB_QUOTA_THRESHOLD);
    expect(guarded).toBe(false);
    expect(store.count()).toBe(1);
  });

  test("quota over threshold: evicts oldest N entries first", () => {
    const store = new MockStore();
    for (let i = 1; i <= 6; i++) store.add({ id: `s${i}`, createdAt: i * 1000 });
    // Usage stays >90% after eviction (simulate — mock always returns same fraction).
    // Use a counter to simulate quota dropping after eviction.
    let callCount = 0;
    const { guarded, evicted } = guardQuota(store, () => {
      callCount++;
      return callCount === 1 ? 0.95 : 0.7; // first check high, after eviction low
    });
    expect(guarded).toBe(true);
    expect(evicted).toBe(IDB_EVICT_PER_WRITE); // capped at 3
    expect(store.count()).toBe(3); // 6 - 3 evicted
    // Oldest 3 (s1, s2, s3 by createdAt) were evicted
    const remaining = store.getAll().map(e => e.id);
    expect(remaining).not.toContain("s1");
    expect(remaining).not.toContain("s2");
    expect(remaining).not.toContain("s3");
    expect(remaining).toContain("s4");
    expect(remaining).toContain("s5");
    expect(remaining).toContain("s6");
  });

  test("quota over threshold but eviction insufficient: throws", () => {
    const store = new MockStore();
    store.add({ id: "s1", createdAt: 1000 });
    // Quota always stays high even after eviction
    expect(() => guardQuota(store, () => 0.95)).toThrow("IDB quota exceeded");
  });

  test("quota over threshold with empty store: throws (nothing to evict)", () => {
    const store = new MockStore();
    expect(() => guardQuota(store, () => 0.95)).toThrow("IDB quota exceeded");
  });

  test("eviction capped at IDB_EVICT_PER_WRITE even when store has more", () => {
    const store = new MockStore();
    for (let i = 1; i <= 10; i++) store.add({ id: `s${i}`, createdAt: i * 1000 });
    let callCount = 0;
    guardQuota(store, () => {
      callCount++;
      return callCount === 1 ? 0.95 : 0.5;
    });
    expect(store.count()).toBe(10 - IDB_EVICT_PER_WRITE); // exactly IDB_EVICT_PER_WRITE removed
  });

  test("eviction is LRU by createdAt: oldest evicted first", () => {
    const store = new MockStore();
    store.add({ id: "newest", createdAt: 9000 });
    store.add({ id: "oldest", createdAt: 1000 });
    store.add({ id: "middle", createdAt: 5000 });
    store.add({ id: "second-oldest", createdAt: 2000 });

    let callCount = 0;
    const { evicted } = guardQuota(store, () => {
      callCount++;
      return callCount === 1 ? 0.95 : 0.5;
    });
    expect(evicted).toBe(3);
    // The 3 oldest (oldest, second-oldest, middle) evicted
    const remaining = store.getAll().map(e => e.id);
    expect(remaining).toEqual(["newest"]);
  });
});

// ── Drafter quota guard tests ─────────────────────────────────────────────────

describe("#990 §C-idb — drafter-cache quota guard (no eviction, skip-on-full)", () => {

  test("quota below 85%: store proceeds", () => {
    expect(drafterQuotaCheck(0.5)).toBe(true);
    expect(drafterQuotaCheck(0.84)).toBe(true);
  });

  test("quota at exactly 85%: skip (>= threshold)", () => {
    expect(drafterQuotaCheck(0.85)).toBe(false);
  });

  test("quota above 85%: skip", () => {
    expect(drafterQuotaCheck(0.9)).toBe(false);
    expect(drafterQuotaCheck(0.99)).toBe(false);
  });

  test("quota 0 (empty storage): store proceeds", () => {
    expect(drafterQuotaCheck(0)).toBe(true);
  });
});
