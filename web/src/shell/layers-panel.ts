// layers-panel.ts — Layout-tab layers panel (#1854).
// Illustrator/Rhino-style: visible, locked, color, lineweight, linetype, print-width.

import { drawingLayerStore, LINEWEIGHTS, LINETYPES, type DrawingLayer } from "../geometry/drawing-layers";

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K, cls?: string, attrs?: Record<string, string>
): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (attrs) for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, v);
  return e;
}

const EYE_ON  = `<svg width="14" height="10" viewBox="0 0 14 10" fill="none"><ellipse cx="7" cy="5" rx="6" ry="4" stroke="currentColor"/><circle cx="7" cy="5" r="2" fill="currentColor"/></svg>`;
const EYE_OFF = `<svg width="14" height="10" viewBox="0 0 14 10" fill="none"><ellipse cx="7" cy="5" rx="6" ry="4" stroke="currentColor" stroke-dasharray="2 1.5"/><line x1="2" y1="9" x2="12" y2="1" stroke="currentColor"/></svg>`;
const LOCK_ON  = `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="5" width="8" height="7" rx="1" stroke="currentColor"/><path d="M3 5V3.5a2 2 0 014 0V5" stroke="currentColor"/></svg>`;
const LOCK_OFF = `<svg width="10" height="12" viewBox="0 0 10 12" fill="none"><rect x="1" y="5" width="8" height="7" rx="1" stroke="currentColor" stroke-dasharray="2 1.5"/><path d="M3 5V3.5a2 2 0 014 0V5" stroke="currentColor"/></svg>`;

