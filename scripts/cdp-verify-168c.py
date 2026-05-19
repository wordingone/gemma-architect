#!/usr/bin/env python3
"""
cdp-verify-168c.py — 3-surface CDP probe for #168 Phase C (layer param dispatch).

Probes resolveLayerId() wiring by calling __dispatch() directly and checking
mesh.userData.layerId on the most-recently-added scene child.

Writes: B:/M/gemma-architect-master/state/verify-168c-<sha>-<timestamp>.json
"""

import json
import os
import sys
import time
import subprocess
from datetime import datetime, timezone
from pathlib import Path
import urllib.request

try:
    import websocket
except ImportError:
    subprocess.check_call([sys.executable, "-m", "pip", "install", "websocket-client", "-q"])
    import websocket

import sys as _sys, os as _os
_sys.path.insert(0, _os.path.dirname(_os.path.abspath(__file__)))
from ports import CDP_PORT, DEV_PORT, CDP_BASE, DEV_URL

DEV_URL = "http://localhost:5182/"
SHA = "1b9fc43"
STATE_DIR = Path("B:/M/gemma-architect-master/state")
STATE_DIR.mkdir(parents=True, exist_ok=True)

timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
OUT_FILE = STATE_DIR / f"verify-168c-{SHA}-{timestamp}.json"

_msg_id = 0


def next_id():
    global _msg_id
    _msg_id += 1
    return _msg_id


def cdp_connect(ws_url):
    ws = websocket.WebSocket()
    ws.connect(ws_url, timeout=15, suppress_origin=True)
    return ws


def cdp_send(ws, method, params=None):
    msg_id = next_id()
    ws.send(json.dumps({"id": msg_id, "method": method, "params": params or {}}))
    while True:
        raw = ws.recv()
        msg = json.loads(raw)
        if msg.get("id") == msg_id:
            return msg.get("result", {})


def cdp_eval(ws, expression, await_promise=False):
    result = cdp_send(ws, "Runtime.evaluate", {
        "expression": expression,
        "awaitPromise": await_promise,
        "returnByValue": True,
    })
    return result.get("result", {})


def get_cdp_ws_url():
    with urllib.request.urlopen(f"http://localhost:{CDP_PORT}/json", timeout=5) as r:
        tabs = json.loads(r.read())

    # Prefer an existing tab at our dev URL
    for tab in tabs:
        if tab.get("url", "").startswith(DEV_URL):
            print(f"  Found existing tab at {DEV_URL}")
            return tab["webSocketDebuggerUrl"]

    # Fall back to first tab and navigate
    if tabs:
        ws_url = tabs[0]["webSocketDebuggerUrl"]
        first_url = tabs[0].get('url','')[:60]
        print(f"  Using first tab ({first_url}), will navigate to {DEV_URL}")
        return ws_url

    raise RuntimeError("No CDP tabs found")


def run_probe(ws, name, js):
    try:
        result = cdp_eval(ws, js, await_promise=True)
        if result.get("type") == "object" and result.get("subtype") != "error":
            value = result.get("value", {})
            passed = bool(value.get("passed", False))
            return {"name": name, "passed": passed, "evidence": value.get("evidence", {})}
        else:
            desc = result.get("description") or result.get("value") or "unknown"
            return {"name": name, "passed": False, "evidence": {"error": str(desc)[:300]}}
    except Exception as exc:
        return {"name": name, "passed": False, "evidence": {"exception": str(exc)[:300]}}


