// Scene-understanding panel.
//
// Shows the loaded scene's mesh tree with per-mesh visibility toggles and
// click-to-zoom. Walked once per load; re-renders on interaction only — no
// per-frame redraw. Intentionally agnostic to source format: whatever
// LoadedScene the loader hands back, we walk it as a THREE.Object3D graph.
//
// Visual: bundle's outliner aesthetic (#174). Sections grouped by IFC class
// (ARCHITECTURE / STRUCTURE / OPENINGS / CIRCULATION / MESHES) inferred
// from mesh names. Falls back to a single MESHES section when no class can
// be inferred.

import * as THREE from "three";
import type { Viewer } from "./viewer/viewer";
import { iconSVG } from "./icons";
import {
  getFilters,
  setFilter,
  type SelectionFilters,
} from "./viewer/selection-state";
import type { IfcHierarchyElement } from "./ifc-types";
import { subscribe } from "./app-state";
import { dispatchSync } from "./commands/dispatch.js";

type IfcClass = "ARCHITECTURE" | "STRUCTURE" | "OPENINGS" | "CIRCULATION" | "MESHES";
function classifyByName(name: string): IfcClass {
  const n = name.toLowerCase();
  if (/(wall|slab|floor|roof|covering|space)/.test(n)) return "ARCHITECTURE";
  if (/(column|beam|footing|pile|member|brace|truss)/.test(n)) return "STRUCTURE";
  if (/(door|window|opening|reveal)/.test(n)) return "OPENINGS";
  if (/(stair|ramp|railing|hand)/.test(n)) return "CIRCULATION";
  return "MESHES";
}

export type SceneSummary = {
  format: string;
  triangles: number;
  filename?: string;
  schema?: string;       // IFC schema id, e.g. "IFC4"
  entityCount?: number;  // IFC entity count from the loader summary
  hierarchy?: IfcHierarchyElement[];
};

type MeshNode = {
  id: string;
  name: string;
  mesh: THREE.Mesh;
  triangles: number;
  color: string;
  depth: number;
};

export class ScenePanel {
  private root: HTMLElement;
  private viewer: Viewer;
  private nodes: MeshNode[] = [];
  private collapsed = false;
  private lastSummary: SceneSummary | null = null;

  constructor(root: HTMLElement, viewer: Viewer) {
    this.root = root;
    this.viewer = viewer;
    this.renderEmpty();
    // Re-render on theme change so swatch chips and inline styles stay in sync.
    subscribe("night", () => {
      if (this.lastSummary) this.render(this.lastSummary);
    });
  }

  clear(): void {
    this.nodes = [];
    this.lastSummary = null;
    this.renderEmpty();
  }

  update(summary: SceneSummary): void {
    const obj = this.viewer.getActiveObject();
    if (!obj) {
      this.clear();
      return;
    }
    this.lastSummary = summary;
    this.nodes = this.walkNodes(obj);
    this.render(summary);
  }

  toggleCollapse(): void {
    this.collapsed = !this.collapsed;
    this.root.classList.toggle("collapsed", this.collapsed);
  }

  private walkNodes(root: THREE.Object3D): MeshNode[] {
    const out: MeshNode[] = [];
    let i = 0;
    root.traverse((child) => {
      const m = child as THREE.Mesh;
      if (!m.isMesh) return;
      const g = m.geometry as THREE.BufferGeometry | undefined;
      let tris = 0;
      if (g) {
        if (g.index) tris = Math.round(g.index.count / 3);
        else if (g.attributes.position) tris = Math.round(g.attributes.position.count / 3);
      }
      let color = "#7ad3a3";
      const mat = Array.isArray(m.material) ? m.material[0] : m.material;
      const matCol = mat && (mat as THREE.MeshStandardMaterial).color;
      if (matCol) color = "#" + matCol.getHexString();
      i++;
      out.push({
        id: `m-${i}`,
        name: m.name || `Mesh ${i}`,
        mesh: m,
        triangles: tris,
        color,
        depth: this.depthOf(m, root),
      });
    });
    return out;
  }

  private depthOf(node: THREE.Object3D, root: THREE.Object3D): number {
    let d = 0;
    let cur: THREE.Object3D | null = node;
    while (cur && cur !== root) {
      d++;
      cur = cur.parent;
    }
    return Math.min(d, 4); // clamp visual indent so deep IFC graphs don't blow out
  }

  private renderEmpty(): void {
    this.root.innerHTML = `
      <div class="sp-meta-row" style="padding:6px 10px; font-family:var(--mono); font-size:10px; color:var(--ink-faint); border-bottom:1px solid var(--hairline-soft);">
        no scene loaded — drop a file or pick a sample
      </div>
    `;
  }

