#!/usr/bin/env python3
"""
Horizontal-overflow check for PractixOS.html.

Every view, in every tenant, at every breakpoint on the ladder. Exits non-zero
if anything sticks out past the right edge, so this can gate a commit.

Why an iframe: headless Chrome refuses to size its own window below roughly
500 px, so `--window-size=375,800` silently gives you a 485 px layout viewport
and every phone measurement is a lie. Loading the app inside an iframe of the
target width, in a wide host window, produces a genuine 375 px layout viewport.

    python3 prototype/check-layout.py
    python3 prototype/check-layout.py --widths 375 --tenant aarav-dental -v
    python3 prototype/check-layout.py --shots docs/shots   # also write PNGs
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
APP = os.path.join(HERE, "PractixOS.html")

# 320 is the smallest phone still in real use; 1280 is a reception desktop.
DEFAULT_WIDTHS = [320, 375, 390, 414, 768, 1024, 1280]

CHROME_CANDIDATES = [
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
]

HOST = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>probe</title>
<style>html,body{margin:0;background:#222}iframe{border:0;display:block;height:900px}</style></head>
<body><iframe id="f" src="__APP__" width="__W__"></iframe><pre id="out">PENDING</pre>
<script>
const WIDTH = __W__, PLAN = __PLAN__;
const f = document.getElementById("f");

function measure(doc){
  const W = doc.documentElement.clientWidth;
  const view = doc.defaultView;
  const out = [], scrollers = [];

  // A segmented control or a table wrapper is *meant* to scroll sideways, so an
  // element inside one is contained, not broken. body and html are excluded as
  // boundaries on purpose: their overflow-x:hidden is a production safety net,
  // and honouring it here would hide exactly the bug we are looking for.
  function contained(el){
    let p = el.parentElement;
    while(p && p !== doc.body && p !== doc.documentElement){
      if(/(auto|scroll)/.test(view.getComputedStyle(p).overflowX)) return true;
      p = p.parentElement;
    }
    return false;
  }

  for(const el of doc.body.querySelectorAll("*")){
    const r = el.getBoundingClientRect();
    if(r.width === 0 && r.height === 0) continue;

    // Informational: a scroller whose content is far wider than itself is a
    // density smell even though it is not a layout break.
    if(/(auto|scroll)/.test(view.getComputedStyle(el).overflowX) &&
       el.scrollWidth > el.clientWidth * 1.15 && el.clientWidth > 0){
      scrollers.push({cls: (el.getAttribute("class") || "-").slice(0, 40),
                      inner: el.scrollWidth, outer: el.clientWidth});
    }

    const over = Math.round(r.right - W);
    if(over <= 1 || contained(el)) continue;

    // Report only the outermost offender; a wide child in a wide parent is one
    // bug, not two.
    let p = el.parentElement, nested = false;
    while(p && p !== doc.body){
      if(p.getBoundingClientRect().right - W > 1){ nested = true; break; }
      p = p.parentElement;
    }
    if(nested) continue;
    out.push({tag: el.tagName.toLowerCase(), cls: (el.getAttribute("class") || "").slice(0, 70),
              over: over, w: Math.round(r.width), left: Math.round(r.left)});
  }
  // Underflow is the mirror-image bug and an overflow scan cannot see it: a
  // collapsed grid track squeezes content into a sliver without ever crossing
  // the right edge. Measure how much of the viewport the content actually uses.
  const canvas = doc.getElementById("canvas"), gate = doc.getElementById("gate");
  const shown = (canvas && canvas.offsetParent !== null) ? canvas : gate;
  const rail = doc.querySelector(".rail");
  const railW = (rail && rail.offsetParent !== null) ? Math.round(rail.getBoundingClientRect().width) : 0;
  const usable = W - railW - 8;
  const mw = shown ? Math.round(shown.getBoundingClientRect().width) : 0;

  return {
    vw: W,
    scroll: Math.round(doc.documentElement.scrollWidth - W),
    bodyScroll: Math.round(doc.body.scrollWidth - W),
    mainWidth: mw,
    mainShortfall: Math.max(0, Math.round(usable - mw)),
    offenders: out.slice(0, 8),
    scrollers: scrollers.slice(0, 6)
  };
}

f.onload = () => {
  const doc = f.contentDocument;
  const api = f.contentWindow.PractixOS;
  const results = [];
  try{
    for(const job of PLAN){
      api.S.layMode = "auto";
      api.S.gatePick = job.tenant;
      if(job.view === "__gate__"){
        api.S.session.tenantId = null; api.S.tenants = {};
        api.S.gate = job.gate; api.S.gatePick = job.gate === "signin" ? job.tenant : null;
        api.render();
      } else {
        api.signIn(job.view);
      }
      // Exercise the transient surfaces that only exist after a tap.
      if(job.open === "sheet") api.ACT.more();
      if(job.open === "walkin") api.ACT.walkin();
      if(job.open === "keypad"){
        api.S.nursePatient = api.T().patients[0].id;
        api.ACT.vital("bp", {dataset:{label:"Blood pressure", unit:"mmHg", mode:"bp"}});
      }
      const m = measure(doc);
      m.tenant = job.tenant; m.view = job.view; m.open = job.open || null;
      m.lay = doc.documentElement.getAttribute("data-lay");
      results.push(m);
      if(job.open) api.closeModal();
    }
  }catch(err){
    results.push({fatal: String(err && err.stack || err)});
  }
  document.getElementById("out").textContent = "RESULT" + JSON.stringify({width: WIDTH, results: results});
};
</script></body></html>"""


