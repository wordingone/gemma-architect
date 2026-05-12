// Research-mode in-memory vector index.
//
// Hand-rolled TF-IDF + cosine similarity over a small markdown corpus.
// Zero external NLP dependencies — keeps the bundle small and the
// scoring math auditable.
//
// Math (all values are doubles):
//
//   tf(t, d)    = count(t in d) / total_terms(d)
//   df(t)       = number of docs containing t at least once
//   idf(t)      = ln( (N + 1) / (df(t) + 1) ) + 1     [smoothed; never zero]
//   weight(t,d) = tf(t,d) * idf(t)
//   |d|         = sqrt( sum_t weight(t,d)^2 )         [L2 norm]
//   score(q,d)  = sum_t (weight(t,q) * weight(t,d)) / (|q| * |d|)
//
// The smoothed idf form (BM25-Lucene-style) avoids div-by-zero on terms
// in every doc and on terms in zero docs (idf is always >= 1 for terms
// that appeared in the corpus, > 1 otherwise).
//
// Tokenization: lowercase, split on /\W+/. We do NOT stem or strip
// stopwords — for a 10-doc corpus with architectural jargon, recall is
// more important than precision and stemming "walls" -> "wall" produces
// false positives ("wallflower"). Stopwords are bounded out by idf
// already.

export type DocKind = "local" | "web";

export interface ResearchDoc {
  /** Stable identifier (filename without .md, or url path). */
  name: string;
  /** Display-friendly title (first H1 if present, else `name`). */
  title: string;
  /** Source classification — drives the LOCAL/WEB filter pills. */
  kind: DocKind;
  /** Origin label rendered in the UI (e.g. "LOCAL · research-corpus/"). */
  source: string;
  /** Raw markdown body. */
  body: string;
  /** Pre-tokenized text — populated by buildResearchIndex. */
  tokens: string[];
  /** Per-doc term frequencies (raw counts). */
  termCounts: Map<string, number>;
  /** Total term count for the doc, for tf normalization. */
  totalTerms: number;
  /** L2 norm of weighted vector — populated after idf is computed. */
  norm: number;
  /** Per-doc weighted vector (term -> weight). */
  weights: Map<string, number>;
}

export interface ResearchIndex {
  docs: ResearchDoc[];
  /** Document frequency for each term: term -> number of docs containing it. */
  df: Map<string, number>;
  /** N (total docs) — used in idf calc and surfaced for debug. */
  n: number;
  /** Inverse document frequency for each term. Computed once at build time. */
  idf: Map<string, number>;
}

export interface QueryResult {
  /** Doc identity. */
  name: string;
  title: string;
  kind: DocKind;
  source: string;
  /** Cosine similarity in [0, 1]. Higher is better. */
  score: number;
  /** A short snippet around the highest-scoring term match. */
  snippet: string;
  /** Line number (1-indexed) where the snippet starts. */
  line: number;
  /** Query terms that matched, lowercase. Drives <mark> highlighting. */
  matchedTerms: string[];
}

export interface QueryOptions {
  /** Filter by source kind. "local" = corpus, "web" = fixture URLs, undefined = all. */
  source?: DocKind | "all";
  /** Max results to return. Default 10. */
  limit?: number;
  /** Optional set of doc names to restrict to (used by the CITE filter). */
  restrictTo?: Set<string>;
}

// ---------------- Tokenization ----------------

const NON_WORD = /[^\p{L}\p{N}]+/u;

export function tokenize(text: string): string[] {
  if (!text) return [];
  // Lowercase, split on Unicode non-word, drop empty fragments.
  return text.toLowerCase().split(NON_WORD).filter((t) => t.length > 1);
}

// ---------------- Index construction ----------------

export interface CorpusEntry {
  name: string;
  title?: string;
  kind: DocKind;
  source: string;
  body: string;
}

/**
 * Build a TF-IDF + cosine index from a list of in-memory corpus entries.
 *
 * Async signature is intentional — callers may want to fetch markdown
 * over HTTP first and pipe results in. The indexing itself is sync
 * but we leave the seam open.
 */
export async function buildResearchIndex(
  entries: CorpusEntry[],
): Promise<ResearchIndex> {
  const docs: ResearchDoc[] = entries.map((e) => {
    const tokens = tokenize(e.body);
    const termCounts = new Map<string, number>();
    for (const t of tokens) {
      termCounts.set(t, (termCounts.get(t) ?? 0) + 1);
    }
    return {
      name: e.name,
      title: e.title ?? deriveTitle(e.body, e.name),
      kind: e.kind,
      source: e.source,
      body: e.body,
      tokens,
      termCounts,
      totalTerms: tokens.length || 1,
      norm: 0, // computed in second pass
      weights: new Map(),
    };
  });

  // First pass — document frequency.
  const df = new Map<string, number>();
  for (const d of docs) {
    for (const term of d.termCounts.keys()) {
      df.set(term, (df.get(term) ?? 0) + 1);
    }
  }

  // idf: smoothed log form. ln((N+1)/(df+1)) + 1.
  const n = docs.length;
  const idf = new Map<string, number>();
  for (const [term, dfCount] of df) {
    idf.set(term, Math.log((n + 1) / (dfCount + 1)) + 1);
  }

  // Second pass — per-doc weighted vector + L2 norm.
  for (const d of docs) {
    let sumSq = 0;
    for (const [term, count] of d.termCounts) {
      const tf = count / d.totalTerms;
      const w = tf * (idf.get(term) ?? 1);
      d.weights.set(term, w);
      sumSq += w * w;
    }
    d.norm = Math.sqrt(sumSq) || 1;
  }

  return { docs, df, n, idf };
}

