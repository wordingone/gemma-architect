#!/usr/bin/env node
// cdp.ts — CDP-CLI helper: drive the canonical :5175 tab via one-line bash.
//
// Usage: node --experimental-strip-types scripts/cdp.ts <subcommand> [args]
//   (or) bun run cdp <subcommand> [args]
//
// Subcommands:
//   inspect                        dump scene tree + selection state (read-only)
//   click <selector>               PointerEvent click on first CSS-selector match
//   click-text <text>              find element by exact text content + click
//   click-at <x> <y>              PointerEvent at viewport-relative coords (#viewport-2 .vp-body)
//   key <name> [--mods m1,m2]     KeyboardEvent: Delete, Escape, ArrowUp, g, etc.
//   eval "<js>"                    arbitrary page.evaluate (escape hatch — file a ticket first)
//   screenshot [--out path.png]    save canonical-tab screenshot to disk
//   prompt <text>                  type into DSL console input + submit (Enter)
//   chat <text>                    type into NL agent chat input + click SEND (agent mode)
//   select-all                     Ctrl+A
//   delete-selected                Delete keystroke (assumes something is selected)
//
// Exit codes: 0 success · 1 action failed · 2 no canonical tab

import { chromium } from "playwright";
import { existsSync, readFileSync, writeFileSync } from "node:fs";

const CDP_JSON = "B:/M/gemma-architect-master/.shared-browser/cdp.json";
const DEV_URL  = "http://localhost:5175/";

function die(msg: string, code = 1): never {
  console.error(msg);
  process.exit(code);
}

if (!existsSync(CDP_JSON)) {
  die("BLOCKED: cdp.json not found — run: bun run shared-browser:start", 2);
}

const raw = readFileSync(CDP_JSON, "utf8").replace(/^﻿/, "");
const { endpoint } = JSON.parse(raw);

const browser = await chromium.connectOverCDP(endpoint);
const allPages = browser.contexts().flatMap(c => c.pages());
const page = allPages.find(p => p.url().startsWith(DEV_URL));
if (!page) die(`BLOCKED: no canonical tab found at ${DEV_URL}`, 2);

const [cmd, ...args] = process.argv.slice(2);

// Dispatch PointerEvent the same way surface 4/6 in gemma-verify-cdp do:
// pointerId:1, pointerType:"mouse", button:0, buttons:1 — fires the app's
// pointer pipeline identically to a real mouse click.
async function vpPointerClick(vpX: number, vpY: number): Promise<void> {
  await page!.evaluate(({ x, y }: { x: number; y: number }) => {
    const body = document.querySelector("#viewport-2 .vp-body") as HTMLElement | null;
    if (!body) throw new Error("no #viewport-2 .vp-body");
    const r = body.getBoundingClientRect();
    const cx = r.left + x;
    const cy = r.top + y;
    body.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 }));
    body.dispatchEvent(new PointerEvent("pointerup",   { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
  }, { x: vpX, y: vpY });
}

async function elPointerClick(selector: string): Promise<void> {
  await page!.evaluate((sel: string) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) throw new Error(`selector not found: ${sel}`);
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    el.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 }));
    el.dispatchEvent(new PointerEvent("pointerup",   { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
    el.dispatchEvent(new MouseEvent("click",         { clientX: cx, clientY: cy, bubbles: true, button: 0 }));
  }, selector);
}

async function dispatchKey(key: string, mods: string[]): Promise<void> {
  await page!.evaluate(({ key, ctrl, shift, alt, meta }: { key: string; ctrl: boolean; shift: boolean; alt: boolean; meta: boolean }) => {
    const code = key.length === 1 ? `Key${key.toUpperCase()}` : key;
    const opts: KeyboardEventInit = { key, code, bubbles: true, ctrlKey: ctrl, shiftKey: shift, altKey: alt, metaKey: meta };
    window.dispatchEvent(new KeyboardEvent("keydown", opts));
    document.dispatchEvent(new KeyboardEvent("keydown", opts));
    window.dispatchEvent(new KeyboardEvent("keyup", { ...opts }));
    document.dispatchEvent(new KeyboardEvent("keyup", { ...opts }));
  }, { key, ctrl: mods.includes("ctrl"), shift: mods.includes("shift"), alt: mods.includes("alt"), meta: mods.includes("meta") });
}

