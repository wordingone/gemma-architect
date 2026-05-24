// Drafting-style icon SVG strings — ported from bundle/project/icons.jsx.
// All 1.4 stroke, no fills, geometric. Returns innerHTML strings to inject
// into a <span> wrapper.

const SVG_ATTR = `width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"`;

export function iconSVG(name: string, size = 16): string {
  const attr = `width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"`;
  switch (name) {
    case "select":  return `<svg ${attr}><path d="M5 3l14 8-6 1.5L11 19z"/></svg>`;
    case "move":    return `<svg ${attr}><path d="M12 3v18M3 12h18M9 6l3-3 3 3M9 18l3 3 3-3M6 9l-3 3 3 3M18 9l3 3-3 3"/></svg>`;
    case "rotate":  return `<svg ${attr}><path d="M21 12a9 9 0 1 1-3-6.7"/><path d="M21 4v5h-5"/></svg>`;
    case "scale":   return `<svg ${attr}><path d="M3 21V9M3 21h12M3 21l8-8"/><rect x="14" y="3" width="7" height="7"/></svg>`;
    case "extrude": return `<svg ${attr}><rect x="3" y="9" width="10" height="10"/><path d="M13 9l5-5h-10l-5 5"/><path d="M13 19l5-5V4"/></svg>`;
    case "loft":    return `<svg ${attr}><path d="M3 18c5-3 13-3 18 0M3 6c5 3 13 3 18 0"/><path d="M3 6v12M21 6v12"/></svg>`;
    case "revolve": return `<svg ${attr}><ellipse cx="12" cy="12" rx="9" ry="3"/><path d="M3 12v0M21 12v0M12 3v18"/></svg>`;
    case "boolean": return `<svg ${attr}><circle cx="9" cy="12" r="6"/><circle cx="15" cy="12" r="6"/></svg>`;
    case "sketch":  return `<svg ${attr}><path d="M4 20l8-16 8 16"/><path d="M7 14h10"/></svg>`;
    case "rect":    return `<svg ${attr}><rect x="4" y="6" width="16" height="12"/></svg>`;
    case "circle":  return `<svg ${attr}><circle cx="12" cy="12" r="8"/></svg>`;
    case "polygon": return `<svg ${attr}><path d="M12 3l8 5-3 10H7L4 8z"/></svg>`;
    case "polyline":return `<svg ${attr}><path d="M3 18l5-8 4 5 4-9 5 12"/></svg>`;
    case "line":    return `<svg ${attr}><path d="M4 20L20 4"/><circle cx="4" cy="20" r="1.5"/><circle cx="20" cy="4" r="1.5"/></svg>`;
    case "arc":     return `<svg ${attr}><path d="M3 18a9 9 0 0 1 18 0"/></svg>`;
    case "spline":  return `<svg ${attr}><path d="M3 18c4 0 4-12 9-12s5 12 9 12"/></svg>`;
    case "sweep":   return `<svg ${attr}><path d="M3 17c5-2 10-2 18 0"/><path d="M12 4c0 5 3 9 3 13"/><circle cx="12" cy="4" r="1.5"/></svg>`;
    case "revolve": return `<svg ${attr}><path d="M6 12a6 6 0 0 0 12 0"/><path d="M12 6v12"/><path d="M15 9l-3-3-3 3"/></svg>`;
    case "plane":   return `<svg ${attr}><path d="M3 18L12 6l9 12"/><path d="M3 18h18"/><circle cx="12" cy="6" r="1.5"/></svg>`;
    case "surface": return `<svg ${attr}><path d="M3 18c3-3 6-3 9 0s6 3 9 0"/><path d="M3 12c3-3 6-3 9 0s6 3 9 0"/><path d="M3 6c3-3 6-3 9 0s6 3 9 0"/></svg>`;
    case "bool-union": return `<svg ${attr}><circle cx="9" cy="12" r="6" opacity=".5"/><circle cx="15" cy="12" r="6" opacity=".5"/></svg>`;
    case "bool-diff":  return `<svg ${attr}><circle cx="9" cy="12" r="6" opacity=".5"/><circle cx="15" cy="12" r="6" opacity=".2"/><path d="M12 6.5a6 6 0 0 0 0 11" fill="none"/></svg>`;
    case "bool-intersect": return `<svg ${attr}><circle cx="9" cy="12" r="6" opacity=".2"/><circle cx="15" cy="12" r="6" opacity=".2"/><path d="M12 6.5a6 6 0 0 1 0 11 6 6 0 0 1 0-11Z" opacity=".8"/></svg>`;
    case "fillet":  return `<svg ${attr}><path d="M3 21V9a6 6 0 0 1 6-6h12"/></svg>`;
    case "chamfer": return `<svg ${attr}><path d="M3 21V11l8-8h10"/></svg>`;
    case "wall":    return `<svg ${attr}><rect x="3" y="6" width="18" height="12"/><path d="M9 6v12M15 6v12"/></svg>`;
    case "slab":    return `<svg ${attr}><path d="M3 16l9-4 9 4-9 4z"/><path d="M3 16v-2l9-4 9 4v2"/></svg>`;
    case "column":  return `<svg ${attr}><rect x="9" y="4" width="6" height="16"/><path d="M7 4h10M7 20h10"/></svg>`;
    case "stair":   return `<svg ${attr}><path d="M3 21h6v-4h6v-4h6v-4"/></svg>`;
    case "door":    return `<svg ${attr}><path d="M4 21V4h10v17"/><path d="M4 21a10 10 0 0 1 10-10"/></svg>`;
    case "window":  return `<svg ${attr}><rect x="4" y="4" width="16" height="16"/><path d="M12 4v16M4 12h16"/></svg>`;
    case "split-h": return `<svg ${attr}><rect x="3" y="3" width="18" height="18"/><path d="M3 12h18"/></svg>`;
    case "split-v": return `<svg ${attr}><rect x="3" y="3" width="18" height="18"/><path d="M12 3v18"/></svg>`;
    case "split-quad": return `<svg ${attr}><rect x="3" y="3" width="18" height="18"/><path d="M3 12h18M12 3v18"/></svg>`;
    case "split-single": return `<svg ${attr}><rect x="3" y="3" width="18" height="18"/></svg>`;
    case "eye":     return `<svg ${attr}><path d="M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>`;
    case "eye-off": return `<svg ${attr}><path d="M3 3l18 18M10.6 10.6a2 2 0 0 0 2.8 2.8M9.9 5.1A10.1 10.1 0 0 1 12 5c6 0 10 7 10 7a17.6 17.6 0 0 1-3.1 4M6.5 6.5C3.7 8.4 2 12 2 12s4 7 10 7c1.6 0 3-.4 4.3-1"/></svg>`;
    case "lock":    return `<svg ${attr}><rect x="5" y="11" width="14" height="10"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>`;
    case "render":  return `<svg ${attr}><circle cx="12" cy="12" r="9"/><path d="M12 3v9l6 4"/></svg>`;
    case "wire":    return `<svg ${attr}><path d="M3 6l9-3 9 3v12l-9 3-9-3z"/><path d="M3 6l9 3 9-3M12 9v12"/></svg>`;
    case "shaded":  return `<svg ${attr}><circle cx="12" cy="12" r="9"/><path d="M12 3a9 9 0 0 0 0 18"/></svg>`;
    case "ortho":   return `<svg ${attr}><rect x="3" y="3" width="18" height="18"/></svg>`;
    case "persp":   return `<svg ${attr}><path d="M3 6l18-3v18l-18 3z"/></svg>`;
    case "grid":    return `<svg ${attr}><rect x="3" y="3" width="18" height="18"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18"/></svg>`;
    case "snap":    return `<svg ${attr}><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/><circle cx="12" cy="12" r="2.5"/></svg>`;
    case "axis":    return `<svg ${attr}><path d="M4 20V4M4 20h16M4 20l-2-2M4 4l-2 2M4 4l2 2M20 20l2 2M20 20l-2-2"/></svg>`;
    case "play":    return `<svg ${attr}><path d="M6 4l14 8-14 8z"/></svg>`;
    case "pause":   return `<svg ${attr}><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>`;
    case "settings":return `<svg ${attr}><circle cx="12" cy="12" r="3"/><path d="M19 12a7 7 0 0 0-.1-1.2l2-1.6-2-3.4-2.4.8a7 7 0 0 0-2-1.2L14 3h-4l-.5 2.4a7 7 0 0 0-2 1.2L5.1 5.8l-2 3.4 2 1.6A7 7 0 0 0 5 12a7 7 0 0 0 .1 1.2l-2 1.6 2 3.4 2.4-.8a7 7 0 0 0 2 1.2L10 21h4l.5-2.4a7 7 0 0 0 2-1.2l2.4.8 2-3.4-2-1.6c.1-.4.1-.8.1-1.2z"/></svg>`;
    case "search":  return `<svg ${attr}><circle cx="11" cy="11" r="7"/><path d="M21 21l-5-5"/></svg>`;
    case "x":       return `<svg ${attr}><path d="M5 5l14 14M19 5L5 19"/></svg>`;
    case "chevron-down": return `<svg ${attr}><path d="M6 9l6 6 6-6"/></svg>`;
    case "chevron-right":return `<svg ${attr}><path d="M9 6l6 6-6 6"/></svg>`;
    case "plus":    return `<svg ${attr}><path d="M12 5v14M5 12h14"/></svg>`;
    case "minus":   return `<svg ${attr}><path d="M5 12h14"/></svg>`;
    case "trash":   return `<svg ${attr}><path d="M3 6h18M8 6V4h8v2M6 6l1 14h10l1-14"/></svg>`;
    case "command": return `<svg ${attr}><path d="M9 6a3 3 0 1 0-3 3h12a3 3 0 1 0-3-3v12a3 3 0 1 0 3-3H6a3 3 0 1 0 3 3z"/></svg>`;
    case "terminal":return `<svg ${attr}><rect x="3" y="4" width="18" height="16"/><path d="M7 9l3 3-3 3M13 15h4"/></svg>`;
    case "graph":   return `<svg ${attr}><circle cx="6" cy="6" r="2.5"/><circle cx="18" cy="6" r="2.5"/><circle cx="12" cy="18" r="2.5"/><path d="M8 7l3 9M16 7l-3 9"/></svg>`;
    case "sliders": return `<svg ${attr}><path d="M4 6h10M18 6h2M4 12h4M12 12h8M4 18h12M20 18h0"/><circle cx="14" cy="6" r="2"/><circle cx="10" cy="12" r="2"/><circle cx="18" cy="18" r="2"/></svg>`;
    case "export":  return `<svg ${attr}><path d="M12 3v12M7 8l5-5 5 5M5 21h14"/></svg>`;
    case "import":  return `<svg ${attr}><path d="M12 15V3M7 10l5 5 5-5M5 21h14"/></svg>`;
    case "save":    return `<svg ${attr}><path d="M5 3h11l4 4v14H5z"/><path d="M8 3v6h8V3M8 21v-7h8v7"/></svg>`;
    case "folder":  return `<svg ${attr}><path d="M3 6h6l2 3h10v10H3z"/></svg>`;
    case "layers":  return `<svg ${attr}><path d="M12 3l9 5-9 5-9-5z"/><path d="M3 13l9 5 9-5M3 18l9 5 9-5"/></svg>`;
    case "info":    return `<svg ${attr}><circle cx="12" cy="12" r="9"/><path d="M12 11v5M12 8v.01"/></svg>`;
    case "sparkle": return `<svg ${attr}><path d="M12 3l1.7 5.3L19 10l-5.3 1.7L12 17l-1.7-5.3L5 10l5.3-1.7zM18 17l.8 2.4L21 20l-2.2.6L18 23l-.8-2.4L15 20l2.2-.6z"/></svg>`;
    case "model":   return `<svg ${attr}><path d="M3 7l9-4 9 4-9 4z"/><path d="M3 7v10l9 4M21 7v10l-9 4"/></svg>`;
    case "globe":   return `<svg ${attr}><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3a14 14 0 0 1 0 18M12 3a14 14 0 0 0 0 18"/></svg>`;
    case "ruler":   return `<svg ${attr}><path d="M3 17L17 3l4 4L7 21z"/><path d="M7 13l2 2M11 9l2 2M15 5l2 2"/></svg>`;
    case "compass": return `<svg ${attr}><circle cx="12" cy="12" r="9"/><path d="M16 8l-2 6-6 2 2-6z"/></svg>`;
    case "target":  return `<svg ${attr}><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="5"/><circle cx="12" cy="12" r="1"/></svg>`;
    case "history": return `<svg ${attr}><path d="M3 12a9 9 0 1 0 3-6.7"/><path d="M3 4v5h5"/><path d="M12 7v5l3 3"/></svg>`;
    case "link":    return `<svg ${attr}><path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.5 1.5"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.5-1.5"/></svg>`;
    case "pan":     return `<svg ${attr}><path d="M12 3l-2 3h4zM12 21l2-3h-4zM3 12l3 2v-4zM21 12l-3-2v4z"/></svg>`;
    case "text":    return `<svg ${attr}><path d="M5 5h14M12 5v14M9 19h6"/></svg>`;
    case "leader":  return `<svg ${attr}><path d="M4 20l9-9M17 7l3-3M17 7h3v3"/></svg>`;
    case "frame":   return `<svg ${attr}><rect x="3" y="3" width="18" height="18"/><path d="M3 8h18M3 16h18M8 3v18M16 3v18" opacity="0.35"/></svg>`;
    case "callout": return `<svg ${attr}><rect x="3" y="4" width="15" height="11" rx="1"/><path d="M8 15l-3 4 6-2"/></svg>`;
    case "viewport":return `<svg ${attr}><rect x="3" y="3" width="18" height="18" rx="1" stroke-dasharray="3 2"/><path d="M9 3v18M15 3v18M3 9h18M3 15h18" opacity="0.35"/></svg>`;
    case "detail":  return `<svg ${attr}><rect x="2" y="2" width="9" height="9" stroke-dasharray="2 1.5"/><circle cx="15" cy="15" r="6"/><path d="M10 10l5 5"/><path d="M13 15h4M15 13v4"/></svg>`;
    case "point":   return `<svg ${attr}><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2" fill="currentColor"/></svg>`;
    case "curve":   return `<svg ${attr}><path d="M3 18c4 0 4-12 9-12s5 12 9 12"/></svg>`;
    case "aligned-dim":       return `<svg ${attr}><path d="M3 12h18"/><path d="M5 7v10M19 7v10"/><path d="M5 12l3-3M5 12l3 3M19 12l-3-3M19 12l-3 3" stroke-width="0.9"/></svg>`;
    case "angular-dim":       return `<svg ${attr}><path d="M8 19V8l8 0"/><path d="M8 13a6 6 0 0 1 5.2-5.9"/></svg>`;
    case "area-dim":          return `<svg ${attr}><rect x="4" y="5" width="16" height="14"/><path d="M7 9h10M7 13h10M7 17h4" stroke-width="0.9"/></svg>`;
    case "volume-dim":        return `<svg ${attr}><path d="M4 16l7-3 7 3v-7l-7-4-7 4z"/><path d="M4 9l7 3 7-3M11 12v7"/></svg>`;
    case "label":             return `<svg ${attr}><path d="M3 8h11l4 4-4 4H3z"/></svg>`;
    case "transient-measure": return `<svg ${attr}><path d="M3 12h18" stroke-dasharray="3 2"/><path d="M5 8v8M19 8v8"/></svg>`;
    case "beam":         return `<svg ${attr}><path d="M7 4h10M7 20h10M9 4v16M15 4v16"/></svg>`;
    case "roof":         return `<svg ${attr}><path d="M2 17l10-12 10 12H2z"/></svg>`;
    case "space":        return `<svg ${attr}><rect x="3" y="5" width="18" height="14" stroke-dasharray="4 2"/><path d="M8 12h8" stroke-width="0.9"/></svg>`;
    case "foundation":   return `<svg ${attr}><rect x="4" y="11" width="16" height="5"/><path d="M4 16l2 3M8 16l2 3M12 16l2 3M16 16l2 3"/></svg>`;
    case "ceiling":      return `<svg ${attr}><path d="M3 7h18M3 11h18"/><path d="M7 7v4M12 7v4M17 7v4" stroke-width="0.9"/></svg>`;
    case "curtainwall":  return `<svg ${attr}><rect x="3" y="3" width="18" height="18"/><path d="M3 10h18M3 17h18M12 3v18" stroke-width="0.9"/></svg>`;
    case "skylight":     return `<svg ${attr}><rect x="6" y="6" width="12" height="12"/><path d="M6 6l-3-3M18 6l3-3M6 18l-3 3M18 18l3 3M12 6v-2M12 18v2M6 12h-2M18 12h2" stroke-width="0.9"/></svg>`;
    case "opening":      return `<svg ${attr}><rect x="4" y="4" width="16" height="16"/><rect x="8" y="8" width="8" height="8" stroke-dasharray="2 1.5"/></svg>`;
    case "ramp":         return `<svg ${attr}><path d="M4 20h16M4 20L20 7"/><path d="M14 7h6v5"/></svg>`;
    case "railing":      return `<svg ${attr}><path d="M3 8h18M3 15h18"/><path d="M7 8v7M12 8v7M17 8v7"/></svg>`;
    case "level":        return `<svg ${attr}><path d="M3 13h18"/><path d="M17 9v8M20 9l-3-2-3 2" stroke-width="0.9"/></svg>`;
    case "datum":        return `<svg ${attr}><path d="M12 5l8 13H4z"/><path d="M4 18h16"/></svg>`;
    case "copy":         return `<svg ${attr}><rect x="9" y="9" width="11" height="11"/><path d="M4 15V4h11"/></svg>`;
    case "array":        return `<svg ${attr}><circle cx="5" cy="5" r="2"/><circle cx="12" cy="5" r="2"/><circle cx="19" cy="5" r="2"/><circle cx="5" cy="12" r="2"/><circle cx="12" cy="12" r="2"/><circle cx="19" cy="12" r="2"/><circle cx="5" cy="19" r="2"/><circle cx="12" cy="19" r="2"/><circle cx="19" cy="19" r="2"/></svg>`;
    default:        return `<svg ${attr}><rect x="4" y="4" width="16" height="16"/></svg>`;
  }
}

export function axesGizmoSVG(): string {
  return `<svg width="48" height="48" viewBox="0 0 48 48" fill="none" aria-hidden="true">
    <g transform="translate(24 30)">
      <line x1="0" y1="0" x2="0" y2="-16" stroke="oklch(0.55 0.18 250)" stroke-width="1.5"/>
      <text x="2" y="-16" font-size="8" fill="oklch(0.55 0.18 250)" font-family="monospace">Z</text>
      <line x1="0" y1="0" x2="11" y2="-6" stroke="oklch(0.5 0.18 145)" stroke-width="1.5"/>
      <text x="13" y="-7" font-size="8" fill="oklch(0.5 0.18 145)" font-family="monospace">Y</text>
      <line x1="0" y1="0" x2="14" y2="6" stroke="oklch(0.55 0.18 25)" stroke-width="1.5"/>
      <text x="16" y="9" font-size="8" fill="oklch(0.55 0.18 25)" font-family="monospace">X</text>
      <circle cx="0" cy="0" r="2" fill="oklch(0.22 0.015 250)"/>
    </g>
  </svg>`;
}
