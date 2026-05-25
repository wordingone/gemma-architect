# CAD Blocks Library — Source Provenance

Implemented for #1888 (replaces generated blocks from #1853). All 38 SVGs were converted
from DXF files in the public repository
[GSStnb/dxfBlocks](https://github.com/GSStnb/dxfBlocks), licensed **CC0-1.0**
(public domain dedication). No creative work was synthesized by this project; the
conversion is a purely mechanical format transformation: DXF entities → SVG paths,
Y-axis flip, normalized 100×100 viewBox.

Upstream: https://github.com/GSStnb/dxfBlocks  
License: https://github.com/GSStnb/dxfBlocks/blob/main/LICENSE (CC0-1.0)  
Fetch date: 2026-05-24 (via `gh api repos/GSStnb/dxfBlocks/contents/<path>`)

## Per-block source map

| Local SVG | Upstream DXF path |
|---|---|
| `doors/plan/single-swing.svg` | `Architecture/Doors/Interior/IntrSwng-30RH.dxf` |
| `doors/plan/double-swing.svg` | `Architecture/Doors/Interior/IntrSwng-Dbl30.dxf` |
| `doors/plan/sliding.svg` | `Architecture/Doors/Interior/IntrSlidr-Dbl30.dxf` |
| `doors/plan/pocket.svg` | `Architecture/Doors/Interior/IntrPocket-30.dxf` |
| `doors/plan/bi-fold.svg` | `Architecture/Doors/Interior/IntrBifold-30.dxf` |
| `windows/plan/fixed.svg` | `Architecture/Windows/Plans/Fixed-30.dxf` |
| `windows/plan/casement.svg` | `Architecture/Windows/Plans/Csmt-30.dxf` |
| `windows/plan/sliding.svg` | `Architecture/Windows/Plans/FxdSldr-36.dxf` |
| `windows/plan/fixed-casement.svg` | `Architecture/Windows/Plans/FxdCsmt-36.dxf` |
| `windows/elevation/fixed-small.svg` | `Architecture/Windows/Elevations/Fixed/24x/Fixed-24x36.dxf` |
| `windows/elevation/fixed-medium.svg` | `Architecture/Windows/Elevations/Fixed/30x/Fixed-30x48.dxf` |
| `windows/elevation/fixed-large.svg` | `Architecture/Windows/Elevations/Fixed/36x/Fixed-36x48.dxf` |
| `windows/elevation/casement.svg` | `Architecture/Windows/Elevations/Csmt/Csmt-18.dxf` |
| `windows/section/casement-head.svg` | `Architecture/Windows/Details/Csmt-Head&Sill.dxf` |
| `windows/section/casement-jamb.svg` | `Architecture/Windows/Details/Csmt-Jamb.dxf` |
| `windows/section/fixed.svg` | `Architecture/Windows/Details/Fixed-18.dxf` |
| `plumbing/plan/toilet.svg` | `Architecture/Fixtures/Bathroom/Toilet.dxf` |
| `plumbing/plan/bathroom-sink.svg` | `Architecture/Fixtures/Bathroom/Sink.dxf` |
| `plumbing/plan/bathtub.svg` | `Architecture/Fixtures/Bathroom/Bathtub-60x30.dxf` |
| `plumbing/plan/shower.svg` | `Architecture/Fixtures/Bathroom/ShowerBase-36x36.dxf` |
| `plumbing/plan/kitchen-sink.svg` | `Architecture/Fixtures/Kitchen/Sink-Double.dxf` |
| `furniture/plan/chair.svg` | `Architecture/Furniture/Dining Room/Chair.dxf` |
| `furniture/plan/arm-chair.svg` | `Architecture/Furniture/Living Room/ChairUpholstered.dxf` |
| `furniture/plan/dining-table.svg` | `Architecture/Furniture/Dining Room/TableRect-90-72x44.dxf` |
| `furniture/plan/single-bed.svg` | `Architecture/Furniture/Bedroom/BedSingle.dxf` |
| `furniture/plan/double-bed.svg` | `Architecture/Furniture/Bedroom/BedDouble.dxf` |
| `furniture/plan/sofa.svg` | `Architecture/Furniture/Living Room/SofaUpholstered.dxf` |
| `furniture/plan/desk.svg` | `Architecture/Furniture/Office/Desk-60x30.dxf` |
| `furniture/plan/bookcase.svg` | `Architecture/Furniture/Office/Shelf-48x12.dxf` |
| `furniture/plan/wardrobe.svg` | `Architecture/Furniture/Bedroom/Armoire.dxf` |
| `vegetation/plan/tree-deciduous.svg` | `Architecture/Landscaping/DeciduousTree.dxf` |
| `vegetation/plan/tree-conifer.svg` | `Architecture/Landscaping/Tree1.dxf` |
| `vegetation/plan/shrub.svg` | `Architecture/Landscaping/DeciduousShrub.dxf` |
| `appliances/plan/refrigerator.svg` | `Architecture/Appliances/Kitchen/Refrigerator-SglDoor.dxf` |
| `appliances/plan/washer.svg` | `Architecture/Appliances/Laundry/Washer.dxf` |
| `appliances/plan/dryer.svg` | `Architecture/Appliances/Laundry/Dryer.dxf` |
| `appliances/plan/dishwasher.svg` | `Architecture/Appliances/Kitchen/Dishwasher.dxf` |
| `appliances/plan/range.svg` | `Architecture/Appliances/Kitchen/Range-ElecFrontCtrl.dxf` |

## Conversion notes

- Entities handled: LINE, ARC, CIRCLE, ELLIPSE, LWPOLYLINE, SPLINE
- Y-axis flipped: DXF is Y-up; SVG is Y-down
- viewBox normalized to 100×100 with 5-unit padding on all sides
- Dense LWPOLYLINEs downsampled to 48 vertices max (tree canopy, shrub shapes)
- Desk (Desk-60x30.dxf) renders as 4-line outline — the upstream DXF contains only the plan outline
