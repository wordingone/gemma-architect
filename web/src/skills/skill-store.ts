// skill-store.ts — IndexedDB-backed runtime store for user-saved skills.
//
// Build-time skills (web/skills/<name>/SKILL.md) are loaded separately by
// skills-loader.ts and are read-only. This store holds user-created skills
// captured from in-session dispatch sequences.

const DB_NAME = "gemma-architect-skills";
const DB_VERSION = 3;
const STORE = "skills";
const CLUSTER_STORE = "clusters";
const CANVAS_CLUSTER_STORE = "canvas-clusters";

export type SkillStep = {
  verb: string;
  args: Record<string, unknown>;
};

export type SavedSkill = {
  id: string;
  name: string;
  description: string;
  steps: SkillStep[];
  createdAt: number;
};

export type SkillClusterStep = {
  verb: string;
  params: Record<string, unknown>;
  relativeTs: number;
};

export type SkillCluster = {
  id: string;
  name: string;
  createdAt: number;
  steps: SkillClusterStep[];
};

// CanvasCluster stores a full canvas subgraph (nodes + edges) as JSON for
// save/load roundtrip on the SKILL NODES tab (#427).
export type CanvasCluster = {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  graphJson: string;  // JSON.stringify({ nodes, edges, groups })
  nodeCount: number;
  edgeCount: number;
};

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(CLUSTER_STORE)) {
        db.createObjectStore(CLUSTER_STORE, { keyPath: "id" });
      }
      if (!db.objectStoreNames.contains(CANVAS_CLUSTER_STORE)) {
        db.createObjectStore(CANVAS_CLUSTER_STORE, { keyPath: "id" });
      }
    };
    req.onsuccess = () => { _db = req.result; resolve(_db); };
    req.onerror   = () => reject(req.error);
  });
}

export async function listSavedSkills(): Promise<SavedSkill[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readonly");
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => {
      const all = (req.result as SavedSkill[]);
      all.sort((a, b) => b.createdAt - a.createdAt);
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveSkill(skill: Omit<SavedSkill, "id" | "createdAt">): Promise<SavedSkill> {
  const db = await openDB();
  const full: SavedSkill = {
    ...skill,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).add(full);
    req.onsuccess = () => resolve(full);
    req.onerror   = () => reject(req.error);
  });
}

export async function deleteSkill(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, "readwrite");
    const req = tx.objectStore(STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── SkillCluster CRUD ──────────────────────────────────────────────────────

export async function listClusters(): Promise<SkillCluster[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLUSTER_STORE, "readonly");
    const req = tx.objectStore(CLUSTER_STORE).getAll();
    req.onsuccess = () => {
      const all = req.result as SkillCluster[];
      all.sort((a, b) => b.createdAt - a.createdAt);
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveCluster(cluster: Omit<SkillCluster, "id" | "createdAt">): Promise<SkillCluster> {
  const db = await openDB();
  const full: SkillCluster = {
    ...cluster,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLUSTER_STORE, "readwrite");
    const req = tx.objectStore(CLUSTER_STORE).add(full);
    req.onsuccess = () => resolve(full);
    req.onerror   = () => reject(req.error);
  });
}

export async function getClusterByName(name: string): Promise<SkillCluster | null> {
  const clusters = await listClusters();
  return clusters.find(c => c.name === name) ?? null;
}

export async function deleteCluster(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CLUSTER_STORE, "readwrite");
    const req = tx.objectStore(CLUSTER_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// ── CanvasCluster CRUD (#427) ──────────────────────────────────────────────

export async function listCanvasClusters(): Promise<CanvasCluster[]> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CANVAS_CLUSTER_STORE, "readonly");
    const req = tx.objectStore(CANVAS_CLUSTER_STORE).getAll();
    req.onsuccess = () => {
      const all = req.result as CanvasCluster[];
      all.sort((a, b) => b.createdAt - a.createdAt);
      resolve(all);
    };
    req.onerror = () => reject(req.error);
  });
}

export async function saveCanvasCluster(cluster: Omit<CanvasCluster, "id" | "createdAt">): Promise<CanvasCluster> {
  const db = await openDB();
  const full: CanvasCluster = {
    ...cluster,
    id: crypto.randomUUID(),
    createdAt: Date.now(),
  };
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CANVAS_CLUSTER_STORE, "readwrite");
    const req = tx.objectStore(CANVAS_CLUSTER_STORE).add(full);
    req.onsuccess = () => resolve(full);
    req.onerror   = () => reject(req.error);
  });
}

export async function deleteCanvasCluster(id: string): Promise<void> {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(CANVAS_CLUSTER_STORE, "readwrite");
    const req = tx.objectStore(CANVAS_CLUSTER_STORE).delete(id);
    req.onsuccess = () => resolve();
    req.onerror   = () => reject(req.error);
  });
}

// Test instrumentation — exposes cluster CRUD for gemma-verify surface AC6 (#664).
if (typeof window !== "undefined") {
  (window as unknown as {
    __skillStore?: {
      saveCluster: typeof saveCluster;
      getClusterByName: typeof getClusterByName;
      deleteCluster: typeof deleteCluster;
      listCanvasClusters: typeof listCanvasClusters;
      saveCanvasCluster: typeof saveCanvasCluster;
    };
  }).__skillStore = { saveCluster, getClusterByName, deleteCluster, listCanvasClusters, saveCanvasCluster };
}
