// scene-kg.ts — in-memory triplestore for agent scene understanding (T8).
//
// NOT a Parquet/DuckDB export layer. The KG is the live representation
// of "what's in the scene right now" + "how those elements relate" —
// the snapshot the agent reads at the start of each turn. As the user
// creates / modifies / deletes elements via dispatch.ts, the matching
// dispatch handler is responsible for keeping the KG in sync.
//
// Triple shape: { subject, predicate, object }. All three are strings —
// either UUIDs (for instances), name from the spatial
// dictionary (for types), or predicate names from predicates.ts.
//
// Predicates we track on day 1 (full set in predicates.ts):
//   - rdf:type — instance ↔ name
//   - hosts            — host (e.g. wall) hosts hosted (e.g. door)
//   - containedIn      — element contained in spatial structure
//   - aggregatedBy     — part aggregated by whole
//   - bounds           — face bounds space
//   - connectedTo      — element connected to element
//   - supports         — supporter supports supported (structural, sidecar)
//   - dependsOn        — derived depends on source (parametric, sidecar)
//   - groupedWith      — member grouped with group
//
// Persistence: scenes save as IFC4 (canonical predicates encoded
// natively as IfcRel*) + sidecar `kg.json` for predicates that don't
// fit IFC4 schema. predicates.ts owns the IFC4 round-trip mapping; this
// module is purely the in-memory store.

export interface Triple {
  subject: string;
  predicate: string;
  object: string;
}

export type TriplePart = "subject" | "predicate" | "object";

export interface QueryPattern {
  subject?: string;
  predicate?: string;
  object?: string;
}

// ============================================================
// Storage
// ============================================================

// Three indexes for O(1) lookup on any single column. Storage is the
// triple set; the indexes contain stringified triples so equality
// works.
const triples = new Set<string>();
const bySubject = new Map<string, Set<string>>();
const byPredicate = new Map<string, Set<string>>();
const byObject = new Map<string, Set<string>>();

// Unit-separator (U+001F) — control char not appearing in UUIDs,
// canonical names, or predicate names; safe as a triple-key delimiter.
const SEP = String.fromCharCode(0,0);  // U+0000 + U+0000 — never appears in UUIDs/predicates

function tripleKey(t: Triple): string {
  return t.subject + SEP + t.predicate + SEP + t.object;
}

function tripleFromKey(k: string): Triple {
  const [s, p, o] = k.split(SEP);
  return { subject: s, predicate: p, object: o };
}

function indexAdd(map: Map<string, Set<string>>, key: string, k: string) {
  let set = map.get(key);
  if (!set) {
    set = new Set<string>();
    map.set(key, set);
  }
  set.add(k);
}

function indexRemove(map: Map<string, Set<string>>, key: string, k: string) {
  const set = map.get(key);
  if (!set) return;
  set.delete(k);
  if (set.size === 0) map.delete(key);
}

// ============================================================
// Mutations
// ============================================================

/**
 * Add a triple. Returns true on insert, false if it was already present.
 */
export function addTriple(s: string, p: string, o: string): boolean {
  const key = tripleKey({ subject: s, predicate: p, object: o });
  if (triples.has(key)) return false;
  triples.add(key);
  indexAdd(bySubject, s, key);
  indexAdd(byPredicate, p, key);
  indexAdd(byObject, o, key);
  return true;
}

/**
 * Remove a specific triple. Returns true on removal, false if absent.
 */
export function removeTriple(s: string, p: string, o: string): boolean {
  const key = tripleKey({ subject: s, predicate: p, object: o });
  if (!triples.has(key)) return false;
  triples.delete(key);
  indexRemove(bySubject, s, key);
  indexRemove(byPredicate, p, key);
  indexRemove(byObject, o, key);
  return true;
}

/**
 * Remove every triple referencing `uuid` in any column. Used by
 * dispatch.delete handlers to keep the KG consistent on element
 * removal.
 */
export function removeAllForSubject(uuid: string): number {
  const subjectKeys = bySubject.get(uuid);
  const objectKeys = byObject.get(uuid);
  const allKeys = new Set<string>([...(subjectKeys ?? []), ...(objectKeys ?? [])]);
  let count = 0;
  for (const k of allKeys) {
    const t = tripleFromKey(k);
    if (removeTriple(t.subject, t.predicate, t.object)) count++;
  }
  return count;
}

/**
 * Wipe the entire KG. Used at scene reload + tests.
 */
export function clearKG(): void {
  triples.clear();
  bySubject.clear();
  byPredicate.clear();
  byObject.clear();
}

// ============================================================
// Queries
// ============================================================

/**
 * Query triples matching the pattern. Empty pattern returns all triples.
 * Multiple non-undefined fields are AND-ed.
 *
 * Implementation: pick the most-selective index for the smallest
 * candidate set, then filter.
 */
export function queryKG(pattern: QueryPattern = {}): Triple[] {
  // Pick the smallest index.
  const candidates: Set<string>[] = [];
  if (pattern.subject !== undefined) {
    const set = bySubject.get(pattern.subject);
    if (!set) return [];
    candidates.push(set);
  }
  if (pattern.predicate !== undefined) {
    const set = byPredicate.get(pattern.predicate);
    if (!set) return [];
    candidates.push(set);
  }
  if (pattern.object !== undefined) {
    const set = byObject.get(pattern.object);
    if (!set) return [];
    candidates.push(set);
  }

  // No pattern → return all triples.
  if (candidates.length === 0) {
    return [...triples].map(tripleFromKey);
  }

  // Intersect candidates (using the smallest as base).
  candidates.sort((a, b) => a.size - b.size);
  const out: Triple[] = [];
  for (const k of candidates[0]) {
    let hit = true;
    for (let i = 1; i < candidates.length; i++) {
      if (!candidates[i].has(k)) {
        hit = false;
        break;
      }
    }
    if (hit) out.push(tripleFromKey(k));
  }
  return out;
}

