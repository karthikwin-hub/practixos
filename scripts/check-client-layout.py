#!/usr/bin/env python3
"""
Layout integrity over the *built production client* (§8.2, §6.6).

    npm --prefix web run build && python3 scripts/check-client-layout.py
    python3 scripts/check-client-layout.py --widths 320 390 -v

`prototype/check-layout.py` measures `prototype/PractixOS.html`, which nothing
in the build ever modifies. On its own it therefore reports green for a client
that has never been looked at — which is how four milestones once shipped with
a placeholder interface behind a passing layout gate. This script runs the same
assertions, from the same `scripts/layout-probe.js`, against the real thing.

It skips while `web/` does not exist, and only while.

Two contracts the client must honour:

  * it shares the prototype's structural vocabulary — `.canvas` for the signed-in
    content region, `.gate` for the signed-out one, `.rail` for the navigation
    rail. §6.6 requires that anyway ("a component that diverges still shares its
    vocabulary"), and it is what lets one measurement serve both gates.
  * `web/layout-screens.json` lists every screen worth measuring:
    `[{"path": "/#/desk", "label": "board"}, ...]`. A route absent from it is a
    route nobody checks.
"""

import argparse
import functools
import http.server
import json
import os
import re
import shutil
import socketserver
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
CLIENT = os.path.join(ROOT, "web")
SCREENS = os.path.join(CLIENT, "layout-screens.json")
PROBE = os.path.join(ROOT, "scripts", "layout-probe.js")
DIST = os.path.join(CLIENT, "dist")

DEFAULT_WIDTHS = [320, 375, 390, 414, 768, 1024, 1280]

CHROME_CANDIDATES = [
    "google-chrome", "google-chrome-stable", "chromium", "chromium-browser",
    "/usr/bin/google-chrome", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
]

# §6.6: three rungs, not a spectrum. The attribute is the layout mode, so this
# is directly checkable rather than inferred from a media query.
def expected_lay(width):
    return "phone" if width < 600 else ("tab" if width < 1024 else "desk")


# One iframe per screen, every src present in the initial HTML, everything
# measured on window load. Navigating a single iframe from script is the obvious
# design and does not work: headless Chrome dumps the DOM as soon as the first
# document settles, long before a scripted navigation has finished, and the
# probe reports nothing at all.
HOST = """<!DOCTYPE html><html><head><meta charset="utf-8"><title>probe</title>
<style>html,body{margin:0;background:#222}iframe{border:0;display:block;height:900px;margin-bottom:4px}</style>
</head><body>
<script>
// Runs before the iframes below are parsed, so the client reads a signed-in
// session on its first render rather than bouncing to the sign-in screen.
// Same origin as the iframes, which is the only reason this is visible to them.
Object.entries(__SESSION__).forEach(([k, v]) => localStorage.setItem(k, v));
</script>
__IFRAMES__
<pre id="out">PENDING</pre>
<script>
const WIDTH = __W__, SCREENS = __SCREENS__;

__MEASURE__

// window load fires when the iframe documents have loaded, which is before a
// client-side framework has mounted and before an effect has had the chance to
// set data-lay. Measuring there reports a half-built page, and does so
// inconsistently across screens, which is worse than reporting nothing.
addEventListener("load", () => setTimeout(run, 600));

function run(){
  const results = [];
  SCREENS.forEach((s, i) => {
    try{
      const doc = document.getElementById("f" + i).contentDocument;
      const m = measure(doc);
      m.label = s.label; m.path = s.path;
      m.lay = doc.documentElement.getAttribute("data-lay");
      m.hasMain = !!doc.querySelector(".canvas, .gate");
      results.push(m);
    }catch(err){
      results.push({label: s.label, path: s.path, fatal: String(err && err.stack || err)});
    }
  });
  document.getElementById("out").textContent = "RESULT" + JSON.stringify({width: WIDTH, results});
}
</script></body></html>"""


def find_chrome():
    for c in CHROME_CANDIDATES:
        p = shutil.which(c) if not os.path.isabs(c) else (c if os.path.exists(c) else None)
        if p:
            return p
    return None


PROBE_PAGES: dict[str, bytes] = {}
API_UPSTREAM = ""


