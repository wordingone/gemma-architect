// Hand-rolled minimal markdown renderer for the research-mode document
// viewer. Supports:
//
//   # / ## / ### / #### headings
//   - bullet lists (single level, line-prefix `- `)
//   1. ordered lists (line-prefix `\d+. `)
//   ``` fenced code blocks
//   `inline code`
//   **bold**, *italic*
//   [text](url) links
//   --- horizontal rule
//   blank line = paragraph break
//
// We do not pull `marked` because it adds ~30 KB minified for features
// (tables, footnotes, GFM task lists) we don't render. The fixture
// corpus is well-formed markdown we author ourselves; the renderer is
// matched to the corpus's actual surface.
//
// HIGHLIGHTING: pass `highlightTerms` to wrap each occurrence (case-
// insensitive, word boundary) of any term in `<mark>...</mark>`.
// Used to surface query matches in the doc viewer.

interface RenderOptions {
  highlightTerms?: string[];
}

const ESCAPE_MAP: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#039;",
};

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c]);
}

/** Apply <mark> wraps to every case-insensitive whole-word match. */
function highlight(html: string, terms: string[]): string {
  if (terms.length === 0) return html;
  // Sort longest first to avoid "wall" eating "wallflower" before "wallflower" can match.
  const sorted = [...new Set(terms.map((t) => t.toLowerCase()))]
    .filter((t) => t.length > 1)
    .sort((a, b) => b.length - a.length)
    .map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  if (sorted.length === 0) return html;
  const re = new RegExp(`\\b(${sorted.join("|")})\\b`, "gi");
  // Don't highlight inside HTML tags — split on tag boundaries first.
  return html.replace(/(<[^>]*>)|([^<]+)/g, (_m, tag, text) => {
    if (tag) return tag;
    return text.replace(re, "<mark>$1</mark>");
  });
}

/** Render inline span markup: `code`, **bold**, *italic*, [text](url). */
function renderInline(text: string): string {
  let s = escapeHtml(text);
  // Inline code first (so its content isn't mangled by emphasis).
  s = s.replace(/`([^`]+)`/g, (_m, code) => `<code>${code}</code>`);
  // Links.
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label, url) => {
    return `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`;
  });
  // Bold (** **) before italic (* *) so we don't double-wrap.
  s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  s = s.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  return s;
}

/**
 * Convert a markdown body to HTML with optional <mark> highlighting.
 *
 * The output is intentionally one HTML fragment — no <html>/<body>
 * wrapper — so the caller can drop it inside a styled container.
 */
export function renderMarkdown(md: string, opts: RenderOptions = {}): string {
  const lines = md.split(/\r?\n/);
  const out: string[] = [];

  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    const stripped = line.trim();

    // Fenced code block.
    if (stripped.startsWith("```")) {
      const lang = stripped.slice(3).trim();
      const buf: string[] = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith("```")) {
        buf.push(lines[i]);
        i++;
      }
      i++; // skip closing fence
      const cls = lang ? ` class="lang-${escapeHtml(lang)}"` : "";
      out.push(`<pre><code${cls}>${escapeHtml(buf.join("\n"))}</code></pre>`);
      continue;
    }

    // Headings.
    const heading = /^(#{1,4})\s+(.*)$/.exec(stripped);
    if (heading) {
      const level = heading[1].length;
      out.push(`<h${level}>${renderInline(heading[2])}</h${level}>`);
      i++;
      continue;
    }

    // Horizontal rule.
    if (/^---+\s*$/.test(stripped)) {
      out.push("<hr/>");
      i++;
      continue;
    }

    // Unordered list.
    if (/^[-*]\s+/.test(stripped)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i].trim())) {
        items.push(`<li>${renderInline(lines[i].trim().replace(/^[-*]\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ul>${items.join("")}</ul>`);
      continue;
    }

    // Ordered list.
    if (/^\d+\.\s+/.test(stripped)) {
      const items: string[] = [];
      while (i < lines.length && /^\d+\.\s+/.test(lines[i].trim())) {
        items.push(`<li>${renderInline(lines[i].trim().replace(/^\d+\.\s+/, ""))}</li>`);
        i++;
      }
      out.push(`<ol>${items.join("")}</ol>`);
      continue;
    }

    // Blank line — paragraph break.
    if (stripped === "") {
      i++;
      continue;
    }

    // Plain paragraph: gather contiguous non-blank lines.
    const paraLines: string[] = [stripped];
    i++;
    while (
      i < lines.length &&
      lines[i].trim() !== "" &&
      !/^(#{1,4}|---+|[-*]\s|\d+\.\s|```)/.test(lines[i].trim())
    ) {
      paraLines.push(lines[i].trim());
      i++;
    }
    out.push(`<p>${renderInline(paraLines.join(" "))}</p>`);
  }

  let html = out.join("\n");
  if (opts.highlightTerms && opts.highlightTerms.length > 0) {
    html = highlight(html, opts.highlightTerms);
  }
  return html;
}