  private render(summary: SceneSummary): void {
    const totalTris = this.nodes.reduce((s, n) => s + n.triangles, 0);
    const fmtStr = summary.format.toUpperCase();
    const filenameStr = summary.filename ? ` &middot; ${escapeHtml(summary.filename)}` : "";
    const entityStr = summary.entityCount != null
      ? ` &middot; ${summary.entityCount.toLocaleString()} entit${summary.entityCount === 1 ? "y" : "ies"}`
      : "";
    const schemaStr = summary.schema ? ` &middot; ${escapeHtml(summary.schema)}` : "";

    let outlinerHtml = `<div class="outliner">`;

    if (summary.hierarchy && summary.hierarchy.length > 0) {
      // Storey-organized IFC tree.
      const storeyMap = new Map<string, { elevation: number; classes: Map<string, IfcHierarchyElement[]> }>();
      for (const el of summary.hierarchy) {
        const key = el.storeyName;
        if (!storeyMap.has(key)) storeyMap.set(key, { elevation: el.storeyElevation, classes: new Map() });
        const storey = storeyMap.get(key)!;
        if (!storey.classes.has(el.ifcClass)) storey.classes.set(el.ifcClass, []);
        storey.classes.get(el.ifcClass)!.push(el);
      }
      // Sort storeys by elevation; "Unassigned" last.
      const storeyKeys = [...storeyMap.keys()].sort((a, b) => {
        if (a === "Unassigned") return 1;
        if (b === "Unassigned") return -1;
        return storeyMap.get(a)!.elevation - storeyMap.get(b)!.elevation;
      });
      for (const storeyKey of storeyKeys) {
        const storey = storeyMap.get(storeyKey)!;
        const elevStr = storeyKey !== "Unassigned" ? ` (${storey.elevation.toFixed(2)}m)` : "";
        const storeyTotal = [...storey.classes.values()].reduce((s, arr) => s + arr.length, 0);
        const sectionId = `storey-${storeyKey}`;
        outlinerHtml += `
          <div class="outliner-section" data-section="${escapeAttr(sectionId)}">
            <div class="outliner-section-header">
              ${iconSVG("chevron-down", 9)}
              ${escapeHtml(storeyKey)}${escapeHtml(elevStr)}
              <span class="count">${storeyTotal}</span>
            </div>`;
        const classKeys = [...storey.classes.keys()].sort();
        for (const cls of classKeys) {
          const elems = storey.classes.get(cls)!;
          const classSectionId = `class-${cls}`;
          outlinerHtml += `
            <div class="outliner-section" data-section="${escapeAttr(classSectionId)}" style="margin-left:10px;">
              <div class="outliner-section-header">
                ${iconSVG("chevron-down", 9)}
                ${escapeHtml(cls)}
                <span class="count">${elems.length}</span>
              </div>`;
          for (const el of elems) {
            const label = el.name && el.name !== `#${el.expressID}` ? el.name : `#${el.expressID}`;
            outlinerHtml += `
              <div class="outliner-row" data-express-id="${el.expressID}" style="--depth:2">
                <span class="name" data-action="ifc-select" data-express-id="${el.expressID}" title="${escapeAttr(el.guid)}" style="cursor:pointer;">${escapeHtml(label)}</span>
              </div>`;
          }
          outlinerHtml += `</div>`;
        }
        outlinerHtml += `</div>`;
      }
    } else {
      // Flat mesh-based tree grouped by inferred IFC class.
      const groups = new Map<IfcClass, MeshNode[]>();
      const ORDER: IfcClass[] = ["ARCHITECTURE", "STRUCTURE", "OPENINGS", "CIRCULATION", "MESHES"];
      for (const n of this.nodes) {
        const cls = classifyByName(n.name);
        if (!groups.has(cls)) groups.set(cls, []);
        groups.get(cls)!.push(n);
      }
      if (this.nodes.length === 0) {
        outlinerHtml += `<div style="padding:14px; color:var(--ink-faint); font-size:10px;">No meshes in this scene.</div>`;
      } else {
        for (const cls of ORDER) {
          const items = groups.get(cls);
          if (!items || items.length === 0) continue;
          outlinerHtml += `
            <div class="outliner-section" data-section="${cls}">
              <div class="outliner-section-header">
                ${iconSVG("chevron-down", 9)}
                ${cls}
                <span class="count">${items.length}</span>
              </div>`;
          for (const n of items) {
            const tris = n.triangles.toLocaleString();
            outlinerHtml += `
              <div class="outliner-row" data-id="${n.id}" style="--depth:${Math.min(n.depth, 2)}">
                <span class="twirl"></span>
                <span class="name" data-action="zoom" data-id="${n.id}" title="Click to zoom · ${tris} tri">${escapeHtml(n.name)}</span>
                <span class="swatch" style="background:${n.color}; border-color:${n.color};" aria-hidden="true"></span>
                <button class="vis-btn" data-action="toggle" data-id="${n.id}" title="Toggle visibility" type="button" aria-label="Toggle visibility for ${escapeHtml(n.name)}">${iconSVG("eye", 11)}</button>
              </div>`;
          }
          outlinerHtml += `</div>`;
        }
      }
    }
    outlinerHtml += `</div>`;

    const metaRow = `<div class="sp-meta-row" style="padding:6px 10px; font-family:var(--mono); font-size:10px; color:var(--ink-faint); border-bottom:1px solid var(--hairline-soft);">${fmtStr}${filenameStr}${entityStr}${schemaStr} &middot; ${this.nodes.length} mesh${this.nodes.length === 1 ? "" : "es"} &middot; ${totalTris.toLocaleString()} tri</div>`;
    this.root.innerHTML = metaRow + outlinerHtml;
    this.wireRowActions();
    if (summary.hierarchy && summary.hierarchy.length > 0) this.autoSelectFirstIfc();
  }