function deriveTitle(body: string, fallback: string): string {
  const m = body.match(/^#\s+(.+?)\s*$/m);
  return m ? m[1].trim() : fallback;
}

// ---------------- Query ----------------

/**
 * Score the corpus against a free-text query and return the top-N
 * results, ranked by cosine similarity in descending order.
 *
 * Filters: pass `options.source = "local"` to restrict to corpus docs,
 * `"web"` for the (currently fixture) WEB sources, or omit / `"all"`
 * to score across both. The CITE filter is implemented above this
 * layer — pass `options.restrictTo = new Set(...)` to restrict by doc
 * name.
 */
export function queryResearch(
  idx: ResearchIndex,
  query: string,
  options: QueryOptions = {},
): QueryResult[] {
  const limit = options.limit ?? 10;
  const sourceFilter = options.source ?? "all";
  const queryTokens = tokenize(query);
  if (queryTokens.length === 0) return [];

  // Build the query vector: tf-idf weights using the corpus's idf.
  // Terms not in the corpus get idf=ln((N+1)/1)+1 (smoothed).
  const qCounts = new Map<string, number>();
  for (const t of queryTokens) qCounts.set(t, (qCounts.get(t) ?? 0) + 1);

  const qWeights = new Map<string, number>();
  let qSumSq = 0;
  for (const [term, count] of qCounts) {
    const tf = count / queryTokens.length;
    const idfVal = idx.idf.get(term) ?? Math.log((idx.n + 1) / 1) + 1;
    const w = tf * idfVal;
    qWeights.set(term, w);
    qSumSq += w * w;
  }
  const qNorm = Math.sqrt(qSumSq) || 1;

  const results: QueryResult[] = [];
  for (const d of idx.docs) {
    if (sourceFilter !== "all" && d.kind !== sourceFilter) continue;
    if (options.restrictTo && !options.restrictTo.has(d.name)) continue;

    // Dot product between query and doc weighted vectors.
    let dot = 0;
    const matched: string[] = [];
    for (const [term, qw] of qWeights) {
      const dw = d.weights.get(term);
      if (dw === undefined) continue;
      dot += qw * dw;
      matched.push(term);
    }
    if (dot === 0) continue;

    const score = dot / (qNorm * d.norm);
    const { snippet, line } = pickSnippet(d.body, matched);
    results.push({
      name: d.name,
      title: d.title,
      kind: d.kind,
      source: d.source,
      score,
      snippet,
      line,
      matchedTerms: matched,
    });
  }

  results.sort((a, b) => b.score - a.score);
  return results.slice(0, limit);
}

/**
 * Pick a ~240-char snippet around the first line that matches one of
 * the matched terms. Falls back to the first non-empty paragraph.
 *
 * Returns the 1-indexed line number alongside the snippet so the
 * citation tracker can record `{source, line, claim}` triples that
 * point at the actual passage.
 */
function pickSnippet(body: string, matched: string[]): { snippet: string; line: number } {
  const lines = body.split("\n");
  const matchSet = new Set(matched);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const stripped = line.trim();
    if (!stripped) continue;
    const tokens = tokenize(stripped);
    const hit = tokens.some((t) => matchSet.has(t));
    if (hit) {
      // Walk back past blank lines to the start of this paragraph and
      // forward past until we have ~240 chars or 4 lines.
      const start = i;
      let chunk = stripped;
      let j = i + 1;
      while (j < lines.length && chunk.length < 240) {
        const next = lines[j].trim();
        if (!next) break;
        chunk = chunk + " " + next;
        j++;
      }
      return { snippet: chunk.slice(0, 240), line: start + 1 };
    }
  }
  // Fallback — first non-empty line.
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim()) {
      return { snippet: lines[i].trim().slice(0, 240), line: i + 1 };
    }
  }
  return { snippet: "", line: 1 };
}

// ---------------- Citation tracker ----------------

export interface Citation {
  source: string;       // doc name
  line: number;         // 1-indexed
  claim: string;        // the actual snippet text
  ts: number;           // unix ms when the citation was captured
}

export interface CitationTracker {
  cite(c: Omit<Citation, "ts"> & { ts?: number }): Citation;
  list(): Citation[];
  remove(index: number): void;
  clear(): void;
  /** Set of cited doc names — used by the CITE filter. */
  citedSources(): Set<string>;
  /** JSON-serializable export. */
  exportJSON(): string;
}

export function createCitationTracker(): CitationTracker {
  const items: Citation[] = [];
  return {
    cite(c) {
      const entry: Citation = {
        source: c.source,
        line: c.line,
        claim: c.claim,
        ts: c.ts ?? Date.now(),
      };
      items.push(entry);
      return entry;
    },
    list() {
      return items.slice();
    },
    remove(idx: number) {
      if (idx >= 0 && idx < items.length) items.splice(idx, 1);
    },
    clear() {
      items.length = 0;
    },
    citedSources() {
      return new Set(items.map((c) => c.source));
    },
    exportJSON() {
      return JSON.stringify(items, null, 2);
    },
  };
}

// Corpus loader (with Vite-bundled markdown imports) lives in
// `research-corpus-loader.ts`. Pure scoring math stays here so tests
// and Node-side scripts can build an index from in-memory entries
// without triggering the `?raw` import chain.
