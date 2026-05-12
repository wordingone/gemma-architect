// scene-kg.test.ts — verify in-memory triplestore (T8).

import { describe, expect, test, beforeEach } from "bun:test";
import {
  addTriple,
  removeTriple,
  removeAllForSubject,
  clearKG,
  queryKG,
  getHosts,
  getContained,
  getContainer,
  getType,
  getInstancesOf,
  setSelected,
  getSelected,
  snapshot,
  snapshotAsText,
  toSidecar,
  fromSidecar,
  tripleCount,
} from "../src/scene/scene-kg";

beforeEach(() => {
  clearKG();
  setSelected(null);
});

describe("Triple add / remove / dedup", () => {
  test("addTriple inserts and returns true on first insert", () => {
    expect(addTriple("a", "rdf:type", "IfcWall")).toBe(true);
    expect(tripleCount()).toBe(1);
  });

  test("addTriple is idempotent — second call returns false", () => {
    addTriple("a", "rdf:type", "IfcWall");
    expect(addTriple("a", "rdf:type", "IfcWall")).toBe(false);
    expect(tripleCount()).toBe(1);
  });

  test("removeTriple removes and returns true; missing returns false", () => {
    addTriple("a", "rdf:type", "IfcWall");
    expect(removeTriple("a", "rdf:type", "IfcWall")).toBe(true);
    expect(removeTriple("a", "rdf:type", "IfcWall")).toBe(false);
    expect(tripleCount()).toBe(0);
  });

  test("clearKG empties everything", () => {
    addTriple("a", "rdf:type", "IfcWall");
    addTriple("b", "rdf:type", "IfcSlab");
    clearKG();
    expect(tripleCount()).toBe(0);
    expect(queryKG({}).length).toBe(0);
  });
});

describe("Query patterns", () => {
  beforeEach(() => {
    addTriple("w1", "rdf:type", "IfcWall");
    addTriple("w2", "rdf:type", "IfcWall");
    addTriple("w3", "rdf:type", "IfcWall");
    addTriple("d1", "rdf:type", "IfcDoor");
    addTriple("w1", "hosts", "d1");
    addTriple("w1", "containedIn", "site-001");
    addTriple("w2", "containedIn", "site-001");
  });

  test("empty pattern returns all triples", () => {
    expect(queryKG({}).length).toBe(7);
  });

  test("subject filter returns triples for that subject", () => {
    const res = queryKG({ subject: "w1" });
    expect(res.length).toBe(3); // rdf:type, hosts, containedIn
  });

  test("predicate filter returns triples with that predicate", () => {
    const res = queryKG({ predicate: "rdf:type" });
    expect(res.length).toBe(4);
  });

  test("object filter returns triples with that object", () => {
    const res = queryKG({ object: "site-001" });
    expect(res.length).toBe(2);
  });

  test("subject + predicate AND-intersect", () => {
    const res = queryKG({ subject: "w1", predicate: "hosts" });
    expect(res.length).toBe(1);
    expect(res[0].object).toBe("d1");
  });

  test("non-matching subject returns empty", () => {
    expect(queryKG({ subject: "nonexistent" }).length).toBe(0);
  });
});

describe("Convenience accessors", () => {
  beforeEach(() => {
    addTriple("w1", "rdf:type", "IfcWall");
    addTriple("d1", "rdf:type", "IfcDoor");
    addTriple("d2", "rdf:type", "IfcDoor");
    addTriple("w1", "hosts", "d1");
    addTriple("w1", "hosts", "d2");
    addTriple("d1", "containedIn", "site-001");
  });

  test("getHosts returns hosted uuids", () => {
    expect(getHosts("w1").sort()).toEqual(["d1", "d2"]);
  });

  test("getContained returns elements in a space", () => {
    expect(getContained("site-001")).toEqual(["d1"]);
  });

  test("getContainer returns the space for an element", () => {
    expect(getContainer("d1")).toBe("site-001");
    expect(getContainer("d2")).toBeNull();
  });

  test("getType returns canonical_name for an instance", () => {
    expect(getType("w1")).toBe("IfcWall");
    expect(getType("d1")).toBe("IfcDoor");
    expect(getType("nonexistent")).toBeNull();
  });

  test("getInstancesOf returns uuids for a type", () => {
    expect(getInstancesOf("IfcWall")).toEqual(["w1"]);
    expect(getInstancesOf("IfcDoor").sort()).toEqual(["d1", "d2"]);
  });
});

