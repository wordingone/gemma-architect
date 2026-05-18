# NURBS Kernel — License + IP Notes

## Status

NURBS (Non-Uniform Rational B-Splines) is a public-domain mathematical
construct. The math is procedure, not expression. NURBS itself is not
copyrighted, and the standard knot-vector / Cox-de Boor / rational-surface
formulations have been in standardized industry schemas for decades:

- **IGES** — Initial Graphics Exchange Specification (1980), NBS / ANSI.
- **STEP / ISO 10303-42** — Geometric and topological representation.
- **IFC4** — IfcBSplineSurfaceWithKnots, IfcRationalBSplineSurfaceWithKnots.

Per **17 U.S.C. § 102(b)**, "in no case does copyright protection ... extend
to any idea, procedure, process, system, method of operation, concept,
principle, or discovery, regardless of the form in which it is described,
explained, illustrated, or embodied in such work." See also *Baker v. Selden*,
101 U.S. 99 (1879) — mathematical procedures and notation systems are not
the proper subject of copyright.

The NURBS evaluator in `nurbs-kernel.ts` is a clean-room implementation of
the standard Cox-de Boor recurrence and rational surface evaluation as
documented in:

> Piegl, L. & Tiller, W. (1997). **The NURBS Book** (2nd ed.). Springer.

## Third-party dependencies

### verb-nurbs (MIT)

```
The MIT License (MIT)

Copyright (c) Peter Boyer 2014-6

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in
all copies or substantial portions of the Software.
```

verb-nurbs's lineage traces back to the open-source NURBS toolkit released
by Robert McNeel & Associates as part of the Rhino ecosystem — that toolkit
is also MIT-licensed. We cite that lineage once here for historical context;
the gemma-architect codebase does not use the Rhino name elsewhere.

The WebGPU kernel path in `nurbs-kernel.ts` (line 412+) is hand-rolled WGSL;
verb-nurbs is declared as a package dependency but is not on the import path.
The Bun test path uses our hand-rolled Cox-de Boor evaluator.

### web-ifc (MPL-2.0)

For IFC parse / round-trip. Used unmodified.

### replicad / replicad-opencascadejs (LGPL-2.1, OpenCascade)

For boolean / fillet / chamfer ops. NURBS-native implementations of these
remain follow-up work. OpenCascade's NURBS evaluator is not used by this
kernel — we have our own.

## Patent considerations

NURBS basis function evaluation, knot insertion, degree elevation, and
adaptive tessellation are all subjects of >30-year-old academic literature.
No patents on the core mathematical formulations are known to apply to the
clean-room evaluator in `nurbs-kernel.ts`. If a specific algorithm in a
future revision risks patent encumbrance (e.g. some recent surface-fairing
or skinning method), it must cite the patent and its expiry status before
landing.

## Summary

- **NURBS math itself**: public domain.
- **This kernel's evaluator code**: clean-room, written for gemma-architect.
- **verb-nurbs (optional dep)**: MIT, attributed above.
- **OpenCascade (replicad)**: LGPL-2.1, attributed via replicad's own license.