// ============================================================
// Convenience accessors (the patterns dispatch handlers actually want)
// ============================================================

/** All elements that the given uuid hosts (e.g. doors hosted by a wall). */
export function getHosts(uuid: string): string[] {
  return queryKG({ subject: uuid, predicate: "hosts" }).map((t) => t.object);
}

/** All elements contained in the given spatial structure (uuid). */
export function getContained(spaceUuid: string): string[] {
  return queryKG({ predicate: "containedIn", object: spaceUuid }).map((t) => t.subject);
}

/** The spatial structure containing the given element. Returns first hit. */
export function getContainer(elementUuid: string): string | null {
  const hits = queryKG({ subject: elementUuid, predicate: "containedIn" });
  return hits.length > 0 ? hits[0].object : null;
}

/** The type of an element (rdf:type → name). */
export function getType(uuid: string): string | null {
  const hits = queryKG({ subject: uuid, predicate: "rdf:type" });
  return hits.length > 0 ? hits[0].object : null;
}

/** All instances of a given canonical type. */
export function getInstancesOf(canonical: string): string[] {
  return queryKG({ predicate: "rdf:type", object: canonical }).map((t) => t.subject);
}

// ============================================================
// Selection — separate from triples; mutates in lockstep
// ============================================================

let selectedUuid: string | null = null;

export function setSelected(uuid: string | null): void {
  selectedUuid = uuid;
}

export function getSelected(): string | null {
  return selectedUuid;
}

// ============================================================
// Snapshot for agent context
// ============================================================

export interface KGSnapshot {
  totalTriples: number;
  selected: { uuid: string | null; type: string | null };
  counts: Record<string, number>; // name → instance count
  hostings: { host: string; hostType: string | null; hosted: string; hostedType: string | null }[];
  containment: { element: string; type: string | null; container: string }[];
}

/**
 * Compact snapshot for injection into the agent system prompt.
 * Bounded size so a 14-wall + 12-door scene fits comfortably under 5KB.
 */
export function snapshot(): KGSnapshot {
  const counts: Record<string, number> = {};
  for (const t of queryKG({ predicate: "rdf:type" })) {
    counts[t.object] = (counts[t.object] || 0) + 1;
  }
  const hostings = queryKG({ predicate: "hosts" }).map((t) => ({
    host: t.subject,
    hostType: getType(t.subject),
    hosted: t.object,
    hostedType: getType(t.object),
  }));
  const containment = queryKG({ predicate: "containedIn" }).map((t) => ({
    element: t.subject,
    type: getType(t.subject),
    container: t.object,
  }));
  return {
    totalTriples: triples.size,
    selected: {
      uuid: selectedUuid,
      type: selectedUuid ? getType(selectedUuid) : null,
    },
    counts,
    hostings,
    containment,
  };
}

/**
 * Render the snapshot as a short natural-language paragraph. This is
 * what the agent sees in its system context per turn.
 */
export function snapshotAsText(): string {
  const s = snapshot();
  if (s.totalTriples === 0) return "Current scene: empty.";
  const lines: string[] = [];
  const counts = Object.entries(s.counts)
    .map(([type, n]) => `${n} ${type}`)
    .join(", ");
  lines.push(`Current scene: ${counts || "no typed elements"}.`);
  if (s.selected.uuid) {
    lines.push(`Selected: ${s.selected.uuid}${s.selected.type ? ` (${s.selected.type})` : ""}.`);
  }
  if (s.hostings.length > 0) {
    const top = s.hostings.slice(0, 6).map((h) => {
      const ht = h.hostType ?? "?";
      const dt = h.hostedType ?? "?";
      return `${h.host} (${ht}) hosts ${h.hosted} (${dt})`;
    });
    lines.push(`Host relations: ${top.join("; ")}${s.hostings.length > 6 ? "; ..." : ""}.`);
  }
  return lines.join(" ");
}

// ============================================================
// Persistence (sidecar JSON only — IFC round-trip lives in predicates.ts)
// ============================================================

export interface KGSidecar {
  version: 1;
  triples: Triple[];
  selected: string | null;
}

/**
 * Serialize the KG to a sidecar JSON object suitable for OBJ/STL/GLB
 * accompaniment. IFC4 export DOES NOT use this — it goes through
 * predicates.ts and emits IfcRel* entities directly.
 */
export function toSidecar(): KGSidecar {
  return {
    version: 1,
    triples: queryKG({}),
    selected: selectedUuid,
  };
}

/**
 * Load a sidecar JSON object into the (cleared) KG.
 */
export function fromSidecar(sidecar: KGSidecar): void {
  if (sidecar.version !== 1) throw new Error(`unknown sidecar version ${sidecar.version}`);
  clearKG();
  for (const t of sidecar.triples) addTriple(t.subject, t.predicate, t.object);
  selectedUuid = sidecar.selected;
}

// ============================================================
// Counts (devtools)
// ============================================================

export function tripleCount(): number {
  return triples.size;
}

export function subjectCount(): number {
  return bySubject.size;
}
