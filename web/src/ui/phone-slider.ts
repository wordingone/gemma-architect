export type SliderTab = "ARCH" | "COMP";

export interface PhoneSliderOpts {
  initial?: SliderTab;
  onChange: (tab: SliderTab) => void;
}

export function buildPhoneSlider(opts: PhoneSliderOpts): { root: HTMLElement; setTab: (t: SliderTab) => void } {
  let active: SliderTab = opts.initial ?? "ARCH";

  const root = document.createElement("div");
  root.className = "phone-slider";
  root.setAttribute("role", "tablist");
  root.setAttribute("aria-label", "Palette section");

  const thumb = document.createElement("div");
  thumb.className = "phone-slider-thumb";
  thumb.setAttribute("aria-hidden", "true");
  root.appendChild(thumb);

  const tabs: SliderTab[] = ["ARCH", "COMP"];
  for (const tab of tabs) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "phone-slider-btn";
    btn.dataset.tab = tab;
    btn.textContent = tab;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", tab === active ? "true" : "false");
    btn.addEventListener("click", () => {
      if (active === tab) return;
      active = tab;
      sync();
      opts.onChange(tab);
    });
    root.appendChild(btn);
  }

  function sync() {
    root.querySelectorAll<HTMLButtonElement>(".phone-slider-btn").forEach((btn) => {
      const isActive = btn.dataset.tab === active;
      btn.classList.toggle("active", isActive);
      btn.setAttribute("aria-selected", isActive ? "true" : "false");
    });
    thumb.style.transform = active === "COMP" ? "translateX(100%)" : "translateX(0)";
  }

  function setTab(t: SliderTab) {
    if (active === t) return;
    active = t;
    sync();
  }

  sync();
  return { root, setTab };
}
