// cad-blocks-panel.ts — Layout-tab CAD blocks library panel (#1853).
//
// Displays sourced 2D blocks organized by category. Lazy-loads block SVGs on
// first library open. Clicking a block activates the block-insert draft tool
// and stores the selected blockId for the next sheet click.

import { iconSVG } from "../ui/icons";
import { setActiveDraftTool } from "./draft-elements";

// --- Block catalog ----------------------------------------------------------

export type BlockView = "plan" | "elevation" | "section";

export type BlockEntry = {
  id: string;          // "doors/plan/single-swing"
  category: string;   // "Doors"
  subcategory: string; // "Plan"
  label: string;       // "Single Swing"
  path: string;        // relative to /cad-blocks/, e.g. "doors/plan/single-swing.svg"
  view: BlockView;
};

const BLOCK_CATALOG: BlockEntry[] = [
  // Doors — plan
  { id: "doors/plan/single-swing",  category: "Doors",     subcategory: "Plan",      label: "Single Swing",  path: "doors/plan/single-swing.svg",  view: "plan" },
  { id: "doors/plan/double-swing",  category: "Doors",     subcategory: "Plan",      label: "Double Swing",  path: "doors/plan/double-swing.svg",  view: "plan" },
  { id: "doors/plan/sliding",       category: "Doors",     subcategory: "Plan",      label: "Sliding",       path: "doors/plan/sliding.svg",       view: "plan" },
  { id: "doors/plan/pocket",        category: "Doors",     subcategory: "Plan",      label: "Pocket",        path: "doors/plan/pocket.svg",        view: "plan" },
  { id: "doors/plan/bi-fold",       category: "Doors",     subcategory: "Plan",      label: "Bi-Fold",       path: "doors/plan/bi-fold.svg",       view: "plan" },
  // Doors — elevation
  { id: "doors/elevation/single-swing",  category: "Doors", subcategory: "Elevation", label: "Single Swing", path: "doors/elevation/single-swing.svg",  view: "elevation" },
  { id: "doors/elevation/double-swing",  category: "Doors", subcategory: "Elevation", label: "Double Swing", path: "doors/elevation/double-swing.svg",  view: "elevation" },
  { id: "doors/elevation/sliding",       category: "Doors", subcategory: "Elevation", label: "Sliding",      path: "doors/elevation/sliding.svg",       view: "elevation" },
  { id: "doors/elevation/pocket",        category: "Doors", subcategory: "Elevation", label: "Pocket",       path: "doors/elevation/pocket.svg",        view: "elevation" },
  { id: "doors/elevation/bi-fold",       category: "Doors", subcategory: "Elevation", label: "Bi-Fold",      path: "doors/elevation/bi-fold.svg",       view: "elevation" },
  // Doors — section
  { id: "doors/section/single-swing",    category: "Doors", subcategory: "Section",   label: "Single Swing", path: "doors/section/single-swing.svg",    view: "section" },
  { id: "doors/section/double-swing",    category: "Doors", subcategory: "Section",   label: "Double Swing", path: "doors/section/double-swing.svg",    view: "section" },
  // Windows — plan
  { id: "windows/plan/fixed",       category: "Windows",   subcategory: "Plan",      label: "Fixed",         path: "windows/plan/fixed.svg",       view: "plan" },
  { id: "windows/plan/casement",    category: "Windows",   subcategory: "Plan",      label: "Casement",      path: "windows/plan/casement.svg",    view: "plan" },
  { id: "windows/plan/sliding",     category: "Windows",   subcategory: "Plan",      label: "Sliding",       path: "windows/plan/sliding.svg",     view: "plan" },
  { id: "windows/plan/double-hung", category: "Windows",   subcategory: "Plan",      label: "Double Hung",   path: "windows/plan/double-hung.svg", view: "plan" },
  { id: "windows/plan/awning",      category: "Windows",   subcategory: "Plan",      label: "Awning",        path: "windows/plan/awning.svg",      view: "plan" },
  // Windows — elevation
  { id: "windows/elevation/fixed",       category: "Windows", subcategory: "Elevation", label: "Fixed",       path: "windows/elevation/fixed.svg",       view: "elevation" },
  { id: "windows/elevation/casement",    category: "Windows", subcategory: "Elevation", label: "Casement",    path: "windows/elevation/casement.svg",    view: "elevation" },
  { id: "windows/elevation/sliding",     category: "Windows", subcategory: "Elevation", label: "Sliding",     path: "windows/elevation/sliding.svg",     view: "elevation" },
  { id: "windows/elevation/double-hung", category: "Windows", subcategory: "Elevation", label: "Double Hung", path: "windows/elevation/double-hung.svg", view: "elevation" },
  { id: "windows/elevation/awning",      category: "Windows", subcategory: "Elevation", label: "Awning",      path: "windows/elevation/awning.svg",      view: "elevation" },
  // Windows — section
  { id: "windows/section/fixed",        category: "Windows", subcategory: "Section",   label: "Fixed",        path: "windows/section/fixed.svg",        view: "section" },
  { id: "windows/section/casement",     category: "Windows", subcategory: "Section",   label: "Casement",     path: "windows/section/casement.svg",     view: "section" },
  { id: "windows/section/double-hung",  category: "Windows", subcategory: "Section",   label: "Double Hung",  path: "windows/section/double-hung.svg",  view: "section" },
  // Furniture — plan
  { id: "furniture/plan/chair",        category: "Furniture", subcategory: "Plan", label: "Chair",        path: "furniture/plan/chair.svg",        view: "plan" },
  { id: "furniture/plan/arm-chair",    category: "Furniture", subcategory: "Plan", label: "Arm Chair",    path: "furniture/plan/arm-chair.svg",    view: "plan" },
  { id: "furniture/plan/dining-table", category: "Furniture", subcategory: "Plan", label: "Dining Table", path: "furniture/plan/dining-table.svg", view: "plan" },
  { id: "furniture/plan/single-bed",   category: "Furniture", subcategory: "Plan", label: "Single Bed",   path: "furniture/plan/single-bed.svg",   view: "plan" },
  { id: "furniture/plan/double-bed",   category: "Furniture", subcategory: "Plan", label: "Double Bed",   path: "furniture/plan/double-bed.svg",   view: "plan" },
  { id: "furniture/plan/sofa",         category: "Furniture", subcategory: "Plan", label: "Sofa",         path: "furniture/plan/sofa.svg",         view: "plan" },
  { id: "furniture/plan/desk",         category: "Furniture", subcategory: "Plan", label: "Desk",         path: "furniture/plan/desk.svg",         view: "plan" },
  { id: "furniture/plan/bookcase",     category: "Furniture", subcategory: "Plan", label: "Bookcase",     path: "furniture/plan/bookcase.svg",     view: "plan" },
  { id: "furniture/plan/wardrobe",     category: "Furniture", subcategory: "Plan", label: "Wardrobe",     path: "furniture/plan/wardrobe.svg",     view: "plan" },
  // Furniture — elevation
  { id: "furniture/elevation/chair",  category: "Furniture", subcategory: "Elevation", label: "Chair", path: "furniture/elevation/chair.svg",  view: "elevation" },
  { id: "furniture/elevation/sofa",   category: "Furniture", subcategory: "Elevation", label: "Sofa",  path: "furniture/elevation/sofa.svg",   view: "elevation" },
  // Plumbing — plan
  { id: "plumbing/plan/kitchen-sink",   category: "Plumbing", subcategory: "Plan", label: "Kitchen Sink",   path: "plumbing/plan/kitchen-sink.svg",   view: "plan" },
  { id: "plumbing/plan/bathroom-sink",  category: "Plumbing", subcategory: "Plan", label: "Bathroom Sink",  path: "plumbing/plan/bathroom-sink.svg",  view: "plan" },
  { id: "plumbing/plan/toilet",         category: "Plumbing", subcategory: "Plan", label: "Toilet",         path: "plumbing/plan/toilet.svg",         view: "plan" },
  { id: "plumbing/plan/bathtub",        category: "Plumbing", subcategory: "Plan", label: "Bathtub",        path: "plumbing/plan/bathtub.svg",        view: "plan" },
  { id: "plumbing/plan/shower",         category: "Plumbing", subcategory: "Plan", label: "Shower",         path: "plumbing/plan/shower.svg",         view: "plan" },
  // Entourage — plan
  { id: "entourage/plan/person-standing", category: "Entourage", subcategory: "Plan",      label: "Standing", path: "entourage/plan/person-standing.svg", view: "plan" },
  { id: "entourage/plan/person-sitting",  category: "Entourage", subcategory: "Plan",      label: "Sitting",  path: "entourage/plan/person-sitting.svg",  view: "plan" },
  { id: "entourage/plan/person-walking",  category: "Entourage", subcategory: "Plan",      label: "Walking",  path: "entourage/plan/person-walking.svg",  view: "plan" },
  // Entourage — elevation
  { id: "entourage/elevation/person-standing", category: "Entourage", subcategory: "Elevation", label: "Standing", path: "entourage/elevation/person-standing.svg", view: "elevation" },
  { id: "entourage/elevation/person-sitting",  category: "Entourage", subcategory: "Elevation", label: "Sitting",  path: "entourage/elevation/person-sitting.svg",  view: "elevation" },
  { id: "entourage/elevation/person-walking",  category: "Entourage", subcategory: "Elevation", label: "Walking",  path: "entourage/elevation/person-walking.svg",  view: "elevation" },
  // Vegetation — plan
  { id: "vegetation/plan/tree-deciduous", category: "Vegetation", subcategory: "Plan",      label: "Deciduous Tree", path: "vegetation/plan/tree-deciduous.svg", view: "plan" },
  { id: "vegetation/plan/tree-conifer",   category: "Vegetation", subcategory: "Plan",      label: "Conifer Tree",   path: "vegetation/plan/tree-conifer.svg",   view: "plan" },
  { id: "vegetation/plan/shrub",          category: "Vegetation", subcategory: "Plan",      label: "Shrub",          path: "vegetation/plan/shrub.svg",          view: "plan" },
  // Vegetation — elevation
  { id: "vegetation/elevation/tree-deciduous", category: "Vegetation", subcategory: "Elevation", label: "Deciduous Tree", path: "vegetation/elevation/tree-deciduous.svg", view: "elevation" },
  { id: "vegetation/elevation/tree-conifer",   category: "Vegetation", subcategory: "Elevation", label: "Conifer Tree",   path: "vegetation/elevation/tree-conifer.svg",   view: "elevation" },
  { id: "vegetation/elevation/shrub",          category: "Vegetation", subcategory: "Elevation", label: "Shrub",          path: "vegetation/elevation/shrub.svg",          view: "elevation" },
  // Vehicles — plan
  { id: "vehicles/plan/sedan", category: "Vehicles", subcategory: "Plan", label: "Sedan", path: "vehicles/plan/sedan.svg", view: "plan" },
  { id: "vehicles/plan/suv",   category: "Vehicles", subcategory: "Plan", label: "SUV",   path: "vehicles/plan/suv.svg",   view: "plan" },
];