export function buildLayoutLayersPanel(host: HTMLElement): void {
  host.innerHTML = "";
  host.style.cssText = "display:flex; flex-direction:column; height:100%; min-height:0; overflow:hidden;";

  // ── Header ────────────────────────────────────────────────────────────────
  const header = el("div");
  header.style.cssText = [
    "display:flex", "align-items:center", "justify-content:space-between",
    "padding:6px 8px", "flex-shrink:0",
    "border-bottom:var(--lw-edge) solid var(--chrome-seam)",
    "background:var(--glass-bg)",
  ].join(";");

  const title = el("span");
  title.style.cssText = "font-size:9.5px; letter-spacing:0.14em; text-transform:uppercase; color:var(--ink-dim); font-weight:700;";
  title.textContent = "LAYERS";

  const addBtn = el("button");
  addBtn.style.cssText = "background:none; border:1px solid var(--hairline); border-radius:2px; color:var(--ink); cursor:pointer; padding:0 6px; line-height:16px; font-size:12px;";
  addBtn.title = "New layer";
  addBtn.textContent = "+";
  addBtn.addEventListener("click", () => {
    drawingLayerStore.add(`Layer ${drawingLayerStore.all().length + 1}`);
  });

  header.appendChild(title);
  header.appendChild(addBtn);
  host.appendChild(header);

  // ── Column headers ────────────────────────────────────────────────────────
  const colHdr = el("div");
  colHdr.style.cssText = [
    "display:grid",
    "grid-template-columns:16px 16px 16px 40px 60px 36px 1fr 16px",
    "gap:2px", "padding:2px 8px",
    "border-bottom:1px solid var(--hairline)",
    "background:var(--paper-2)",
    "flex-shrink:0",
  ].join(";");
  ["", "", "", "LW", "LINETYPE", "PW", "NAME", ""].forEach((t) => {
    const c = el("span");
    c.style.cssText = "font-size:8px; letter-spacing:0.10em; text-transform:uppercase; color:var(--ink-faint); white-space:nowrap; overflow:hidden; text-overflow:ellipsis;";
    c.textContent = t;
    colHdr.appendChild(c);
  });
  host.appendChild(colHdr);

  // ── List ──────────────────────────────────────────────────────────────────
  const list = el("div");
  list.style.cssText = "flex:1; overflow-y:auto; min-height:0;";
  host.appendChild(list);

  function renderList(): void {
    list.innerHTML = "";
    const activeId = drawingLayerStore.getActiveId();

    for (const layer of drawingLayerStore.all()) {
      const isActive  = layer.id === activeId;
      const isDefault = layer.id === "default";

      const row = el("div", "", { "data-layer-id": layer.id });
      row.style.cssText = [
        "display:grid",
        "grid-template-columns:16px 16px 16px 40px 60px 36px 1fr 16px",
        "gap:2px", "align-items:center", "padding:2px 8px",
        "border-bottom:1px solid var(--hairline)",
        "min-height:26px", "cursor:pointer",
        isActive ? "background:var(--paper-3);" : "",
        isActive ? "border-left:2px solid var(--sanguine);" : "border-left:2px solid transparent;",
      ].join(";");

      // Eye toggle
      const eyeBtn = el("button");
      eyeBtn.style.cssText = "background:none;border:none;cursor:pointer;padding:0;color:var(--ink);opacity:" + (layer.visible ? "1" : "0.3") + ";display:flex;align-items:center;";
      eyeBtn.title = layer.visible ? "Hide" : "Show";
      eyeBtn.innerHTML = layer.visible ? EYE_ON : EYE_OFF;
      eyeBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        drawingLayerStore.setVisible(layer.id, !layer.visible);
        _syncVisibility(layer.id, !layer.visible);
      });

      // Lock toggle
      const lockBtn = el("button");
      lockBtn.style.cssText = "background:none;border:none;cursor:pointer;padding:0;color:var(--ink);opacity:" + (layer.locked ? "1" : "0.3") + ";display:flex;align-items:center;";
      lockBtn.title = layer.locked ? "Unlock" : "Lock";
      lockBtn.innerHTML = layer.locked ? LOCK_ON : LOCK_OFF;
      lockBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        drawingLayerStore.setLocked(layer.id, !layer.locked);
      });

      // Color swatch
      const colorInput = document.createElement("input");
      colorInput.type = "color";
      colorInput.value = layer.color;
      colorInput.style.cssText = "width:14px;height:14px;border:none;padding:0;cursor:pointer;border-radius:2px;";
      colorInput.title = "Layer color";
      colorInput.addEventListener("change", (e) => {
        e.stopPropagation();
        drawingLayerStore.setColor(layer.id, (e.target as HTMLInputElement).value);
      });

      // Lineweight select
      const lwSel = el("select") as HTMLSelectElement;
      lwSel.style.cssText = "font-size:9px;font-family:var(--mono);background:transparent;border:1px solid var(--hairline);color:var(--ink);padding:1px 2px;width:38px;border-radius:2px;";
      lwSel.title = "Lineweight (mm)";
      for (const lw of LINEWEIGHTS) {
        const opt = document.createElement("option");
        opt.value = String(lw);
        opt.textContent = lw === 0 ? "ByLayer" : lw.toFixed(2);
        if (lw === layer.lineweight) opt.selected = true;
        lwSel.appendChild(opt);
      }
      lwSel.addEventListener("change", (e) => {
        e.stopPropagation();
        drawingLayerStore.setLineweight(layer.id, parseFloat((e.target as HTMLSelectElement).value));
      });

      // Linetype select
      const ltSel = el("select") as HTMLSelectElement;
      ltSel.style.cssText = "font-size:9px;font-family:var(--mono);background:transparent;border:1px solid var(--hairline);color:var(--ink);padding:1px 2px;width:58px;border-radius:2px;overflow:hidden;";
      ltSel.title = "Linetype";
      for (const lt of LINETYPES) {
        const opt = document.createElement("option");
        opt.value = lt;
        opt.textContent = lt;
        if (lt === layer.linetype) opt.selected = true;
        ltSel.appendChild(opt);
      }
      ltSel.addEventListener("change", (e) => {
        e.stopPropagation();
        drawingLayerStore.setLinetype(layer.id, (e.target as HTMLSelectElement).value as typeof LINETYPES[number]);
      });

      // Print-width select
      const pwSel = el("select") as HTMLSelectElement;
      pwSel.style.cssText = "font-size:9px;font-family:var(--mono);background:transparent;border:1px solid var(--hairline);color:var(--ink);padding:1px 2px;width:34px;border-radius:2px;";
      pwSel.title = "Print width (mm)";
      for (const lw of LINEWEIGHTS) {
        const opt = document.createElement("option");
        opt.value = String(lw);
        opt.textContent = lw === 0 ? "ByLyr" : lw.toFixed(2);
        if (lw === layer.printWidth) opt.selected = true;
        pwSel.appendChild(opt);
      }
      pwSel.addEventListener("change", (e) => {
        e.stopPropagation();
        drawingLayerStore.setPrintWidth(layer.id, parseFloat((e.target as HTMLSelectElement).value));
      });

      // Name (double-click to rename)
      const nameEl = el("span");
      nameEl.style.cssText = "font-size:11px;color:var(--ink);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;" + (isActive ? "font-weight:700;" : "");
      nameEl.textContent = layer.name;
      nameEl.addEventListener("dblclick", (e) => {
        e.stopPropagation();
        const input = document.createElement("input");
        input.value = layer.name;
        input.style.cssText = "font-size:11px;border:1px solid var(--sanguine);border-radius:2px;padding:0 2px;width:100%;box-sizing:border-box;";
        nameEl.replaceWith(input);
        input.focus();
        input.select();
        const commit = (): void => { drawingLayerStore.rename(layer.id, input.value); };
        input.addEventListener("blur", commit);
        input.addEventListener("keydown", (ke) => {
          if (ke.key === "Enter") { commit(); input.blur(); }
          if (ke.key === "Escape") input.blur();
        });
      });

      // Delete button
      const delBtn = el("button") as HTMLButtonElement;
      delBtn.style.cssText = "background:none;border:none;cursor:" + (isDefault ? "default" : "pointer") + ";color:var(--ink-dim);opacity:" + (isDefault ? "0.15" : "0.5") + ";padding:0;font-size:13px;line-height:1;";
      delBtn.title = isDefault ? "Default layer cannot be deleted" : "Delete layer";
      delBtn.textContent = "×";
      delBtn.disabled = isDefault;
      delBtn.addEventListener("click", (e) => {
        e.stopPropagation();
        if (!isDefault) drawingLayerStore.remove(layer.id);
      });

      row.appendChild(eyeBtn);
      row.appendChild(lockBtn);
      row.appendChild(colorInput);
      row.appendChild(lwSel);
      row.appendChild(ltSel);
      row.appendChild(pwSel);
      row.appendChild(nameEl);
      row.appendChild(delBtn);

      row.addEventListener("click", () => drawingLayerStore.setActive(layer.id));
      list.appendChild(row);
    }

    if (drawingLayerStore.all().length === 0) {
      const empty = el("div");
      empty.style.cssText = "padding:12px 8px; font-size:11px; color:var(--ink-faint);";
      empty.textContent = "No layers";
      list.appendChild(empty);
    }
  }

  drawingLayerStore.subscribe(renderList);
  renderList();
}

function _syncVisibility(id: string, visible: boolean): void {
  const v = (window as unknown as { __viewer?: { forEachSceneChild: (fn: (o: { userData: Record<string, unknown>; visible: boolean }) => void) => void } }).__viewer;
  if (!v) return;
  v.forEachSceneChild((obj) => {
    if (obj.userData.drawingLayerId === id) obj.visible = visible;
  });
}