class SPAHandler(http.server.SimpleHTTPRequestHandler):
    """Static files, with any unknown path falling back to index.html, plus the
    probe pages, plus a pass-through to the API.

    Everything has to sit on one origin. The probe cannot read `contentDocument`
    across origins, and the `practix.token` it seeds into `localStorage` would
    not be visible to the iframes either — so the client would render its
    sign-in screen and the run would measure that seven times.
    """

    def do_GET(self):
        if self.path.startswith("/api/"):
            return self.proxy("GET")
        page = PROBE_PAGES.get(self.path)
        if page is None:
            return super().do_GET()
        self.send_response(200)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(page)))
        self.end_headers()
        self.wfile.write(page)

    def do_POST(self):
        return self.proxy("POST")

    def do_PATCH(self):
        return self.proxy("PATCH")

    def do_DELETE(self):
        return self.proxy("DELETE")

    def proxy(self, method):
        if not API_UPSTREAM:
            self.send_error(502, "no API upstream configured")
            return
        length = int(self.headers.get("Content-Length") or 0)
        body = self.rfile.read(length) if length else None
        req = urllib.request.Request(API_UPSTREAM + self.path, data=body, method=method)
        for header in ("Content-Type", "Authorization", "Host"):
            if self.headers.get(header):
                req.add_header(header, self.headers[header])
        try:
            with urllib.request.urlopen(req, timeout=30) as up:
                payload, status = up.read(), up.status
                ctype = up.headers.get("Content-Type", "application/json")
        except urllib.error.HTTPError as err:
            payload, status = err.read(), err.code
            ctype = err.headers.get("Content-Type", "application/json")
        except OSError as err:
            self.send_error(502, "API upstream unreachable: %s" % err)
            return
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def send_head(self):
        path = self.translate_path(self.path)
        if not os.path.exists(path) or os.path.isdir(path):
            self.path = "/index.html"
        return super().send_head()

    def log_message(self, *args):
        pass


def serve(directory):
    handler = functools.partial(SPAHandler, directory=directory)
    httpd = socketserver.ThreadingTCPServer(("127.0.0.1", 0), handler)
    httpd.daemon_threads = True
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    return httpd, "http://127.0.0.1:%d" % httpd.server_address[1]


def measure_js():
    src = open(PROBE, encoding="utf-8").read()
    return (src.replace("__MAIN_SELECTOR__", ".canvas, .gate")
               .replace("__RAIL_SELECTOR__", ".rail"))


def run_width(chrome, width, screens, base, session, workdir):
    frames = "\n".join(
        '<iframe id="f%d" width="%d" src="%s"></iframe>' % (i, width, base + s["path"])
        for i, s in enumerate(screens))
    host = (HOST.replace("__MEASURE__", measure_js())
                .replace("__IFRAMES__", frames)
                .replace("__SESSION__", json.dumps(session))
                .replace("__SCREENS__", json.dumps(screens))
                .replace("__W__", str(width)))
    route = "/__layout_probe_%d.html" % width
    PROBE_PAGES[route] = host.encode("utf-8")
    proc = subprocess.run([
        chrome, "--headless=new", "--disable-gpu", "--no-sandbox",
        "--hide-scrollbars",
        "--window-size=1700,1000", "--virtual-time-budget=30000",
        "--user-data-dir=" + os.path.join(workdir, "profile%d" % width),
        "--dump-dom", base + route,
    ], capture_output=True, text=True, timeout=300)
    m = re.search(r"RESULT(\{.*?\})</pre>", proc.stdout, re.S)
    if not m:
        raise RuntimeError("no result at %dpx.\nstderr tail:\n%s" % (width, proc.stderr[-1200:]))
    raw = (m.group(1).replace("&quot;", '"').replace("&amp;", "&")
                     .replace("&lt;", "<").replace("&gt;", ">"))
    return json.loads(raw)


def read_screens():
    if not os.path.exists(SCREENS):
        sys.exit(
            "the client exists but %s does not.\n"
            "List every route the client serves, so every route is measured:\n"
            '  [{"path": "/", "label": "gate"}, {"path": "/reception", "label": "board"}]'
            % os.path.relpath(SCREENS, ROOT))
    screens = json.load(open(SCREENS, encoding="utf-8"))
    if not screens:
        sys.exit("%s is empty." % os.path.relpath(SCREENS, ROOT))
    return screens