  private wireRowActions(): void {
    // Collapsible section headers.
    this.root.querySelectorAll<HTMLElement>(".outliner-section-header").forEach((header) => {
      header.style.cursor = "pointer";
      header.addEventListener("click", () => {
        const section = header.parentElement as HTMLElement;
        const collapsed = section.dataset.collapsed === "1";
        if (collapsed) {
          section.dataset.collapsed = "";
          section.querySelectorAll<HTMLElement>(".outliner-row").forEach((r) => (r.style.display = ""));
          const svg = header.querySelector<SVGElement>("svg");
          if (svg) svg.style.transform = "";
        } else {
          section.dataset.collapsed = "1";
          section.querySelectorAll<HTMLElement>(".outliner-row").forEach((r) => (r.style.display = "none"));
          const svg = header.querySelector<SVGElement>("svg");
          if (svg) svg.style.transform = "rotate(-90deg)";
        }
      });
    });
    this.root.querySelectorAll<HTMLElement>("[data-action]").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const id = el.dataset.id;
        const action = el.dataset.action;
        const node = this.nodes.find((n) => n.id === id);
        if (!node) return;
        if (action === "toggle") {
          node.mesh.visible = !node.mesh.visible;
          const btn = e.currentTarget as HTMLElement;
          btn.classList.toggle("off", !node.mesh.visible);
          btn.style.opacity = node.mesh.visible ? "" : "0.3";
          // Dim the row label when hidden.
          const row = btn.closest<HTMLElement>(".outliner-row");
          if (row) {
            row.classList.toggle("hidden-mesh", !node.mesh.visible);
            row.style.opacity = node.mesh.visible ? "" : "0.5";
          }
        } else if (action === "zoom") {
          // Highlight the selected row.
          this.root.querySelectorAll(".outliner-row.selected").forEach((r) => r.classList.remove("selected"));
          const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(".outliner-row");
          row?.classList.add("selected");
          this.viewer.frameObjectOnly(node.mesh);
        }
      });
    });

    // IFC hierarchy rows — click selects the corresponding mesh in the viewer.
    this.root.querySelectorAll<HTMLElement>("[data-action='ifc-select']").forEach((el) => {
      el.addEventListener("click", (e) => {
        e.stopPropagation();
        const expressId = parseInt((el as HTMLElement).dataset.expressId ?? "0", 10);
        const node = this.nodes.find((n) => n.mesh.userData.expressID === expressId);
        this.root.querySelectorAll(".outliner-row.selected").forEach((r) => r.classList.remove("selected"));
        const row = (e.currentTarget as HTMLElement).closest<HTMLElement>(".outliner-row");
        row?.classList.add("selected");
        if (node) this.viewer.frameObjectOnly(node.mesh);
      });
    });

    // Right-click: context menu with Isolate / Isolate Off.
    this.root.querySelectorAll<HTMLElement>(".outliner-row").forEach((row) => {
      row.addEventListener("contextmenu", (e) => {
        e.preventDefault();
        const id = row.dataset.id;
        const node = this.nodes.find((n) => n.id === id);
        if (!node) return;

        document.getElementById("scene-ctx-menu")?.remove();
        const menu = document.createElement("div");
        menu.id = "scene-ctx-menu";
        menu.style.cssText =
          "position:fixed; z-index:9999; background:var(--paper-1,#fff);" +
          " border:1px solid var(--chrome-seam,#ccc); border-radius:4px;" +
          " padding:4px 0; min-width:140px; box-shadow:0 4px 12px rgba(0,0,0,0.15);";
        menu.style.left = `${e.clientX}px`;
        menu.style.top  = `${e.clientY}px`;

        const makeItem = (label: string, action: () => void): HTMLElement => {
          const item = document.createElement("div");
          item.textContent = label;
          item.style.cssText =
            "padding:5px 14px; cursor:pointer; font-size:11px;" +
            " color:var(--ink); white-space:nowrap;";
          item.addEventListener("mouseenter", () => { item.style.background = "var(--paper-2,#f0f0f0)"; });
          item.addEventListener("mouseleave", () => { item.style.background = ""; });
          item.addEventListener("click", () => { menu.remove(); action(); });
          return item;
        };

        const isAlreadyIsolated = this.viewer.getIsolatedUuid() === node.mesh.uuid;
        menu.appendChild(makeItem(isAlreadyIsolated ? "Isolate Off" : "Isolate", () => {
          if (isAlreadyIsolated) {
            dispatchSync("SdIsolateOff", {});
          } else {
            dispatchSync("SdIsolate", { uuid: node.mesh.uuid });
          }
        }));
        if (!isAlreadyIsolated && this.viewer.getIsolatedUuid() !== null) {
          menu.appendChild(makeItem("Isolate Off", () => { dispatchSync("SdIsolateOff", {}); }));
        }
        menu.appendChild(makeItem("Zoom To", () => { this.viewer.frameObjectOnly(node.mesh); }));

        document.body.appendChild(menu);
        const dismiss = () => { menu.remove(); document.removeEventListener("pointerdown", dismiss, true); };
        setTimeout(() => document.addEventListener("pointerdown", dismiss, true), 0);
      });
    });
  }

  private autoSelectFirstIfc(): void {
    const firstRow = this.root.querySelector<HTMLElement>(".outliner-row[data-express-id]");
    if (!firstRow) return;
    firstRow.classList.add("selected");
    firstRow.scrollIntoView({ block: "nearest" });
    const expressId = parseInt(firstRow.dataset.expressId ?? "0", 10);
    const node = this.nodes.find((n) => n.mesh.userData.expressID === expressId);
    if (node) this.viewer.selectObject(node.mesh);
  }
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeAttr(s: string): string {
  return s.replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}

