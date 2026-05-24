// Paper Mode (#02 LAYOUT) + Research Mode (#03 RESEARCH).
//
// Both modes render full-area replacements inside .workbench. The workbench
// children (palette / center-col / sidebar) are hidden via [data-mode] on
// .workbench when mode != "model", and the matching .paper-mode / .research-mode
// container shows.
//
// PaperMode (T15) uses the layout.ts controller — sheet sizes, click-drag
// panel creation, viewport pickers, scale bars, editable title block, and
// PDF/SVG/AI/DWG export. Existing viewports (top/front/right/perspective)
// ARE the cameras; panels just choose which one to render at a given scale.
//
// ResearchMode (T16) is three columns:
//   - left  : corpus listing + search input. Filter pills (LOCAL / WEB /
//             CITE) restrict the corpus before the query scores.
//   - middle: rendered markdown of the active doc with `<mark>`-tag
//             highlighting on query terms.
//   - right : findings (top-N ranked snippets with citation buttons) +
//             session citation log + JSON download.
// All scoring is in `research-index.ts` (TF-IDF + cosine, hand-rolled).

import { iconSVG } from "../ui/icons";
import { buildLayoutMode, addPanel, getController, type SceneBounds } from "./layout";
import { buildLayoutPalette } from "./workbench";
import { buildLayoutLayersPanel } from "./layers-panel";
import {
  buildResearchIndex,
  queryResearch,
  createCitationTracker,
  type ResearchIndex,
  type QueryResult,
  type DocKind,
  type CitationTracker,
} from "../research/research-index";
import { defaultCorpus } from "../research/research-corpus-loader";
import { renderMarkdown } from "../research/research-md";

function buildPaperMode(boundsProvider?: () => SceneBounds | null): HTMLElement {
  const el = document.createElement("div");
  el.className = "paper-mode mode-pane";
  el.dataset.modePane = "layout";
  el.style.display = "none";
  // Build the layout controller into the host. It will inject .paper-toolbar,
  // .paper-stage > .paper-sheet, and the editable title block. Seed with
  // four panels so the first paint mirrors the original 4-cell mockup.
  buildLayoutMode(el, {
    size: "Tabloid",
    orientation: "landscape",
    showTitleBlock: false,
    bounds: boundsProvider
      ? () => { const b = boundsProvider(); return b ?? ({ min: [-1, -1, -1], max: [1, 1, 1] } as SceneBounds); }
      : undefined,
  });

  // Inject leftside palette (grid-area: palette) into the paper-mode grid.
  const paletteEl = document.createElement("div");
  paletteEl.className = "paper-palette";
  buildLayoutPalette(paletteEl);
  el.appendChild(paletteEl);

  // Inject rightside layers panel (grid-area: layers) into the paper-mode grid.
  const layersEl = document.createElement("div");
  layersEl.className = "paper-layers";
  buildLayoutLayersPanel(layersEl);
  el.appendChild(layersEl);

  void addPanel;
  return el;
}

// ---------------- Research mode (functional) ----------------

interface ResearchState {
  index: ResearchIndex | null;
  tracker: CitationTracker;
  activeDoc: string | null;       // doc name currently shown in the viewer
  query: string;                  // latest search query
  results: QueryResult[];         // ranked results for the query
  filterLocal: boolean;
  filterWeb: boolean;
  filterCite: boolean;
}