def find_chrome():
    for c in CHROME_CANDIDATES:
        p = shutil.which(c) if not os.path.isabs(c) else (c if os.path.exists(c) else None)
        if p:
            return p
    return None


def run_width(chrome, width, plan, workdir):
    host = (HOST.replace("__APP__", "file://" + APP)
                .replace("__PLAN__", json.dumps(plan))
                .replace("__W__", str(width)))
    path = os.path.join(workdir, "probe_%d.html" % width)
    with open(path, "w", encoding="utf-8") as fh:
        fh.write(host)
    cmd = [
        chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--hide-scrollbars", "--allow-file-access-from-files",
        "--window-size=1700,1000", "--virtual-time-budget=20000",
        "--user-data-dir=" + os.path.join(workdir, "profile%d" % width),
        "--dump-dom", "file://" + path,
    ]
    proc = subprocess.run(cmd, capture_output=True, text=True, timeout=180)
    m = re.search(r"RESULT(\{.*?\})</pre>", proc.stdout, re.S)
    if not m:
        raise RuntimeError("no result at %dpx.\nstderr tail:\n%s" % (width, proc.stderr[-1200:]))
    raw = m.group(1).replace("&quot;", '"').replace("&amp;", "&").replace("&lt;", "<").replace("&gt;", ">")
    return json.loads(raw)


# A representative walk through the product, for the review pack.
SHOTS = [
    ("01-gate-workspaces",   390, 900,  ""),
    ("02-gate-signin",       390, 900,  "?clinic=anandi-wellness"),
    ("03-board-phone",       390, 940,  "?clinic=aarav-dental&as=reception"),
    ("04-chairside-phone",   390, 1000, "?clinic=aarav-dental&as=dental"),
    ("05-slate-phone",       390, 1000, "?clinic=sushrut-polyclinic&as=nurse"),
    ("06-quietroom-phone",   390, 900,  "?clinic=anandi-wellness&as=therapy"),
    ("07-isolation-phone",   390, 1180, "?clinic=aarav-dental&as=isolation"),
    ("08-doorway-phone",     390, 1000, "?clinic=sushrut-polyclinic&as=patient"),
    ("09-ledger-phone",      390, 1180, "?clinic=anandi-wellness&as=owner"),
    ("10-board-desktop",    1360, 900,  "?clinic=aarav-dental&as=reception"),
    ("11-chairside-desktop",1360, 1000, "?clinic=aarav-dental&as=dental"),
    ("12-routecard-desktop",1360, 900,  "?clinic=sushrut-polyclinic&as=consultant"),
]
SHOT_HOST = ('<!DOCTYPE html><html><head><meta charset="utf-8"><style>'
             'html,body{margin:0;background:#3A3A3A}'
             'iframe{border:0;display:block;width:%dpx;height:%dpx}</style></head>'
             '<body><iframe src="file://%s%s"></iframe></body></html>')


def capture_shots(chrome, outdir, workdir):
    os.makedirs(outdir, exist_ok=True)
    print("\nWriting review screenshots to %s" % outdir)
    for name, w, h, query in SHOTS:
        page = os.path.join(workdir, "shot_" + name + ".html")
        with open(page, "w", encoding="utf-8") as fh:
            fh.write(SHOT_HOST % (w, h, APP, query))
        target = os.path.join(outdir, name + ".png")
        subprocess.run([
            chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
            "--hide-scrollbars", "--allow-file-access-from-files",
            "--force-device-scale-factor=2",
            "--window-size=%d,%d" % (max(w + 8, 500), h),   # Chrome will not go below ~500 px
            "--virtual-time-budget=6000",
            "--user-data-dir=" + os.path.join(workdir, "shotprofile"),
            "--screenshot=" + target, "file://" + page,
        ], capture_output=True, timeout=120)
        size = os.path.getsize(target) if os.path.exists(target) else 0
        print("  %-24s %4dx%-5d %8d bytes" % (name, w, h, size))


