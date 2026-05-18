# Spatial API — License + Copyright Analysis

The Spatial API at `spatial-api.yaml` is independently authored
by the gemma-architect team. Functional verbs (`line`, `extrude`, `move`,
`rotate`, `boolean union`, `fillet`, `chamfer`, ...) are the working
vocabulary of computer-aided geometric modeling — they are NOT creative
invention by any specific CAD vendor.

## Three independent legal foundations

### 1. 17 U.S.C. § 102(b) — functional non-protectability

> In no case does copyright protection for an original work of authorship
> extend to any idea, procedure, process, system, method of operation,
> concept, principle, or discovery, regardless of the form in which it is
> described, explained, illustrated, or embodied in such work.

A command verb that names a geometric operation IS a method of operation.
Single-word geometric verbs fall on the unprotectable side of this line
cleanly.

### 2. *Lotus Development Corp. v. Borland International*, 49 F.3d 807 (1st Cir. 1995)

Affirmed by an equally divided Supreme Court (516 U.S. 233, 1996). Held
that a menu/command hierarchy is "a method of operation" within the
meaning of § 102(b) and is therefore uncopyrightable. The First Circuit
reasoned:

> The Lotus menu command hierarchy is also a method of operation in a
> different respect. Users employ the Lotus menu command hierarchy ... to
> control the workings of the Lotus Spreadsheet ... we hold that the
> Lotus menu command hierarchy is uncopyrightable subject matter.

Single command verbs — `line`, `extrude`, `move` — are an even cleaner
case than menu hierarchies.

### 3. Scènes à faire — *Hoehling v. Universal City Studios*, 618 F.2d 972 (2d Cir. 1980)

Standard elements of a domain that are functionally necessary cannot be
protected. The geometric-modeling domain mandates verbs for: drawing
primitives (`line`, `arc`, `circle`), extrusion/revolution (`extrude`,
`revolve`), boolean operations (`union`, `difference`, `intersection`),
edge softening (`fillet`, `chamfer`), and rigid transforms (`move`,
`rotate`, `scale`). These are scènes à faire of CAD.

### 4. Merger doctrine — *Baker v. Selden*, 101 U.S. 99 (1879)

When idea and expression have very few possible articulations, they
"merge" and copyright doesn't protect the resulting expression. There is
no other natural one-word English verb for "extruding a profile along a
vector" — it's `extrude` or nothing. Same for `fillet` (rounding an
edge), `chamfer` (beveling an edge), `loft` (skinning a surface across
profiles). When idea and expression merge, expression is not protected.

### 5. *Oracle America, Inc. v. Google LLC*, 593 U.S. ___ (2021)

The Supreme Court held that Google's reuse of declaring code (method
signatures + names) for the Java API constituted fair use. While the
ruling is a fair-use holding rather than a § 102(b) holding, it
strengthens the position that a programming-style functional vocabulary
is not the kind of creative expression that copyright was designed to
protect.

## Trademark — separately handled, separately respected

Brand-identifier tokens (`Rhino`, `AutoCAD`, `Revit`, `SketchUp`,
`Blender`, `Solidworks`, `Fusion 360`) are protectable trademarks for
software products. The functional verbs those products implement are
NOT. We keep brand names entirely out of the spatial dictionary's
synonym set. The brand-name denylist lives at
`web/src/trademark-denylist.json` and is enforced by
`scripts/audit-aliases.ts` at pre-commit + CI.

We also avoid vendor-specific compound tokens such as `_BlockEdit`
(Rhino), `_PEDIT` (AutoCAD), `RevitLink`, `MotionPath`, etc. These are
distinctive enough that even though the underlying operation may be a
scène à faire, the specific compound token is associated with one
vendor's product and might trigger trademark concerns. The audit-script
denylist covers these too.

## Independent authorship

The alias table was authored from scratch using generic English verbs
and IFC4 canonical names. Public Rhino / AutoCAD / Revit / Blender
command lists were consulted ONLY to identify operations the spatial
dictionary was missing — to fill gaps in our taxonomy, not to copy
theirs. No alias row was ported verbatim. Every entry is checked
against:

1. The IFC4 schema (canonical_name + ifc4_class).
2. The replicad fluent API (kernel_op + args).
3. The verb-nurbs evaluator (nurbs-webgpu kernel ops).

## Cross-reference: NURBS toolkit lineage

The WebGPU kernel in `nurbs-kernel.ts` (line 412+) is hand-rolled WGSL, not
verb-nurbs. NURBS itself is public-domain mathematics from Versprille's 1975
PhD thesis. verb-nurbs is an MIT-licensed library declared as a package
dependency but not used on the WebGPU code path.

## Summary

The spatial dictionary contains:
- **Functional verbs** (`line`, `extrude`, ...) — uncopyrightable per
  § 102(b) + *Lotus v. Borland* + scènes à faire + merger.
- **IFC4 canonical names** (`IfcWall`, `IfcRelVoidsElement`, ...) —
  these are an open standard published by buildingSMART under
  CC-BY-ND 4.0; canonical names are functionally necessary identifiers
  and naming them in code is non-infringing under § 102(b) + standards
  exception.
- **Kernel operation names** (`makeWall`, `extrudeProfile`, ...) — these
  are our own internal identifiers, defined by us.

No vendor-trademarked compound tokens. No brand names. No verbatim
ports. Independent authorship of unprotectable functional elements.