function buildResearchMode(): HTMLElement {
  const el = document.createElement("div");
  el.className = "research-mode mode-pane";
  el.dataset.modePane = "research";
  el.style.display = "none";

  const state: ResearchState = {
    index: null,
    tracker: createCitationTracker(),
    activeDoc: null,
    query: "",
    results: [],
    filterLocal: true,
    filterWeb: true,
    filterCite: false,
  };

  // Expose state for in-page debugging + headless tests poking from
  // playwright. Read-only handle.
  (window as unknown as { __research?: ResearchState }).__research = state;

  el.innerHTML = `
    <div class="research-col">
      <div class="research-header">${iconSVG("import", 13)} CORPUS <span class="pill" id="r-corpus-pill">— docs</span></div>
      <div class="research-search">
        <input type="search" id="r-query" placeholder="search the corpus  ·  e.g. wall thickness conventions"/>
      </div>
      <div class="research-body" id="r-corpus-list"></div>
    </div>
    <div class="research-doc-viewer">
      <div class="rdv-toolbar">
        <span style="font-weight:700; color:var(--ink);" id="r-active-name">— select a doc —</span>
        <span style="flex:1;"></span>
        <span id="r-hit-count">0 hits</span>
      </div>
      <div class="rdv-pages" id="r-doc-body">
        <div class="rdv-page"><p style="color: var(--ink-faint);">Indexing corpus…</p></div>
      </div>
    </div>
    <div class="research-col">
      <div class="research-header">${iconSVG("sparkle", 13)} FINDINGS <span class="pill" id="r-cite-pill">0 cited</span></div>
      <div class="research-body findings-list" id="r-findings"></div>
      <div class="research-prompt">
        <div class="rp-actions">
          <div class="rp-toggles">
            <span class="rp-toggle active" data-filter="local">LOCAL</span>
            <span class="rp-toggle active" data-filter="web">WEB</span>
            <span class="rp-toggle" data-filter="cite">CITE</span>
          </div>
          <span class="rp-export" id="r-export" title="Download citations.json">${iconSVG("export", 11)} export</span>
        </div>
      </div>
    </div>
  `;

  // ---- DOM handles ----
  const queryInput = el.querySelector<HTMLInputElement>("#r-query")!;
  const corpusList = el.querySelector<HTMLElement>("#r-corpus-list")!;
  const corpusPill = el.querySelector<HTMLElement>("#r-corpus-pill")!;
  const activeName = el.querySelector<HTMLElement>("#r-active-name")!;
  const docBody = el.querySelector<HTMLElement>("#r-doc-body")!;
  const hitCount = el.querySelector<HTMLElement>("#r-hit-count")!;
  const findings = el.querySelector<HTMLElement>("#r-findings")!;
  const citePill = el.querySelector<HTMLElement>("#r-cite-pill")!;
  const exportBtn = el.querySelector<HTMLElement>("#r-export")!;

  // ---- Build the index asynchronously ----
  buildResearchIndex(defaultCorpus())
    .then((idx) => {
      state.index = idx;
      // Default active doc = first local doc.
      const first = idx.docs.find((d) => d.kind === "local") ?? idx.docs[0];
      if (first) state.activeDoc = first.name;
      renderAll();
    })
    .catch((e) => {
      docBody.innerHTML = `<div class="rdv-page"><p style="color: var(--err);">Failed to build research index: ${(e as Error).message}</p></div>`;
    });

  // ---- Re-render the entire research mode ----
  function renderAll() {
    if (!state.index) return;
    renderCorpusList();
    renderActiveDoc();
    renderFindings();
    renderCitePill();
  }

  function activeFilter(): DocKind | "all" {
    if (state.filterLocal && !state.filterWeb) return "local";
    if (state.filterWeb && !state.filterLocal) return "web";
    return "all";
  }

  function restrictSet(): Set<string> | undefined {
    if (!state.filterCite) return undefined;
    return state.tracker.citedSources();
  }

  function visibleDocs() {
    if (!state.index) return [];
    const filter = activeFilter();
    const restrict = restrictSet();
    return state.index.docs.filter((d) => {
      if (filter !== "all" && d.kind !== filter) return false;
      if (restrict && !restrict.has(d.name)) return false;
      return true;
    });
  }

  function renderCorpusList() {
    if (!state.index) return;
    const docs = visibleDocs();
    corpusPill.textContent = `${docs.length} docs`;

    // If a query is set, sort by score; otherwise alphabetical.
    let cards: { name: string; title: string; source: string; score?: number }[];
    if (state.query.trim()) {
      cards = state.results.map((r) => ({
        name: r.name,
        title: r.title,
        source: r.source,
        score: r.score,
      }));
      // Append filtered docs that didn't score (so the user can still
      // pick them).
      const seen = new Set(cards.map((c) => c.name));
      for (const d of docs) {
        if (!seen.has(d.name)) cards.push({ name: d.name, title: d.title, source: d.source });
      }
    } else {
      cards = docs.map((d) => ({ name: d.name, title: d.title, source: d.source }));
    }

    corpusList.innerHTML = cards
      .map((c) => {
        const active = state.activeDoc === c.name ? " active" : "";
        const scoreLine = c.score !== undefined
          ? `<div class="dc-meta">score: ${c.score.toFixed(3)}</div>`
          : "";
        const cited = state.tracker.citedSources().has(c.name)
          ? `<span class="dc-tag">cited</span>`
          : "";
        return `
          <div class="doc-card${active}" data-doc="${escAttr(c.name)}">
            <div class="dc-name">${escText(c.title)}</div>
            <div class="dc-source">${escText(c.source)}</div>
            ${scoreLine}
            <div class="dc-tags">${cited}</div>
          </div>
        `;
      })
      .join("");
  }

  function renderActiveDoc() {
    if (!state.index) return;
    const doc = state.index.docs.find((d) => d.name === state.activeDoc);
    if (!doc) {
      activeName.textContent = "— select a doc —";
      docBody.innerHTML = "";
      hitCount.textContent = "0 hits";
      return;
    }
    activeName.textContent = doc.title;

    // Compute highlight terms from current query (or matched terms of the
    // top hit for this doc, whichever is more specific).
    let highlightTerms: string[] = [];
    const topHit = state.results.find((r) => r.name === doc.name);
    if (topHit) highlightTerms = topHit.matchedTerms;
    else if (state.query.trim()) {
      // Fallback — surface all query tokens.
      highlightTerms = state.query
        .toLowerCase()
        .split(/[^\p{L}\p{N}]+/u)
        .filter((t) => t.length > 1);
    }

    // Hit count = number of <mark>'d spans we're about to render.
    const html = renderMarkdown(doc.body, { highlightTerms });
    const hits = (html.match(/<mark>/g) || []).length;
    hitCount.textContent = `${hits} hit${hits === 1 ? "" : "s"}`;
    docBody.innerHTML = `<div class="rdv-page rdv-md">${html}<span class="rdv-page-num">${escText(doc.source)}</span></div>`;
  }

  function renderFindings() {
    if (!state.index) return;
    if (state.results.length === 0 && state.tracker.list().length === 0) {
      findings.innerHTML = `
        <div class="finding finding-empty">
          <div class="f-q">No query yet.</div>
          <div class="f-a">Type a query above to surface ranked snippets, then "Cite" to capture findings.</div>
        </div>`;
      return;
    }

    const resultBlocks = state.results.slice(0, 6).map((r, idx) => {
      const matchedTags = r.matchedTerms
        .slice(0, 6)
        .map((t) => `<span class="dc-tag">${escText(t)}</span>`)
        .join("");
      return `
        <div class="finding" data-result-idx="${idx}">
          <div class="f-q">${escText(r.title)}  <span class="f-meta">· ${r.score.toFixed(3)}</span></div>
          <div class="f-a">${escText(r.snippet)}</div>
          <div class="f-meta">${escText(r.source)} · line ${r.line} ${matchedTags}</div>
          <div class="f-actions">
            <button class="f-cite-btn" data-result-idx="${idx}" type="button">Cite</button>
            <button class="f-open-btn" data-doc="${escAttr(r.name)}" type="button">Open</button>
          </div>
        </div>
      `;
    }).join("");

    const citeList = state.tracker.list();
    const citeBlocks = citeList.length > 0
      ? `<div class="cite-divider">CITED THIS SESSION (${citeList.length})</div>` +
        citeList.map((c, i) => `
          <div class="finding finding-cited">
            <div class="f-q">${escText(c.source)} · line ${c.line}</div>
            <div class="f-a">${escText(c.claim)}</div>
            <div class="f-actions">
              <button class="f-uncite-btn" data-cite-idx="${i}" type="button">Remove</button>
            </div>
          </div>
        `).join("")
      : "";

    findings.innerHTML = resultBlocks + citeBlocks;
  }

  function renderCitePill() {
    citePill.textContent = `${state.tracker.list().length} cited`;
  }

  // ---- Query handler ----
  function runQuery() {
    if (!state.index) return;
    const q = queryInput.value;
    state.query = q;
    if (!q.trim()) {
      state.results = [];
    } else {
      state.results = queryResearch(state.index, q, {
        source: activeFilter(),
        restrictTo: restrictSet(),
        limit: 10,
      });
      // Auto-jump active doc to top result.
      if (state.results.length > 0) state.activeDoc = state.results[0].name;
    }
    renderAll();
  }

  let queryTimer: number | undefined;
  queryInput.addEventListener("input", () => {
    if (queryTimer) window.clearTimeout(queryTimer);
    queryTimer = window.setTimeout(runQuery, 120) as unknown as number;
  });

  // ---- Corpus card click ----
  corpusList.addEventListener("click", (e) => {
    const card = (e.target as HTMLElement).closest<HTMLElement>(".doc-card");
    if (!card) return;
    const name = card.dataset.doc;
    if (!name) return;
    state.activeDoc = name;
    renderAll();
  });

  // ---- Filter pill toggle ----
  el.querySelectorAll<HTMLElement>(".rp-toggle").forEach((t) => {
    t.addEventListener("click", () => {
      const which = t.dataset.filter;
      if (which === "local") state.filterLocal = !state.filterLocal;
      else if (which === "web") state.filterWeb = !state.filterWeb;
      else if (which === "cite") state.filterCite = !state.filterCite;
      t.classList.toggle("active");
      runQuery();
    });
  });

  // ---- Findings buttons (Cite / Open / Remove) ----
  findings.addEventListener("click", (e) => {
    const target = e.target as HTMLElement;

    const citeBtn = target.closest<HTMLElement>(".f-cite-btn");
    if (citeBtn) {
      const idx = Number(citeBtn.dataset.resultIdx);
      const r = state.results[idx];
      if (r) {
        state.tracker.cite({ source: r.name, line: r.line, claim: r.snippet });
        renderAll();
      }
      return;
    }

    const openBtn = target.closest<HTMLElement>(".f-open-btn");
    if (openBtn) {
      const name = openBtn.dataset.doc;
      if (name) {
        state.activeDoc = name;
        renderAll();
      }
      return;
    }

    const uncite = target.closest<HTMLElement>(".f-uncite-btn");
    if (uncite) {
      const idx = Number(uncite.dataset.citeIdx);
      state.tracker.remove(idx);
      renderAll();
      return;
    }
  });

  // ---- Export citations as JSON ----
  exportBtn.addEventListener("click", () => {
    const blob = new Blob([state.tracker.exportJSON()], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "citations.json";
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });

  return el;
}

// Tiny escape helpers — used in templated innerHTML construction. Keep
// untrusted text out of attribute values + element text.
function escText(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
function escAttr(s: string): string {
  return escText(s).replace(/"/g, "&quot;");
}

let paperEl: HTMLElement | null = null;
let researchEl: HTMLElement | null = null;

export function getLayoutHost(): HTMLElement | null { return paperEl; }

export function buildModes(workbench: HTMLElement, boundsProvider?: () => SceneBounds | null) {
  paperEl = buildPaperMode(boundsProvider);
  researchEl = buildResearchMode();
  workbench.appendChild(paperEl);
  workbench.appendChild(researchEl);
}

export function activateMode(key: string, workbench: HTMLElement | null) {
  if (!workbench) return;
  workbench.dataset.mode = key;
  const showPaper = key === "layout";
  const showResearch = key === "research";
  if (paperEl) {
    paperEl.style.display = showPaper ? "" : "none";
    if (showPaper) getController(paperEl)?.resumeThumbLoop();
    else           getController(paperEl)?.pauseThumbLoop();
  }
  if (researchEl) researchEl.style.display = showResearch ? "" : "none";
  // Reset accumulated body scroll so the ribbon/modebar are never off-screen.
  // Chrome keeps document.body.scrollTop independent from window.scrollY when
  // html has overflow:hidden — must reset both.
  window.scrollTo(0, 0);
  document.body.scrollTop = 0;
  document.documentElement.scrollTop = 0;
}