// Selection-filter checkbox bank (Rhino-style). Eight entries; defaults match
// selection-state.ts. Returned as a live DOM element so it can be mounted
// permanently in the sidebar, independent of which tab is active.
const SELECTION_FILTER_KEYS: Array<{ key: keyof SelectionFilters; label: string }> = [
  { key: "Points",        label: "Points" },
  { key: "Curves",        label: "Curves" },
  { key: "Surfaces",      label: "Surfaces" },
  { key: "Polysurfaces",  label: "Polysurfaces" },
  { key: "Meshes",        label: "Meshes" },
  { key: "Annotations",   label: "Annotations" },
  { key: "Lights",        label: "Lights" },
  { key: "Blocks",        label: "Blocks" },
];

export function buildSelectionFiltersPanel(): HTMLElement {
  const filters = getFilters();
  const rows = SELECTION_FILTER_KEYS.map(({ key, label }) => {
    const checked = filters[key] ? "checked" : "";
    return `<label class="sf-row" style="display:flex; align-items:center; gap:6px; padding:2px 0; font-size:11px; cursor:pointer;">
      <input type="checkbox" data-filter="${key}" ${checked} style="margin:0;"/>
      <span style="color:var(--ink-soft);">${label}</span>
    </label>`;
  }).join("");

  const container = document.createElement("div");
  container.className = "selection-filters";
  container.style.cssText = "padding:6px 10px; border-top:1px solid var(--hairline-soft);";
  container.innerHTML = `
    <div style="font-family:var(--mono); font-size:10px; color:var(--ink-faint); letter-spacing:0.08em; padding-bottom:4px;">SELECTION FILTERS</div>
    <div style="display:grid; grid-template-columns:repeat(2, minmax(0, 1fr)); gap:0 12px;">
      ${rows}
    </div>
    <div style="font-family:var(--mono); font-size:9.5px; color:var(--ink-faint); padding-top:4px;">Ctrl+Shift+click to drill into sub-objects</div>
  `;

  // Wire checkboxes — setFilter drives subscribeFilters in main.ts which
  // handles vertex-helper visibility for the Points key.
  container.querySelectorAll<HTMLInputElement>("input[data-filter]").forEach((input) => {
    const key = input.dataset.filter as keyof SelectionFilters;
    input.addEventListener("change", () => setFilter(key, input.checked));
  });

  return container;
}