// Exported for tests and for the draft-elements block-insert tool
export { BLOCK_CATALOG };

// --- Selected block state ---------------------------------------------------

let _selectedBlockId: string | null = null;

export function getSelectedBlockId(): string | null {
  return _selectedBlockId;
}

export function setSelectedBlockId(id: string | null): void {
  _selectedBlockId = id;
}

export function getBlockEntry(id: string): BlockEntry | undefined {
  return BLOCK_CATALOG.find(b => b.id === id);
}

// --- Panel builder ----------------------------------------------------------

export function buildCadBlocksPanel(host: HTMLElement): void {
  host.innerHTML = "";
  host.className = "cad-blocks-panel";

  // Header
  const hdr = document.createElement("div");
  hdr.className = "cb-header";
  hdr.innerHTML = `<span class="cb-title">CAD BLOCKS</span>`;
  host.appendChild(hdr);

  // Search
  const search = document.createElement("input");
  search.type = "text";
  search.className = "cb-search";
  search.placeholder = "Search blocks…";
  host.appendChild(search);

  // View filter tabs: All | Plan | Elevation | Section
  const filterBar = document.createElement("div");
  filterBar.className = "cb-filter-bar";
  const filters: Array<{ view: BlockView | "all"; label: string }> = [
    { view: "all", label: "All" },
    { view: "plan", label: "Plan" },
    { view: "elevation", label: "Elev" },
    { view: "section", label: "Sect" },
  ];
  let activeView: BlockView | "all" = "all";
  const filterBtns = filters.map(f => {
    const btn = document.createElement("button");
    btn.className = "cb-filter-btn" + (f.view === "all" ? " cb-filter-btn--active" : "");
    btn.textContent = f.label;
    btn.dataset.view = f.view;
    filterBar.appendChild(btn);
    return btn;
  });
  host.appendChild(filterBar);

  // Content area (scrollable)
  const content = document.createElement("div");
  content.className = "cb-content";
  host.appendChild(content);

  // Render function — groups blocks by category, filters by search + view
  function render() {
    content.innerHTML = "";
    const q = search.value.toLowerCase().trim();
    const filtered = BLOCK_CATALOG.filter(b => {
      if (activeView !== "all" && b.view !== activeView) return false;
      if (q && !b.label.toLowerCase().includes(q) && !b.category.toLowerCase().includes(q)) return false;
      return true;
    });

    // Group by category
    const byCategory = new Map<string, BlockEntry[]>();
    for (const b of filtered) {
      const arr = byCategory.get(b.category) ?? [];
      arr.push(b);
      byCategory.set(b.category, arr);
    }

    for (const [cat, blocks] of byCategory) {
      const section = document.createElement("div");
      section.className = "cb-category";

      const catHdr = document.createElement("div");
      catHdr.className = "cb-category-hdr";
      catHdr.textContent = cat.toUpperCase();
      section.appendChild(catHdr);

      const grid = document.createElement("div");
      grid.className = "cb-grid";

      for (const block of blocks) {
        const tile = document.createElement("button");
        tile.className = "cb-tile";
        if (_selectedBlockId === block.id) tile.classList.add("cb-tile--selected");
        tile.dataset.blockId = block.id;
        tile.title = `${block.label} (${block.subcategory})`;

        // Lazy-load SVG preview as an <img>
        const img = document.createElement("img");
        img.className = "cb-tile-img";
        img.loading = "lazy";
        img.src = `/cad-blocks/${block.path}`;
        img.alt = block.label;
        tile.appendChild(img);

        const lbl = document.createElement("span");
        lbl.className = "cb-tile-label";
        lbl.textContent = block.label;
        tile.appendChild(lbl);

        tile.addEventListener("click", () => {
          // Deselect all tiles, select this one
          content.querySelectorAll<HTMLElement>(".cb-tile--selected")
            .forEach(t => t.classList.remove("cb-tile--selected"));
          tile.classList.add("cb-tile--selected");
          _selectedBlockId = block.id;
          // Activate block-insert draft tool
          setActiveDraftTool("block-insert");
          window.dispatchEvent(new CustomEvent("layout:block-selected", { detail: { blockId: block.id } }));
        });

        grid.appendChild(tile);
      }

      section.appendChild(grid);
      content.appendChild(section);
    }

    if (byCategory.size === 0) {
      content.innerHTML = `<div class="cb-empty">No blocks match.</div>`;
    }
  }

  // Wire search
  search.addEventListener("input", render);

  // Wire filter buttons
  filterBtns.forEach((btn, i) => {
    btn.addEventListener("click", () => {
      filterBtns.forEach(b => b.classList.remove("cb-filter-btn--active"));
      btn.classList.add("cb-filter-btn--active");
      activeView = filters[i].view;
      render();
    });
  });

  render();
}