def build_plan(tenants_filter):
    """Mirror of MODULES_BY_VERTICAL and UTILITY_MODULES in the app."""
    verticals = {
        "aarav-dental":       ["reception", "nurse", "dental", "consultant", "owner", "patient"],
        "anandi-wellness":    ["reception", "therapy", "owner", "patient"],
        "sushrut-polyclinic": ["reception", "nurse", "dental", "therapy", "consultant", "owner", "patient"],
    }
    utility = ["whatsapp", "roadmap", "isolation", "system", "coverage"]
    plan = []
    for tenant, mods in verticals.items():
        if tenants_filter and tenant not in tenants_filter:
            continue
        plan.append({"tenant": tenant, "view": "__gate__", "gate": "workspace"})
        plan.append({"tenant": tenant, "view": "__gate__", "gate": "signin"})
        for m in mods + utility:
            plan.append({"tenant": tenant, "view": m})
        plan.append({"tenant": tenant, "view": "reception", "open": "sheet"})
        plan.append({"tenant": tenant, "view": "reception", "open": "walkin"})
        if "nurse" in mods:
            plan.append({"tenant": tenant, "view": "nurse", "open": "keypad"})
    return plan


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--widths", type=int, nargs="+", default=DEFAULT_WIDTHS)
    ap.add_argument("--tenant", action="append", help="restrict to one or more tenant keys")
    ap.add_argument("-v", "--verbose", action="store_true", help="print every combination, not just failures")
    ap.add_argument("--shots", metavar="DIR", help="also write review screenshots into DIR")
    args = ap.parse_args()

    chrome = find_chrome()
    if not chrome:
        print("No Chrome or Chromium found; skipping the layout check.", file=sys.stderr)
        return 0
    if not os.path.exists(APP):
        print("Cannot find %s" % APP, file=sys.stderr)
        return 2

    plan = build_plan(set(args.tenant) if args.tenant else None)
    print("PractixOS layout check — %d combinations x %d widths\n" % (len(plan), len(args.widths)))

    failures, checked, sideways = [], 0, {}
    with tempfile.TemporaryDirectory(prefix="practix-layout-") as workdir:
        for width in args.widths:
            batch = run_width(chrome, width, plan, workdir)
            worst = 0
            for r in batch["results"]:
                if r.get("fatal"):
                    print("  FATAL %4dpx  %s" % (width, r["fatal"][:600]))
                    failures.append((width, "-", "-", "JS error"))
                    continue
                checked += 1
                label = "%-19s %-11s%s" % (r["tenant"], r["view"], (" +" + r["open"]) if r.get("open") else "")
                over = max(r["scroll"], r["bodyScroll"])
                worst = max(worst, over)
                for sc in r.get("scrollers", []):
                    key = (width, sc["cls"].split()[0] if sc["cls"].split() else "-")
                    sideways[key] = max(sideways.get(key, 0), sc["inner"] - sc["outer"])
                # On a desktop the canvas is deliberately capped at 1460 px and
                # centred, so a shortfall only counts below that.
                narrow = r["mainShortfall"] > 24 and width <= 1460
                if over > 1 or r["offenders"] or narrow:
                    detail = ", ".join("%s.%s +%dpx" % (o["tag"], (o["cls"].split() or ["-"])[0], o["over"])
                                       for o in r["offenders"])
                    if narrow:
                        detail = (detail + "; " if detail else "") + \
                                 "content only %dpx of %dpx (collapsed by %dpx)" % (
                                     r["mainWidth"], width, r["mainShortfall"])
                    if not detail:
                        detail = "document scrollWidth +%dpx" % over
                    failures.append((width, r["tenant"], r["view"], detail))
                    print("  FAIL  %4dpx [%s]  %s  ->  %s" % (width, r["lay"], label, detail))
                elif args.verbose:
                    print("   ok   %4dpx [%s]  %s" % (width, r["lay"], label))
            print("  %4dpx  %d screens, worst overflow %dpx" % (width, len(batch["results"]), worst))
        if args.shots:
            capture_shots(chrome, os.path.abspath(args.shots), workdir)

    if sideways:
        print("\nDeliberate sideways scrollers (not failures):")
        for (w, cls), extra in sorted(sideways.items()):
            print("  %4dpx  .%-14s scrolls %d px" % (w, cls, extra))

    print("\n" + "=" * 62)
    if failures:
        print("%d of %d screens overflow horizontally." % (len(failures), checked))
        print("=" * 62)
        return 1
    print("No horizontal overflow. %d screens across %d widths." % (checked, len(args.widths)))
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
