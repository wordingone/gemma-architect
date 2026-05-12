import { describe, it, expect } from "bun:test";
import { buildIfcScene } from "../src/ifc-build.js";
import type { IfcSceneElement, IfcLevel } from "../src/ifc-build.js";

// Minimal triangle mesh for test elements.
function minimalMesh() {
  return {
    vertices: new Float32Array([0, 0, 0, 1, 0, 0, 0, 1, 0]),
    indices: new Uint32Array([0, 1, 2]),
  };
}

describe("buildIfcScene — multilevel (#243)", () => {
  it("single default storey when no levels passed", () => {
    const elements: IfcSceneElement[] = [
      { mesh: minimalMesh(), creator: "IfcWall" },
    ];
    const bytes = buildIfcScene(elements);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("IFCBUILDINGSTOREY");
    expect(text.match(/IFCBUILDINGSTOREY/g)?.length).toBe(1);
    expect(text).toContain("Default Storey");
    expect(text).toContain("IFCRELCONTAINEDINSPATIALSTRUCTURE");
  });

  it("emits one IFCBUILDINGSTOREY per level + Unassigned", () => {
    const levels: IfcLevel[] = [
      { levelId: "level/0", name: "Ground", elevation: 0 },
      { levelId: "level/1", name: "Roof", elevation: 3 },
    ];
    const elements: IfcSceneElement[] = [
      { mesh: minimalMesh(), creator: "IfcWall", levelId: "level/0" },
      { mesh: minimalMesh(), creator: "IfcSlab", levelId: "level/1" },
    ];
    const bytes = buildIfcScene(elements, levels);
    const text = new TextDecoder().decode(bytes);
    // 3 storeys: Ground, Roof, Unassigned
    expect(text.match(/IFCBUILDINGSTOREY/g)?.length).toBe(3);
    expect(text).toContain("'Ground'");
    expect(text).toContain("'Roof'");
    expect(text).toContain("'Unassigned'");
  });

  it("elements with no matching levelId fall into Unassigned storey", () => {
    const levels: IfcLevel[] = [
      { levelId: "level/0", name: "Ground", elevation: 0 },
    ];
    const elements: IfcSceneElement[] = [
      { mesh: minimalMesh(), creator: "IfcWall" }, // no levelId
    ];
    const bytes = buildIfcScene(elements, levels);
    const text = new TextDecoder().decode(bytes);
    // Wall should be contained in Unassigned (Ground's bucket is empty → no containedIn for Ground).
    const containedCount = text.match(/IFCRELCONTAINEDINSPATIALSTRUCTURE/g)?.length ?? 0;
    expect(containedCount).toBe(1); // only Unassigned has elements
    expect(text).toContain("'Unassigned'");
  });

  it("emits separate IFCRELCONTAINEDINSPATIALSTRUCTURE per occupied storey", () => {
    const levels: IfcLevel[] = [
      { levelId: "level/0", name: "Ground", elevation: 0 },
      { levelId: "level/1", name: "Upper", elevation: 3 },
    ];
    const elements: IfcSceneElement[] = [
      { mesh: minimalMesh(), creator: "IfcWall", levelId: "level/0" },
      { mesh: minimalMesh(), creator: "IfcSlab", levelId: "level/1" },
    ];
    const bytes = buildIfcScene(elements, levels);
    const text = new TextDecoder().decode(bytes);
    // 2 occupied storeys → 2 containedIn relationships
    expect(text.match(/IFCRELCONTAINEDINSPATIALSTRUCTURE/g)?.length).toBe(2);
  });

  it("storey elevation matches level.elevation", () => {
    const levels: IfcLevel[] = [
      { levelId: "level/0", name: "Mezzanine", elevation: 1.5 },
    ];
    const elements: IfcSceneElement[] = [
      { mesh: minimalMesh(), creator: "IfcColumn", levelId: "level/0" },
    ];
    const bytes = buildIfcScene(elements, levels);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("1.5");
  });
});

describe("buildIfcScene — property sets (#244)", () => {
  it("emits no property set when dispatchArgs is absent", () => {
    const elements: IfcSceneElement[] = [
      { mesh: minimalMesh(), creator: "IfcWall" },
    ];
    const bytes = buildIfcScene(elements);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("IFCPROPERTYSET");
    expect(text).not.toContain("IFCRELDEFINESBYPROPERTIES");
  });

  it("emits IFCPROPERTYSET with numeric args", () => {
    const elements: IfcSceneElement[] = [
      {
        mesh: minimalMesh(),
        creator: "IfcWall",
        dispatchArgs: { length: 5, thickness: 0.2, height: 3 },
      },
    ];
    const bytes = buildIfcScene(elements);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("IFCPROPERTYSET");
    expect(text).toContain("IFCRELDEFINESBYPROPERTIES");
    expect(text).toContain("IFCPROPERTYSINGLEVALUE");
    expect(text).toContain("'length'");
    expect(text).toContain("IFCREAL(5.0)");
    expect(text).toContain("IFCREAL(0.2)");
  });

  it("emits IFCLABEL for string args, skips object/array args", () => {
    const elements: IfcSceneElement[] = [
      {
        mesh: minimalMesh(),
        creator: "IfcWall",
        dispatchArgs: { style: "concrete", profile: [[0, 0], [1, 0]], height: 2.5 },
      },
    ];
    const bytes = buildIfcScene(elements);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("'style'");
    expect(text).toContain("IFCLABEL('concrete')");
    expect(text).toContain("'height'");
    expect(text).not.toContain("'profile'"); // array skipped
  });

  it("Pset_GemmaArchitectParams is the property set name", () => {
    const elements: IfcSceneElement[] = [
      { mesh: minimalMesh(), creator: "IfcSlab", dispatchArgs: { thickness: 0.3 } },
    ];
    const bytes = buildIfcScene(elements);
    const text = new TextDecoder().decode(bytes);
    expect(text).toContain("'Pset_GemmaArchitectParams'");
  });

  it("skips property set when all args are non-primitive", () => {
    const elements: IfcSceneElement[] = [
      { mesh: minimalMesh(), creator: "IfcWall", dispatchArgs: { profile: [[0, 0]] } },
    ];
    const bytes = buildIfcScene(elements);
    const text = new TextDecoder().decode(bytes);
    expect(text).not.toContain("IFCPROPERTYSET");
  });
});
