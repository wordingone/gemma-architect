// predicates.ts — relational predicate registry + IFC4 round-trip mapping (T9).
//
// Per silly-baking-yeti.md: ship 8 predicates on day 1, with declarative
// IFC4 mapping for round-trip preservation. 6 of the 8 round-trip natively
// to IFC4 IfcRel* entities; the other 2 (supports, dependsOn) ride a
// sidecar `kg.json` file written alongside lossy formats (OBJ/STL/GLB).
//
// scene-kg.ts maintains the live triplestore; this module supplies the
// schema and the sidecar writer.

export type PredicateName =
  | "hosts"
  | "containedIn"
  | "aggregatedBy"
  | "bounds"
  | "connectedTo"
  | "supports"
  | "dependsOn"
  | "groupedWith";

export type PredicateDef = {
  name: PredicateName;
  description: string;
  domain: string; // expected subject role (host, element, face, etc.)
  range: string;  // expected object role
  ifc4: IFC4Mapping | null; // null = sidecar-only
};

export type IFC4Mapping = {
  // The IfcRel* entity emitted at export. Some predicates need a pair of
  // IfcRel* entities (e.g. hosts emits both IfcRelVoidsElement and
  // IfcRelFillsElement); record both in `entities`.
  entities: string[];
  // Direction matters for asymmetric relationships. "subject_first" means
  // the predicate's subject is the IfcRel*'s primary actor; "object_first"
  // is the reverse mapping.
  orientation: "subject_first" | "object_first";
  // Notes on edge cases — e.g. IfcRelSpaceBoundary needs PhysicalOrVirtual.
  notes?: string;
};

export const PREDICATES: Record<PredicateName, PredicateDef> = {
  hosts: {
    name: "hosts",
    description: "host (e.g. wall) hosts hosted (e.g. door / window)",
    domain: "host",
    range: "hosted",
    ifc4: {
      entities: ["IfcRelVoidsElement", "IfcRelFillsElement"],
      orientation: "subject_first",
      notes:
        "IfcRelVoidsElement(host, void) + IfcRelFillsElement(void, hosted). The opening (IfcOpeningElement) is the bridge.",
    },
  },
  containedIn: {
    name: "containedIn",
    description: "element contained in a spatial structure (storey, building, site)",
    domain: "element",
    range: "spatial_structure",
    ifc4: {
      entities: ["IfcRelContainedInSpatialStructure"],
      orientation: "object_first",
      notes: "Subject is the contained element; object is the IfcSpatialStructureElement (typically IfcBuildingStorey).",
    },
  },
  aggregatedBy: {
    name: "aggregatedBy",
    description: "part aggregated by whole (storey aggregates building, building aggregates site)",
    domain: "part",
    range: "whole",
    ifc4: {
      entities: ["IfcRelAggregates"],
      orientation: "object_first",
      notes: "RelatingObject is the whole; RelatedObjects are the parts.",
    },
  },
  bounds: {
    name: "bounds",
    description: "surface (wall face / slab top) bounds a space",
    domain: "face",
    range: "space",
    ifc4: {
      entities: ["IfcRelSpaceBoundary"],
      orientation: "subject_first",
      notes:
        "PhysicalOrVirtualBoundary defaults to PHYSICAL when the bounding element is a real surface.",
    },
  },
  connectedTo: {
    name: "connectedTo",
    description: "element connected to element (wall-to-wall, beam-to-column)",
    domain: "element",
    range: "element",
    ifc4: {
      entities: ["IfcRelConnectsElements"],
      orientation: "subject_first",
    },
  },
  supports: {
    name: "supports",
    description: "structural supporter supports supported (load path)",
    domain: "supporter",
    range: "supported",
    ifc4: null, // sidecar — IFC4 structural extensions optional
  },
  dependsOn: {
    name: "dependsOn",
    description: "derived (parametric / generative) element depends on source",
    domain: "derived",
    range: "source",
    ifc4: null, // sidecar — parametric chain not in IFC4 core
  },
  groupedWith: {
    name: "groupedWith",
    description: "member grouped with collection (e.g. furniture set, system)",
    domain: "member",
    range: "group",
    ifc4: {
      entities: ["IfcRelAssignsToGroup"],
      orientation: "object_first",
      notes: "RelatingGroup is the group; RelatedObjects are the members.",
    },
  },
};

export type Triple = { subject: string; predicate: PredicateName; object: string };

// --- Sidecar writer ---

export type SidecarPayload = {
  version: 1;
  generated_at: string;
  // Predicates encoded native to IFC4 are SKIPPED in the sidecar — the IFC4
  // file already carries them. Only sidecar-only predicates land here, plus
  // any extra metadata that doesn't fit IFC4 properties.
  triples: Triple[];
  // UUID-keyed metadata for OBJ/STL/GLB round-trip. Keys map to per-mesh
  // userData.uuid in the THREE.Mesh tree; values carry whatever IFC4 lossy
  // formats discard (ifcClass, guid, storeyName, layer).
  meta: Record<string, Record<string, string>>;
};

export function buildSidecar(triples: Triple[], meta: Record<string, Record<string, string>>): SidecarPayload {
  // Filter to predicates that genuinely need sidecar persistence.
  // Predicates with non-null IFC4 mapping are exported via IFC4 directly when
  // the format is IFC4; for OBJ/STL/GLB they ALSO need sidecar coverage
  // (those formats are pure geometry — no relational schema). So the format
  // matters; this helper keeps everything by default and the caller decides
  // whether to invoke it (lossy paths only).
  return {
    version: 1,
    generated_at: new Date().toISOString(),
    triples: [...triples],
    meta: { ...meta },
  };
}

export function serializeSidecar(payload: SidecarPayload): string {
  return JSON.stringify(payload, null, 2);
}

export function parseSidecar(text: string): SidecarPayload {
  const obj = JSON.parse(text) as SidecarPayload;
  if (obj.version !== 1) {
    throw new Error(`predicates: unsupported sidecar version ${obj.version}`);
  }
  return obj;
}

// --- Round-trip query helpers ---

export function predicatesFromIFC4(): PredicateName[] {
  return (Object.keys(PREDICATES) as PredicateName[]).filter((p) => PREDICATES[p].ifc4 !== null);
}

export function predicatesFromSidecar(): PredicateName[] {
  return (Object.keys(PREDICATES) as PredicateName[]).filter((p) => PREDICATES[p].ifc4 === null);
}

export function ifc4EntityFor(p: PredicateName): string[] {
  return PREDICATES[p].ifc4?.entities ?? [];
}
