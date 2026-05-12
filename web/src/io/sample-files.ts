// Sample CAD/3D files bundled in web/public/samples/, surfaced through the
// "Load file" mode dropdown. Hardcoded rather than scanned at build time so
// the list can carry curatorial metadata (entity counts, label) and works
// uniformly under `vite dev` and `vite preview`.

export type SampleFile = {
  id: string;
  label: string;       // dropdown text
  path: string;        // path under /samples/, served by Vite from web/public/
  format: string;      // lowercase extension w/o dot, e.g. "ifc"
  size?: string;       // human-readable byte count for hover text
  note?: string;       // tooltip / status hint
};

export const SAMPLES: SampleFile[] = [
  // Real architect-authored building. Schultz Residence — multi-story
  // residence in the Boston metro area (IfcSite coordinates 42°21'30"N
  // 71°3'35"W). Authored in Autodesk Revit 2014 by Opening Design
  // (architecture practice). Sourced from opensourceBIM/IFC-files under
  // CC BY-ND 4.0 (commercial use + display permitted, no derivatives).
  // This is the centerpiece sample — the rest below are test fixtures.
  {
    id: "schultz-residence",
    label: "Schultz Residence — multi-story home, Boston (Opening Design, Revit 2014)",
    path: "samples/Schultz_Residence.ifc",
    format: "ifc",
    size: "21.8 MB",
    note: "11 storeys (Basement→Roof), 105 walls, 25 windows, 17 doors, 10 stairs · 424k entities · IFC2x3, Revit 2014. Real building. CC BY-ND 4.0 / Opening Design.",
  },
  // Synthetic IFC4 reference fixtures from KIT (Karlsruhe Institute of
  // Technology) — TEST FIXTURES KIT created for IFC schema validation,
  // NOT real-world architect-authored projects. Bundled as parsing /
  // perf benchmarks alongside the real Schultz Residence above.
  {
    id: "kit-fzk-haus",
    label: "KIT FZK-Haus — IFC4 reference fixture (residential, synthetic)",
    path: "samples/AC20-FZK-Haus.ifc",
    format: "ifc",
    size: "2.5 MB",
    note: "44,249 entities, IFC4 — KIT synthetic reference, ArchiCAD 20 export. Test fixture, not a real project.",
  },
  {
    id: "kit-office",
    label: "KIT Institute Var-2 — IFC4 reference fixture (office, synthetic)",
    path: "samples/AC20-Institute-Var-2.ifc",
    format: "ifc",
    size: "10.4 MB",
    note: "147,712 entities, IFC4 — KIT 'phantasy' office reference, ArchiCAD 20 export. Test fixture, not a real project.",
  },
  // Smaller fixtures for fast iteration / smoke testing.
  {
    id: "bonsai-openings",
    label: "Bonsai project — small house with openings (IFC4)",
    path: "samples/bonsai-project0-openings.ifc",
    format: "ifc",
    size: "48 KB",
    note: "788 entities, IFC4 — BlenderBIM tutorial 'Project 0' starter, fast parse",
  },
  {
    id: "wall-with-opening",
    label: "Wall + window opening (IFC4) — fastest",
    path: "samples/wall-with-opening-and-window.ifc",
    format: "ifc",
    size: "12 KB",
    note: "Single wall with window void — sub-second parse, smoke test",
  },
  {
    id: "simple-sweep",
    label: "Simple sweep primitive (IFC4X3_ADD2)",
    path: "samples/simple-sweep-1.ifc",
    format: "ifc",
    size: "4 KB",
    note: "Minimal swept solid, IfcOpenShell 0.8.2, schema IFC4X3_ADD2 — schema-version smoke test (web-ifc 0.0.77 partial-parses; no crash)",
  },
  {
    id: "triangle-obj",
    label: "Triangle (OBJ) — loader smoke test",
    path: "samples/triangle.obj",
    format: "obj",
    size: "<1 KB",
    note: "OBJLoader path verification",
  },
  {
    id: "triangle-stl",
    label: "Triangle (STL ASCII) — loader smoke test",
    path: "samples/triangle.stl",
    format: "stl",
    size: "<1 KB",
    note: "STLLoader path verification",
  },
];
