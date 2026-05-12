// ref-lines.ts — Reference line data model and in-memory store (#340).

export type RefLine = {
  id: string;
  start: [number, number];
  end: [number, number];
  label?: string;
};

type RefLineListener = () => void;

class RefLineStore {
  private _lines: Map<string, RefLine> = new Map();
  private _listeners: Set<RefLineListener> = new Set();

  subscribe(fn: RefLineListener): () => void {
    this._listeners.add(fn);
    return () => this._listeners.delete(fn);
  }

  private _notify(): void {
    for (const fn of this._listeners) fn();
  }

  all(): RefLine[] {
    return Array.from(this._lines.values());
  }

  add(opts: { start: [number, number]; end: [number, number]; label?: string }): RefLine {
    const id = `ref-line/${Date.now()}`;
    const entry: RefLine = { id, start: opts.start, end: opts.end, label: opts.label };
    this._lines.set(id, entry);
    this._notify();
    return entry;
  }
}

export const refLineStore = new RefLineStore();