describe("Cascading delete via removeAllForSubject", () => {
  test("removeAllForSubject removes triples on both subject and object columns", () => {
    addTriple("w1", "rdf:type", "IfcWall");
    addTriple("d1", "rdf:type", "IfcDoor");
    addTriple("w1", "hosts", "d1");
    expect(removeAllForSubject("d1")).toBe(2); // rdf:type AND hosts (as object)
    expect(getHosts("w1").length).toBe(0);
    expect(getType("d1")).toBeNull();
  });
});

describe("Selection state", () => {
  test("setSelected + getSelected round-trip", () => {
    expect(getSelected()).toBeNull();
    setSelected("w1");
    expect(getSelected()).toBe("w1");
    setSelected(null);
    expect(getSelected()).toBeNull();
  });
});

describe("Plan §T8 spec — 3 walls + 1 door scene", () => {
  test("create 3 walls + 1 door yields ≥4 instance triples + 1 hosts triple; deletion drops hosts to 0", () => {
    addTriple("w1", "rdf:type", "IfcWall");
    addTriple("w2", "rdf:type", "IfcWall");
    addTriple("w3", "rdf:type", "IfcWall");
    addTriple("d1", "rdf:type", "IfcDoor");
    addTriple("w1", "hosts", "d1");

    const instanceTriples = queryKG({ predicate: "rdf:type" });
    expect(instanceTriples.length).toBeGreaterThanOrEqual(4);

    const hostTriples = queryKG({ predicate: "hosts" });
    expect(hostTriples.length).toBe(1);
    expect(hostTriples[0]).toEqual({ subject: "w1", predicate: "hosts", object: "d1" });

    // Delete the door → hosts triples should drop to 0.
    removeAllForSubject("d1");
    expect(queryKG({ predicate: "hosts" }).length).toBe(0);
    // wall instances unchanged.
    expect(queryKG({ predicate: "rdf:type", object: "IfcWall" }).length).toBe(3);
  });
});

describe("Snapshot for agent context", () => {
  beforeEach(() => {
    addTriple("w1", "rdf:type", "IfcWall");
    addTriple("w2", "rdf:type", "IfcWall");
    addTriple("d1", "rdf:type", "IfcDoor");
    addTriple("w1", "hosts", "d1");
    addTriple("w1", "containedIn", "site-001");
    setSelected("w1");
  });

  test("snapshot reports counts + hostings + selected", () => {
    const s = snapshot();
    expect(s.totalTriples).toBe(5);
    expect(s.counts.IfcWall).toBe(2);
    expect(s.counts.IfcDoor).toBe(1);
    expect(s.hostings.length).toBe(1);
    expect(s.hostings[0].host).toBe("w1");
    expect(s.hostings[0].hostType).toBe("IfcWall");
    expect(s.hostings[0].hostedType).toBe("IfcDoor");
    expect(s.selected.uuid).toBe("w1");
    expect(s.selected.type).toBe("IfcWall");
  });

  test("snapshotAsText is a non-empty natural-language summary", () => {
    const txt = snapshotAsText();
    expect(txt.length).toBeGreaterThan(20);
    expect(txt).toContain("IfcWall");
    expect(txt).toContain("Selected:");
  });

  test("empty scene snapshotAsText is informative", () => {
    clearKG();
    setSelected(null);
    expect(snapshotAsText()).toContain("empty");
  });
});

describe("Sidecar persistence", () => {
  test("toSidecar / fromSidecar round-trip preserves triples + selected", () => {
    addTriple("w1", "rdf:type", "IfcWall");
    addTriple("d1", "rdf:type", "IfcDoor");
    addTriple("w1", "hosts", "d1");
    setSelected("d1");

    const sidecar = toSidecar();
    expect(sidecar.version).toBe(1);
    expect(sidecar.triples.length).toBe(3);
    expect(sidecar.selected).toBe("d1");

    clearKG();
    setSelected(null);
    expect(tripleCount()).toBe(0);

    fromSidecar(sidecar);
    expect(tripleCount()).toBe(3);
    expect(getSelected()).toBe("d1");
    expect(getHosts("w1")).toEqual(["d1"]);
  });

  test("fromSidecar with bad version throws", () => {
    expect(() => fromSidecar({ version: 99 as 1, triples: [], selected: null })).toThrow();
  });
});
