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
  // Doors — plan (source: GSStnb/dxfBlocks, CC0-1.0)
  { id: "doors/plan/single-swing", category: "Doors",  subcategory: "Plan", label: "Single Swing", path: "doors/plan/single-swing.svg", view: "plan" },
  { id: "doors/plan/double-swing", category: "Doors",  subcategory: "Plan", label: "Double Swing", path: "doors/plan/double-swing.svg", view: "plan" },
  { id: "doors/plan/sliding",      category: "Doors",  subcategory: "Plan", label: "Sliding",      path: "doors/plan/sliding.svg",      view: "plan" },
  { id: "doors/plan/pocket",       category: "Doors",  subcategory: "Plan", label: "Pocket",       path: "doors/plan/pocket.svg",       view: "plan" },
  { id: "doors/plan/bi-fold",      category: "Doors",  subcategory: "Plan", label: "Bi-Fold",      path: "doors/plan/bi-fold.svg",      view: "plan" },
  // Windows — plan (source: GSStnb/dxfBlocks, CC0-1.0)
  { id: "windows/plan/fixed",          category: "Windows", subcategory: "Plan",      label: "Fixed",          path: "windows/plan/fixed.svg",          view: "plan" },
  { id: "windows/plan/casement",       category: "Windows", subcategory: "Plan",      label: "Casement",       path: "windows/plan/casement.svg",       view: "plan" },
  { id: "windows/plan/sliding",        category: "Windows", subcategory: "Plan",      label: "Slider",         path: "windows/plan/sliding.svg",        view: "plan" },
  { id: "windows/plan/fixed-casement", category: "Windows", subcategory: "Plan",      label: "Fixed+Casement", path: "windows/plan/fixed-casement.svg", view: "plan" },
  // Windows — elevation (source: GSStnb/dxfBlocks, CC0-1.0)
  { id: "windows/elevation/fixed-small",  category: "Windows", subcategory: "Elevation", label: "Fixed 24\"",  path: "windows/elevation/fixed-small.svg",  view: "elevation" },
  { id: "windows/elevation/fixed-medium", category: "Windows", subcategory: "Elevation", label: "Fixed 30\"",  path: "windows/elevation/fixed-medium.svg", view: "elevation" },
  { id: "windows/elevation/fixed-large",  category: "Windows", subcategory: "Elevation", label: "Fixed 36\"",  path: "windows/elevation/fixed-large.svg",  view: "elevation" },
  { id: "windows/elevation/casement",     category: "Windows", subcategory: "Elevation", label: "Casement",    path: "windows/elevation/casement.svg",     view: "elevation" },
  // Windows — section/detail (source: GSStnb/dxfBlocks, CC0-1.0)
  { id: "windows/section/casement-head", category: "Windows", subcategory: "Section", label: "Csmt Head&Sill", path: "windows/section/casement-head.svg", view: "section" },
  { id: "windows/section/casement-jamb", category: "Windows", subcategory: "Section", label: "Csmt Jamb",      path: "windows/section/casement-jamb.svg", view: "section" },
  { id: "windows/section/fixed",         category: "Windows", subcategory: "Section", label: "Fixed",          path: "windows/section/fixed.svg",         view: "section" },
  // Plumbing — plan (source: GSStnb/dxfBlocks, CC0-1.0)
  { id: "plumbing/plan/toilet",        category: "Plumbing", subcategory: "Plan", label: "Toilet",        path: "plumbing/plan/toilet.svg",        view: "plan" },
  { id: "plumbing/plan/bathroom-sink", category: "Plumbing", subcategory: "Plan", label: "Bathroom Sink", path: "plumbing/plan/bathroom-sink.svg", view: "plan" },
  { id: "plumbing/plan/bathtub",       category: "Plumbing", subcategory: "Plan", label: "Bathtub",       path: "plumbing/plan/bathtub.svg",       view: "plan" },
  { id: "plumbing/plan/shower",        category: "Plumbing", subcategory: "Plan", label: "Shower",        path: "plumbing/plan/shower.svg",        view: "plan" },
  { id: "plumbing/plan/kitchen-sink",  category: "Plumbing", subcategory: "Plan", label: "Kitchen Sink",  path: "plumbing/plan/kitchen-sink.svg",  view: "plan" },
  // Furniture — plan (source: GSStnb/dxfBlocks, CC0-1.0)
  { id: "furniture/plan/chair",        category: "Furniture", subcategory: "Plan", label: "Chair",        path: "furniture/plan/chair.svg",        view: "plan" },
  { id: "furniture/plan/arm-chair",    category: "Furniture", subcategory: "Plan", label: "Arm Chair",    path: "furniture/plan/arm-chair.svg",    view: "plan" },
  { id: "furniture/plan/dining-table", category: "Furniture", subcategory: "Plan", label: "Dining Table", path: "furniture/plan/dining-table.svg", view: "plan" },
  { id: "furniture/plan/single-bed",   category: "Furniture", subcategory: "Plan", label: "Single Bed",   path: "furniture/plan/single-bed.svg",   view: "plan" },
  { id: "furniture/plan/double-bed",   category: "Furniture", subcategory: "Plan", label: "Double Bed",   path: "furniture/plan/double-bed.svg",   view: "plan" },
  { id: "furniture/plan/sofa",         category: "Furniture", subcategory: "Plan", label: "Sofa",         path: "furniture/plan/sofa.svg",         view: "plan" },
  { id: "furniture/plan/desk",         category: "Furniture", subcategory: "Plan", label: "Desk",         path: "furniture/plan/desk.svg",         view: "plan" },
  { id: "furniture/plan/bookcase",     category: "Furniture", subcategory: "Plan", label: "Bookcase",     path: "furniture/plan/bookcase.svg",     view: "plan" },
  { id: "furniture/plan/wardrobe",     category: "Furniture", subcategory: "Plan", label: "Wardrobe",     path: "furniture/plan/wardrobe.svg",     view: "plan" },
  // Vegetation — plan (source: GSStnb/dxfBlocks, CC0-1.0)
  { id: "vegetation/plan/tree-deciduous", category: "Vegetation", subcategory: "Plan", label: "Deciduous Tree", path: "vegetation/plan/tree-deciduous.svg", view: "plan" },
  { id: "vegetation/plan/tree-conifer",   category: "Vegetation", subcategory: "Plan", label: "Conifer Tree",   path: "vegetation/plan/tree-conifer.svg",   view: "plan" },
  { id: "vegetation/plan/shrub",          category: "Vegetation", subcategory: "Plan", label: "Shrub",          path: "vegetation/plan/shrub.svg",          view: "plan" },
  // Appliances — plan (source: GSStnb/dxfBlocks, CC0-1.0)
  { id: "appliances/plan/refrigerator", category: "Appliances", subcategory: "Plan", label: "Refrigerator", path: "appliances/plan/refrigerator.svg", view: "plan" },
  { id: "appliances/plan/washer",       category: "Appliances", subcategory: "Plan", label: "Washer",       path: "appliances/plan/washer.svg",       view: "plan" },
  { id: "appliances/plan/dryer",        category: "Appliances", subcategory: "Plan", label: "Dryer",        path: "appliances/plan/dryer.svg",        view: "plan" },
  { id: "appliances/plan/dishwasher",   category: "Appliances", subcategory: "Plan", label: "Dishwasher",   path: "appliances/plan/dishwasher.svg",   view: "plan" },
  { id: "appliances/plan/range",        category: "Appliances", subcategory: "Plan", label: "Range",        path: "appliances/plan/range.svg",        view: "plan" },
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
