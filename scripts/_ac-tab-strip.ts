// AC verification for PR #109 — tab strip collapse P1 (#93)
// Exercises: ribbon tabs (RENDER/ARCH/COMP), phone-slider toggle, measure icons, mode switches.

import { chromium } from "playwright";
import { readFileSync } from "node:fs";

const cdpJson = JSON.parse(readFileSync("B:/M/gemma-architect-master/.shared-browser/cdp.json", "utf8").replace(/^﻿/, ""));
const browser = await chromium.connectOverCDP(cdpJson.endpoint);
const pages = browser.contexts().flatMap(c => c.pages());
const page = pages.find(p => p.url().startsWith("http://localhost:5175/"));
if (!page) { console.error("no 5175 tab"); await browser.close(); process.exit(1); }

const consoleErrors: string[] = [];
page.on("console", msg => {
  if (msg.type() === "error") consoleErrors.push(msg.text().slice(0, 200));
});

function delay(ms: number) { return new Promise(r => setTimeout(r, ms)); }

// ── 1. Ribbon tabs ────────────────────────────────────────────────────────────
const ribbonTabs = await page.evaluate(() => {
  return Array.from(document.querySelectorAll(".ribbon-tab")).map(t => t.textContent?.trim());
});
console.log("Ribbon tabs:", ribbonTabs);
const expectedTabs = ["RENDER", "ARCH", "COMP"];
const tabsOk = expectedTabs.every((t, i) => ribbonTabs[i] === t) && ribbonTabs.length === 3;
console.log("Tabs correct (RENDER/ARCH/COMP):", tabsOk);

// Click each ribbon tab
for (const tabText of ["RENDER", "ARCH", "COMP"]) {
  await page.evaluate((t: string) => {
    const tab = Array.from(document.querySelectorAll<HTMLElement>(".ribbon-tab"))
      .find(el => el.textContent?.trim() === t);
    tab?.click();
  }, tabText);
  await delay(200);
  console.log(`Clicked ribbon tab: ${tabText}`);
}

// ── 2. Phone-slider ARCH↔COMP ────────────────────────────────────────────────
const sliderInfo = await page.evaluate(() => {
  const slider = document.querySelector(".phone-slider");
  const btns = Array.from(slider?.querySelectorAll(".phone-slider-btn") ?? []).map(b => ({
    tab: (b as HTMLElement).dataset.tab,
    active: b.classList.contains("active"),
  }));
  const thumbTransform = (slider?.querySelector(".phone-slider-thumb") as HTMLElement | null)?.style.transform ?? "none";
  return { btns, thumbTransform, sliderPresent: !!slider };
});
console.log("Phone-slider present:", sliderInfo.sliderPresent);
console.log("Slider buttons:", JSON.stringify(sliderInfo.btns));
console.log("Thumb transform:", sliderInfo.thumbTransform);

// Click COMP button in slider
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".phone-slider-btn"))
    .find(b => b.dataset.tab === "COMP");
  btn?.click();
});
await delay(250);
const sliderAfterComp = await page.evaluate(() => {
  const compSection = document.querySelectorAll(".palette-section")[4];
  const archSection = document.querySelectorAll(".palette-section")[3];
  const thumb = document.querySelector<HTMLElement>(".phone-slider-thumb");
  return {
    compHidden: compSection?.classList.contains("palette-section--hidden"),
    archHidden: archSection?.classList.contains("palette-section--hidden"),
    thumbTransform: thumb?.style.transform ?? "none",
  };
});
console.log("After COMP click — arch hidden:", sliderAfterComp.archHidden, "comp hidden:", sliderAfterComp.compHidden, "thumb:", sliderAfterComp.thumbTransform);

// Click ARCH button in slider
await page.evaluate(() => {
  const btn = Array.from(document.querySelectorAll<HTMLElement>(".phone-slider-btn"))
    .find(b => b.dataset.tab === "ARCH");
  btn?.click();
});
await delay(250);
console.log("Clicked slider ARCH — back to ARCH section");

// ── 3. Measure icons in ribbon toolbar ───────────────────────────────────────
const measureToolBtns = await page.evaluate(() => {
  const groups = Array.from(document.querySelectorAll(".tool-group"));
  for (const g of groups) {
    const label = g.querySelector(".tool-group-label");
    if (label?.textContent?.trim() === "MEASURE") {
      return Array.from(g.querySelectorAll(".tool-btn")).map(b => (b as HTMLElement).dataset.tool ?? "?");
    }
  }
  return [];
});
console.log("MEASURE ribbon tools:", measureToolBtns);

for (const toolId of measureToolBtns) {
  await page.evaluate((t: string) => {
    const btn = document.querySelector<HTMLElement>(`.tool-btn[data-tool="${t}"]`);
    btn?.click();
  }, toolId);
  await delay(100);
}
console.log("Clicked all MEASURE ribbon tools");

// ── 4. Mode switches ─────────────────────────────────────────────────────────
for (const mode of ["layout", "research", "model"]) {
  await page.evaluate((m: string) => {
    const tab = document.querySelector<HTMLElement>(`.mode-tab[data-mode="${m}"]`);
    tab?.click();
  }, mode);
  await delay(300);
  const tabs = await page.evaluate(() =>
    Array.from(document.querySelectorAll(".ribbon-tab")).map(t => t.textContent?.trim())
  );
  console.log(`Mode ${mode} — ribbon tabs:`, tabs);
}

// ── Result ────────────────────────────────────────────────────────────────────
console.log("\n=== AC RESULT ===");
console.log("Ribbon tabs 3 (RENDER/ARCH/COMP):", tabsOk);
console.log("Phone-slider present:", sliderInfo.sliderPresent);
console.log("COMP section toggle:", !sliderAfterComp.archHidden && !sliderAfterComp.compHidden === false);
console.log("Measure tools count:", measureToolBtns.length);
console.log("Console errors:", consoleErrors.length === 0 ? "none" : consoleErrors);

await browser.close();