if (cmd === "inspect") {
  const result = await page.evaluate(async () => {
    const v = (window as any).__viewer;
    const scene = v?.scene ?? null;
    const children = scene
      ? (scene.children as any[]).map((c: any) => ({
          type: c.type,
          name: c.name || "(unnamed)",
          uuid: c.uuid?.slice(0, 8),
          visible: c.visible,
          position: c.position
            ? { x: +c.position.x.toFixed(3), y: +c.position.y.toFixed(3), z: +c.position.z.toFixed(3) }
            : null,
        }))
      : [];
    const activeObj = v?.getActiveObject?.() ?? null;
    // Dynamic imports run in the browser (vite resolves /src/...); indirect
    // through variables so tsc on the Node side doesn't try to resolve them.
    const selPath = "/src/selection-state.ts";
    const histPath = "/src/history.ts";
    const selMod = await import(selPath).catch(() => null);
    const histMod = await import(histPath).catch(() => null);
    const selected = selMod?.getSelected?.() ?? null;
    return {
      scene_children: children,
      scene_child_count: children.length,
      active_object: activeObj
        ? { uuid: activeObj.uuid?.slice(0, 8), name: activeObj.name, type: activeObj.type }
        : null,
      selection: selected
        ? { uuid: (selected as any).object?.uuid?.slice(0, 8), name: (selected as any).object?.name ?? null }
        : null,
      can_undo: histMod?.canUndo?.() ?? null,
      can_redo: histMod?.canRedo?.() ?? null,
    };
  });
  console.log(JSON.stringify(result, null, 2));

} else if (cmd === "click") {
  const selector = args[0];
  if (!selector) die("usage: cdp click <css-selector>");
  const found = await page.evaluate((sel: string) => !!document.querySelector(sel), selector);
  if (!found) die(`no element matching: ${selector}`);
  await elPointerClick(selector);
  console.log(`clicked: ${selector}`);

} else if (cmd === "click-text") {
  const text = args[0];
  if (!text) die("usage: cdp click-text <text>");
  const result = await page.evaluate((text: string) => {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    let node: Node | null;
    while ((node = walker.nextNode())) {
      if (node.textContent?.trim() === text) {
        const el = node.parentElement as HTMLElement;
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue; // skip hidden
        const cx = r.left + r.width / 2;
        const cy = r.top + r.height / 2;
        el.dispatchEvent(new PointerEvent("pointerdown", { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0, buttons: 1 }));
        el.dispatchEvent(new PointerEvent("pointerup",   { clientX: cx, clientY: cy, bubbles: true, cancelable: true, pointerId: 1, pointerType: "mouse", button: 0 }));
        el.dispatchEvent(new MouseEvent("click",         { clientX: cx, clientY: cy, bubbles: true, button: 0 }));
        return { found: true, tag: el.tagName, text: el.textContent?.trim() };
      }
    }
    return { found: false };
  }, text);
  if (!result.found) die(`no visible element with text: "${text}"`);
  console.log(`clicked text "${text}" (${result.tag})`);

} else if (cmd === "click-at") {
  const [xStr, yStr] = args;
  if (!xStr || !yStr) die("usage: cdp click-at <x> <y>");
  const x = parseInt(xStr, 10);
  const y = parseInt(yStr, 10);
  if (isNaN(x) || isNaN(y)) die("click-at: x and y must be integers");
  await vpPointerClick(x, y);
  console.log(`pointer at viewport (${x}, ${y})`);

} else if (cmd === "key") {
  const keyName = args[0];
  if (!keyName) die("usage: cdp key <name> [--mods ctrl,shift,alt,meta]");
  const modsIdx = args.indexOf("--mods");
  const mods = modsIdx >= 0 && args[modsIdx + 1] ? args[modsIdx + 1].split(",") : [];
  await dispatchKey(keyName, mods);
  console.log(`key: ${keyName}${mods.length ? ` +${mods.join("+")}` : ""}`);

} else if (cmd === "eval") {
  const js = args[0];
  if (!js) die("usage: cdp eval \"<js-expression>\"");
  const result = await page.evaluate((js: string) => {
    // eslint-disable-next-line no-eval
    return (0, eval)(js);
  }, js);
  console.log(JSON.stringify(result, null, 2));

} else if (cmd === "screenshot") {
  const outIdx = args.indexOf("--out");
  const outPath = outIdx >= 0 && args[outIdx + 1]
    ? args[outIdx + 1]
    : `cdp-screenshot-${Date.now()}.png`;
  const buf = await page.screenshot({ type: "png" });
  writeFileSync(outPath, buf);
  console.log(`screenshot: ${outPath} (${buf.length} bytes)`);

} else if (cmd === "prompt") {
  const text = args.join(" ");
  if (!text) die("usage: cdp prompt <text>");
  await page.evaluate((text: string) => {
    const input = document.querySelector("#console-input") as HTMLInputElement | null;
    if (!input) throw new Error("no #console-input found");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
    input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true }));
  }, text);
  console.log(`prompt: ${text}`);

} else if (cmd === "chat") {
  const text = args.join(" ");
  if (!text) die("usage: cdp chat <text>");
  await page.evaluate((text: string) => {
    const input = document.querySelector<HTMLTextAreaElement>(".chat-input");
    if (!input) throw new Error("no .chat-input found — ensure app is in agent mode (not console mode)");
    input.value = text;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    const sendBtn = document.querySelector<HTMLButtonElement>(".chat-send-btn");
    if (sendBtn && !sendBtn.disabled) {
      sendBtn.click();
    } else {
      input.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, ctrlKey: true }));
      input.dispatchEvent(new KeyboardEvent("keyup",   { key: "Enter", code: "Enter", keyCode: 13, bubbles: true, ctrlKey: true }));
    }
  }, text);
  console.log(`chat: ${text}`);

} else if (cmd === "select-all") {
  await dispatchKey("a", ["ctrl"]);
  console.log("select-all (Ctrl+A)");

} else if (cmd === "delete-selected") {
  await dispatchKey("Delete", []);
  console.log("delete-selected (Delete)");

} else {
  die(
    `unknown subcommand: ${cmd ?? "(none)"}\n` +
    "available: inspect · click · click-text · click-at · key · eval · screenshot · prompt · chat · select-all · delete-selected"
  );
}

// Never close page or browser — Jun's canonical tab and window survive every invocation.
process.exit(0);