def main():
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--widths", type=int, nargs="+", default=DEFAULT_WIDTHS)
    ap.add_argument("--dist", default=DIST, help="built client directory")
    ap.add_argument("--api", help="base URL of a running API; /api is proxied to it")
    ap.add_argument("--token", help="staff session token, so signed-in screens render")
    ap.add_argument("--clinic", default="Layout Probe Clinic")
    ap.add_argument("-v", "--verbose", action="store_true")
    args = ap.parse_args()

    if not os.path.isdir(CLIENT):
        print("web/ does not exist yet; skipping the client layout check.")
        return 0

    chrome = find_chrome()
    if not chrome:
        print("No Chrome or Chromium found; skipping the client layout check.", file=sys.stderr)
        return 0

    screens = read_screens()

    global API_UPSTREAM
    API_UPSTREAM = (args.api or "").rstrip("/")
    session = {}
    if args.token:
        session = {"practix.token": args.token, "practix.clinicName": args.clinic,
                   "practix.mark": "Px"}
    else:
        # Every signed-in route redirects to the sign-in screen without a token,
        # so measuring them would measure that screen once per route.
        skipped = [s["label"] for s in screens if s.get("auth")]
        screens = [s for s in screens if not s.get("auth")]
        if skipped:
            print("No --token, so these signed-in screens are not measured: %s"
                  % ", ".join(skipped))
            print("The gate test in tests/gates/layout-integrity.test.ts supplies one.\n")
        if not screens:
            sys.exit("Every screen needs a session and none was given.")

    if not os.path.isdir(args.dist):
        sys.exit("No built client at %s. Build it first." % os.path.relpath(args.dist, ROOT))
    httpd, base = serve(args.dist)

    print("PractixOS client layout check — %d screens x %d widths against %s\n"
          % (len(screens), len(args.widths), base))

    failures, checked, signatures = [], 0, {}
    try:
        with tempfile.TemporaryDirectory(prefix="practix-client-layout-") as workdir:
            for width in args.widths:
                batch = run_width(chrome, width, screens, base, session, workdir)
                worst = 0
                if width == args.widths[0]:
                    for r in batch["results"]:
                        if not r.get("fatal"):
                            signatures[r["label"]] = r["sig"]
                for r in batch["results"]:
                    if r.get("fatal"):
                        print("  FATAL %4dpx  %-18s %s" % (width, r["label"], r["fatal"][:400]))
                        failures.append((width, r["label"], "JS error"))
                        continue
                    checked += 1
                    over = max(r["scroll"], r["bodyScroll"])
                    worst = max(worst, over)
                    problems = []
                    if not r["hasMain"]:
                        problems.append("no .canvas or .gate on this screen; §6.6 requires the "
                                        "client to share the prototype's structural vocabulary")
                    if over > 1 or r["offenders"]:
                        problems += ["%s.%s +%dpx" % (o["tag"], (o["cls"].split() or ["-"])[0], o["over"])
                                     for o in r["offenders"]] or ["document scrollWidth +%dpx" % over]
                    if r["hasMain"] and r["mainShortfall"] > 24 and width <= 1460:
                        problems.append("content only %dpx of %dpx (collapsed by %dpx)"
                                        % (r["mainWidth"], width, r["mainShortfall"]))
                    want = expected_lay(width)
                    if r["lay"] != want:
                        problems.append("data-lay is %r, the §6.6 ladder says %r at %dpx"
                                        % (r["lay"], want, width))
                    if problems:
                        detail = "; ".join(problems)
                        failures.append((width, r["label"], detail))
                        print("  FAIL  %4dpx  %-18s ->  %s" % (width, r["label"], detail))
                    elif args.verbose:
                        print("   ok   %4dpx  %-18s [%s]" % (width, r["label"], r["lay"]))
                print("  %4dpx  %d screens, worst overflow %dpx" % (width, len(batch["results"]), worst))
    finally:
        httpd.shutdown()

    # A signed-in screen that renders byte-for-byte like the sign-in screen did
    # not get measured; the client bounced it. This is exact rather than a
    # heuristic about duplicates, because two screens can legitimately look
    # alike when both are empty.
    public = [s["label"] for s in screens if not s.get("auth")]
    gate_sigs = {signatures[label] for label in public if label in signatures}
    bounced = [s["label"] for s in screens
               if s.get("auth") and signatures.get(s["label"]) in gate_sigs]

    print("\n" + "=" * 62)
    if bounced:
        print("These signed-in screens rendered as the sign-in screen, so they were")
        print("not measured: %s" % ", ".join(bounced))
        print("\nPass --token, or the run reports one screen several times over as")
        print("several passing screens.")
        print("=" * 62)
        return 1
    if failures:
        print("%d of %d client screens fail layout integrity." % (len(failures), checked))
        print("=" * 62)
        return 1
    print("Client layout intact. %d screens across %d widths."
          % (checked, len(args.widths)))
    print("=" * 62)
    return 0


if __name__ == "__main__":
    sys.exit(main())
