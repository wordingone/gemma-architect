// skill-store.ts — IndexedDB-backed runtime store for user-saved skills.
//
// Build-time skills (web/skills/<name>/SKILL.md) are loaded separately by
// skills-loader.ts and are read-only. This store holds user-created skills
// captured from in-session dispatch sequences.

const DB_NAME = "gemma-architect-skills";
const DB_VERSION = 1;
const STORE = "skills";

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

let _db: IDBDatabase | null = null;

function openDB(): Promise<IDBDatabase> {
  if (_db) return Promise.resolve(_db);
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = () => {
      req.result.createObjectStore(STORE, { keyPath: "id" });
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
