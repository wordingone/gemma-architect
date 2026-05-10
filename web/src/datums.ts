// datums.ts — Survey datum data model and in-memory store (#238).

export type Datum = {
  id: string;
  position: [number, number, number];
  label?: string;
};

type DatumListener = () => void;

class DatumStore {
  private _datums: Map<string, Datum> = new Map();
  private _listeners: Set<DatumListener> = new Set();

  subscribe(fn: DatumListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify() {
    for (const fn of this._listeners) fn();
  }

  all(): Datum[] {
    return Array.from(this._datums.values());
  }

  add(opts: { position: [number, number, number]; label?: string }): Datum {
    const id = `datum/${Date.now()}`;
    const entry: Datum = { id, position: opts.position, label: opts.label };
    this._datums.set(id, entry);
    this._notify();
    return entry;
  }
}

export const datumStore = new DatumStore();
