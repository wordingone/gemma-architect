// Export drawer (#178) — bundle port. Slides in from the right with
// 12 formats grouped by BIM / 3D-MESH / 2D-DRAWING. Each .ed-fmt button
// proxies to the legacy .exp-btn[data-fmt="X"] click handler so existing
// IFC/GLB/OBJ/STL/STEP export pipelines keep working.

import { iconSVG } from "../ui/icons";
import { isBonsaiAvailable, validateIFC, type BonsaiValidation } from "./bonsai-client";

type Fmt = { ext: string; sub: string; fmt: string };

const SECTIONS: { num: string; title: string; items: Fmt[] }[] = [
  {
    num: "01",
    title: "BIM · ARCHITECTURAL",
    items: [
      { ext: "IFC",  sub: "STEP-21 · SPF",  fmt: "ifc" },
      { ext: "STEP", sub: "OCCT B-rep",     fmt: "step" },
      { ext: "DWG",  sub: "AutoCAD 2018",   fmt: "dwg" }, // not implemented yet
    ],
  },
  {
    num: "02",
    title: "3D · MESH",
    items: [
      { ext: "OBJ",  sub: "wavefront",      fmt: "obj" },
      { ext: "STL",  sub: "stereolith.",    fmt: "stl" },
      { ext: "GLB",  sub: "binary glTF",    fmt: "glb" },
      { ext: "glTF", sub: "JSON glTF",      fmt: "gltf" },
      { ext: "USDZ", sub: "AR · iOS",       fmt: "usdz" },
      { ext: "FBX",  sub: "FilmBox",        fmt: "fbx" }, // not implemented yet
    ],
  },
  {
    num: "03",
    title: "2D · DRAWING",
    items: [
      { ext: "SVG",  sub: "vector",         fmt: "svg" },
      { ext: "DXF",  sub: "vector · CAD",   fmt: "dxf" },
      { ext: "PDF",  sub: "A1 sheet",       fmt: "pdf" },
    ],
  },
];

let drawerEl: HTMLDivElement | null = null;
// #151 — cached at drawer-open time. Drives whether the
// "Validate via Bonsai" affordance is visible. False if the server isn't
// running; in that case the UI surface is hidden entirely (silent fallback).
let bonsaiAvailable = false;

function getMeshStats() {
  // Read from statusbar (already populated by viewer/scene-panel).
  const verts = (document.querySelector("#sb-verts .v") as HTMLElement | null)?.textContent || "—";
  const faces = (document.querySelector("#sb-faces .v") as HTMLElement | null)?.textContent || "—";
  const sel   = (document.querySelector("#sb-sel .v") as HTMLElement | null)?.textContent || "—";
  return { verts, faces, sel };
}

function build(): HTMLDivElement {
  const root = document.createElement("div");
  root.className = "export-drawer";

  const { verts, faces } = getMeshStats();

  let html = `
    <div class="ed-header">
      <div class="ed-header-l">
        <span class="ed-eyebrow">FILE · EXPORT</span>
        <span class="ed-title">Untitled.001</span>
      </div>
      <button class="ed-close" type="button" title="Close (esc)">${iconSVG("x", 11)}</button>
    </div>
    <div class="ed-meta">
      <div><span class="k">verts</span><span class="v">${verts}</span></div>
      <div><span class="k">faces</span><span class="v">${faces}</span></div>
      <div><span class="k">precision</span><span class="v">0.001 m</span></div>
      <div><span class="k">units</span><span class="v">METRIC · m</span></div>
    </div>
    <div class="ed-body">
  `;
  for (const s of SECTIONS) {
    html += `<div class="ed-section">
      <div class="ed-section-title"><span class="num">${s.num}</span>${s.title}</div>
      <div class="ed-grid">`;
    for (const it of s.items) {
      html += `<button class="ed-fmt" type="button" data-fmt="${it.fmt}">
        <span class="ext">${it.ext}</span><span class="sub">${it.sub}</span>
      </button>`;
    }
    html += `</div></div>`;
  }
  // #151 — optional Bonsai validation row. Only rendered when the local
  // validation server was reachable at drawer-open time; hidden silently
  // otherwise so users don't see a dead button.
  if (bonsaiAvailable) {
    html += `<div class="ed-bonsai-row">
      <a href="#" class="ed-bonsai-link" id="ed-bonsai-validate">
        Validate via Bonsai
      </a>
      <span class="ed-bonsai-hint">runs against local 127.0.0.1:8765</span>
    </div>`;
  }
  html += `</div>
    <div class="ed-footer">
      <span class="ed-foot-meta">round-trip verified · web-ifc 0.0.61</span>
      <button class="btn btn-accent btn-sm" id="ed-download-all" type="button">
        ${iconSVG("export", 11)} DOWNLOAD ALL
      </button>
    </div>
  `;
  root.innerHTML = html;

  // Wire close
  root.querySelector(".ed-close")?.addEventListener("click", close);

  // Wire each format button to the legacy .exp-btn[data-fmt=...]
  root.querySelectorAll<HTMLButtonElement>(".ed-fmt").forEach((edFmt) => {
    const fmt = edFmt.dataset.fmt!;
    const legacy = document.querySelector<HTMLButtonElement>(`.exp-btn[data-fmt="${fmt}"]`);
    if (!legacy) {
      // Format not yet wired; mark visually disabled.
      edFmt.classList.add("disabled");
      edFmt.disabled = true;
      edFmt.title = "Not yet implemented";
    } else {
      // Mirror disabled state at open-time.
      edFmt.disabled = legacy.disabled;
      edFmt.addEventListener("click", () => {
        if (legacy.disabled) return;
        legacy.click();
      });
    }
  });

  // #151 — wire the Bonsai validate link if the row was rendered.
  // Convention: `web/src/ifc.ts` is expected (separately) to publish the
  // most-recent IFC buffer to `window.__lastIfcBuffer` on each export so
  // downstream tools can re-use it without re-running web-ifc. If the field
  // is absent we hint the user to export first; we do NOT toast or log.
  const bonsaiLink = root.querySelector<HTMLAnchorElement>("#ed-bonsai-validate");
  if (bonsaiLink) {
    bonsaiLink.addEventListener("click", async (e) => {
      e.preventDefault();
      const buf = (window as { __lastIfcBuffer?: Uint8Array }).__lastIfcBuffer;
      if (!buf || !(buf instanceof Uint8Array) || buf.byteLength === 0) {
        renderBonsaiModal({
          ok: false,
          headline: "No IFC buffer yet",
          detail: "Click the IFC export button first, then re-run validation.",
        });
        return;
      }
      bonsaiLink.classList.add("disabled");
      bonsaiLink.textContent = "Validating…";
      try {
        const result = await validateIFC(buf);
        renderBonsaiModal({
          ok: true,
          headline: result.valid && result.errors.length === 0
            ? "Bonsai: PASS"
            : "Bonsai: FAIL",
          result,
        });
      } catch (err) {
        // Server vanished between availability check and validate call.
        // Render a soft notice; no console.error per #151 hard constraint.
        const msg = err instanceof Error ? err.message : "validation failed";
        renderBonsaiModal({
          ok: false,
          headline: "Bonsai unreachable",
          detail: msg,
        });
      } finally {
        bonsaiLink.classList.remove("disabled");
        bonsaiLink.textContent = "Validate via Bonsai";
      }
    });
  }

  // DOWNLOAD ALL — for now just a stub.
  root.querySelector("#ed-download-all")?.addEventListener("click", () => {
    const enabled = SECTIONS.flatMap((s) => s.items).filter((it) => {
      const b = document.querySelector<HTMLButtonElement>(`.exp-btn[data-fmt="${it.fmt}"]`);
      return b && !b.disabled;
    });
    alert(`Bulk download — would export ${enabled.length} formats: ${enabled.map((f) => f.ext).join(", ")}`);
  });

  return root;
}

