// skill-modal.ts — Modal UI for naming and saving a skill from session dispatches.

import type { SkillStep } from "./skill-store";
import { saveSkill, saveCluster, saveCanvasCluster } from "./skill-store";

function escHtml(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

export function openSaveSkillModal(steps: SkillStep[]): void {
  if (steps.length === 0) return;

  const overlay = document.createElement("div");
  overlay.className = "skill-modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Save skill");

  overlay.innerHTML = `
    <div class="skill-modal">
      <div class="skill-modal-header">
        <span class="skill-modal-title">Save as Skill</span>
        <button class="skill-modal-close" aria-label="Close" type="button">✕</button>
      </div>
      <div class="skill-modal-body">
        <label class="skill-modal-label">Name
          <input class="skill-modal-name" type="text" placeholder="e.g. L-shaped wall" maxlength="80" />
        </label>
        <label class="skill-modal-label">Description
          <input class="skill-modal-desc" type="text" placeholder="What this skill builds" maxlength="200" />
        </label>
        <div class="skill-modal-steps-label">Steps (${steps.length})</div>
        <div class="skill-modal-steps">
          ${steps.map((s, i) => `
            <div class="skill-modal-step">
              <span class="skill-modal-step-num">${i + 1}</span>
              <span class="skill-modal-step-verb">${escHtml(s.verb)}</span>
              <span class="skill-modal-step-args">${escHtml(
                Object.entries(s.args)
                  .filter(([k]) => !["canonical", "kernel"].includes(k))
                  .map(([k, v]) => `${k}: ${typeof v === "object" ? JSON.stringify(v) : v}`)
                  .slice(0, 3)
                  .join("  ·  ")
              )}</span>
            </div>
          `).join("")}
        </div>
      </div>
      <div class="skill-modal-footer">
        <button class="btn btn-sm skill-modal-cancel" type="button">Cancel</button>
        <button class="btn btn-accent btn-sm skill-modal-save" type="button">Save skill</button>
      </div>
    </div>
  `;

  const nameInput = overlay.querySelector<HTMLInputElement>(".skill-modal-name")!;
  const descInput = overlay.querySelector<HTMLInputElement>(".skill-modal-desc")!;
  const saveBtn   = overlay.querySelector<HTMLButtonElement>(".skill-modal-save")!;
  const closeBtn  = overlay.querySelector<HTMLButtonElement>(".skill-modal-close")!;
  const cancelBtn = overlay.querySelector<HTMLButtonElement>(".skill-modal-cancel")!;

  const close = () => overlay.remove();

  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const skill = await saveSkill({ name, description: descInput.value.trim(), steps });
      // Also save as a SkillCluster so the agent can invoke it via SdRunCluster({name}).
      await saveCluster({ name, steps: steps.map((s, i) => ({ verb: s.verb, params: s.args, relativeTs: i * 100 })) });
      window.dispatchEvent(new CustomEvent("skillstore:saved", { detail: { skill } }));
      close();
    } catch {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save skill";
    }
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(() => nameInput.focus());
}

export function openSaveClusterModal(
  graphJson: string,
  nodeCount: number,
  edgeCount: number,
  onSaved: (id: string) => void,
): void {
  const overlay = document.createElement("div");
  overlay.className = "skill-modal-overlay";
  overlay.setAttribute("role", "dialog");
  overlay.setAttribute("aria-modal", "true");
  overlay.setAttribute("aria-label", "Save cluster");

  overlay.innerHTML = `
    <div class="skill-modal">
      <div class="skill-modal-header">
        <span class="skill-modal-title">Save as Cluster</span>
        <button class="skill-modal-close" aria-label="Close" type="button">✕</button>
      </div>
      <div class="skill-modal-body">
        <label class="skill-modal-label">Name
          <input class="skill-modal-name" type="text" placeholder="e.g. corridor-3-bay" maxlength="80" />
        </label>
        <label class="skill-modal-label">Description
          <input class="skill-modal-desc" type="text" placeholder="What this cluster builds" maxlength="200" />
        </label>
        <div class="skill-modal-steps-label">${nodeCount} node${nodeCount === 1 ? "" : "s"} · ${edgeCount} edge${edgeCount === 1 ? "" : "s"}</div>
      </div>
      <div class="skill-modal-footer">
        <button class="btn btn-sm skill-modal-cancel" type="button">Cancel</button>
        <button class="btn btn-accent btn-sm skill-modal-save" type="button">Save cluster</button>
      </div>
    </div>
  `;

  const nameInput = overlay.querySelector<HTMLInputElement>(".skill-modal-name")!;
  const descInput = overlay.querySelector<HTMLInputElement>(".skill-modal-desc")!;
  const saveBtn   = overlay.querySelector<HTMLButtonElement>(".skill-modal-save")!;
  const closeBtn  = overlay.querySelector<HTMLButtonElement>(".skill-modal-close")!;
  const cancelBtn = overlay.querySelector<HTMLButtonElement>(".skill-modal-cancel")!;

  const close = () => overlay.remove();
  closeBtn.addEventListener("click", close);
  cancelBtn.addEventListener("click", close);
  overlay.addEventListener("click", (e) => { if (e.target === overlay) close(); });

  saveBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    if (!name) { nameInput.focus(); return; }
    saveBtn.disabled = true;
    saveBtn.textContent = "Saving…";
    try {
      const cluster = await saveCanvasCluster({
        name,
        description: descInput.value.trim() || undefined,
        graphJson,
        nodeCount,
        edgeCount,
      });
      window.dispatchEvent(new CustomEvent("skillstore:cluster-saved", { detail: { cluster } }));
      onSaved(cluster.id);
      close();
    } catch {
      saveBtn.disabled = false;
      saveBtn.textContent = "Save cluster";
    }
  });

  document.body.appendChild(overlay);
  requestAnimationFrame(() => nameInput.focus());
}