DISPATCH_AND_CHECK = """
(async (verb, args, expectedLayerId) => {
    if (typeof window.__viewer === 'undefined') {
        return { passed: false, evidence: { reason: '__viewer not available' } };
    }
    const before = window.__viewer.scene.children.length;
    try {
        window.__dispatch(verb, args);
    } catch(e) {
        return { passed: false, evidence: { dispatchError: String(e.message || e) } };
    }
    await new Promise(r => setTimeout(r, 400));
    const children = window.__viewer.scene.children;
    const after = children.length;
    if (after <= before) {
        return { passed: false, evidence: { reason: 'no new mesh added', before, after } };
    }
    // Walk backwards to find the most recently added Mesh or Group
    let lastMesh = null;
    for (let i = children.length - 1; i >= 0; i--) {
        const c = children[i];
        if (c.type === 'Mesh' || c.type === 'Group') { lastMesh = c; break; }
    }
    if (!lastMesh) {
        return { passed: false, evidence: { reason: 'no Mesh/Group in scene', after } };
    }
    const layerId = lastMesh.userData ? lastMesh.userData.layerId : undefined;
    const passed = layerId === expectedLayerId;
    return { passed, evidence: { layerId, expected: expectedLayerId, meshType: lastMesh.type, before, after } };
})
"""


def main():
    print(f"cdp-verify-168c  SHA={SHA}  target={DEV_URL}")

    ws_url = get_cdp_ws_url()
    ws = cdp_connect(ws_url)

    try:
        # Navigate to fix-branch dev server
        print(f"  Navigating to {DEV_URL} ...")
        cdp_send(ws, "Page.navigate", {"url": DEV_URL})
        time.sleep(4)

        # Verify __dispatch is wired
        boot = cdp_eval(ws, "typeof window.__dispatch === 'function' ? 'ok' : 'not_ready'")
        if boot.get("value") != "ok":
            print(f"ERROR: __dispatch not ready — boot check: {boot}")
            return False

        print("  __dispatch ready. Running probes...")

        surfaces = []

        # Surface 1: explicit layer arg overrides natural routing — IfcWall → "Walls" via explicit
        s1 = run_probe(
            ws,
            "layer-arg-routing-explicit",
            f'({DISPATCH_AND_CHECK})("IfcWall", {{length: 4, layer: "Walls"}}, "Walls")',
        )
        surfaces.append(s1)
        print(f"  layer-arg-routing-explicit:       {'PASS' if s1['passed'] else 'FAIL'}  {s1['evidence']}")

        # Surface 2: no layer arg falls back to auto-route — IfcSlab → "Slabs"
        s2_js = (
            f"({DISPATCH_AND_CHECK})"
            '("IfcSlab", {profile: [[0,0],[4,0],[4,4],[0,4]], thickness: 0.2}, "Slabs")'
        )
        s2 = run_probe(ws, "layer-arg-routing-fallback", s2_js)
        surfaces.append(s2)
        print(f"  layer-arg-routing-fallback:       {'PASS' if s2['passed'] else 'FAIL'}  {s2['evidence']}")

        # Surface 3: unknown layer gracefully falls back — IfcColumn → "Columns"
        s3_js = (
            f"({DISPATCH_AND_CHECK})"
            '("IfcColumn", {position: [0,0], profile: [[0,0],[0.3,0],[0.3,0.3],[0,0.3]], height: 3, layer: "DoesNotExist"}, "Columns")'
        )
        s3 = run_probe(ws, "layer-arg-unknown-layer-graceful", s3_js)
        surfaces.append(s3)
        print(f"  layer-arg-unknown-layer-graceful: {'PASS' if s3['passed'] else 'FAIL'}  {s3['evidence']}")

    finally:
        ws.close()

    all_passed = all(s["passed"] for s in surfaces)
    output = {
        "sha": SHA,
        "timestamp": timestamp,
        "attached_via_cdp": True,
        "dev_url": DEV_URL,
        "all_passed": all_passed,
        "surfaces": surfaces,
    }

    OUT_FILE.write_text(json.dumps(output, indent=2), encoding="utf-8")
    print(f"\nall_passed: {all_passed}")
    print(f"Written: {OUT_FILE}")
    return all_passed


if __name__ == "__main__":
    ok = main()
    sys.exit(0 if ok else 1)