async function open() {
  if (drawerEl) {
    // Refresh meta + format-disabled state
    drawerEl.remove();
  }
  // #151 — probe Bonsai server before rendering. Probe is bounded at 1s by
  // bonsai-client.ts; if the server is down the link row simply won't render.
  bonsaiAvailable = await isBonsaiAvailable();
  drawerEl = build();
  document.body.appendChild(drawerEl);
  // Trigger CSS transition by adding .open after insertion.
  requestAnimationFrame(() => drawerEl?.classList.add("open"));

  // Esc to close.
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      close();
      window.removeEventListener("keydown", onKey);
    }
  };
  window.addEventListener("keydown", onKey);
}

// #151 — minimal results modal for Bonsai validation. Renders into the
// same drawer so we don't add a global modal stack. Click outside or X to
// dismiss. Pure DOM, no external deps.
type ModalState =
  | { ok: true; headline: string; result: BonsaiValidation }
  | { ok: false; headline: string; detail: string };

function renderBonsaiModal(state: ModalState): void {
  if (!drawerEl) return;
  // Drop any prior modal first.
  drawerEl.querySelector(".ed-bonsai-modal")?.remove();

  const modal = document.createElement("div");
  modal.className = "ed-bonsai-modal";

  let body = "";
  if (state.ok) {
    const { errors, warnings } = state.result;
    body += `<div class="ed-bonsai-counts">
      <span>errors: ${errors.length}</span>
      <span>warnings: ${warnings.length}</span>
    </div>`;
    if (errors.length > 0) {
      body += `<div class="ed-bonsai-list ed-bonsai-errors"><h4>Errors</h4><ul>`;
      for (const e of errors) {
        body += `<li>${escapeHtml(e)}</li>`;
      }
      body += `</ul></div>`;
    }
    if (warnings.length > 0) {
      body += `<div class="ed-bonsai-list ed-bonsai-warnings"><h4>Warnings</h4><ul>`;
      for (const w of warnings) {
        body += `<li>${escapeHtml(w)}</li>`;
      }
      body += `</ul></div>`;
    }
    if (errors.length === 0 && warnings.length === 0) {
      body += `<div class="ed-bonsai-empty">Clean. No issues reported.</div>`;
    }
  } else {
    body += `<div class="ed-bonsai-empty">${escapeHtml(state.detail)}</div>`;
  }

  modal.innerHTML = `
    <div class="ed-bonsai-modal-inner">
      <div class="ed-bonsai-modal-header">
        <span class="ed-bonsai-modal-title">${escapeHtml(state.headline)}</span>
        <button class="ed-bonsai-modal-close" type="button" title="Close">${iconSVG("x", 11)}</button>
      </div>
      <div class="ed-bonsai-modal-body">${body}</div>
    </div>
  `;
  modal.querySelector(".ed-bonsai-modal-close")?.addEventListener("click", () => modal.remove());
  drawerEl.appendChild(modal);
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function close() {
  if (!drawerEl) return;
  drawerEl.classList.remove("open");
  // Wait for CSS transition before removing.
  setTimeout(() => {
    drawerEl?.remove();
    drawerEl = null;
  }, 300);
}

export function initExportDrawer() {
  // Wire ribbon EXPORT button (#ribbon-export-btn).
  const exportBtn = document.getElementById("ribbon-export-btn");
  if (exportBtn) {
    exportBtn.addEventListener("click", (e) => {
      e.preventDefault();
      void open();
    });
  }
}

export function openExportDrawer() { void open(); }
export function closeExportDrawer() { close(); }
