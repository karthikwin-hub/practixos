#!/usr/bin/env python3
"""Requirement traceability gate for PractixOS.

    python3 scripts/trace.py

Reads   docs/spec/Dr.App.txt              the requirement universe
        docs/plan/BUILD-PROTOCOL.md       the milestone scope map and `current:`
        tests/, src/**/*.test.ts, ...     `@spec` tags
Writes  docs/plan/TRACEABILITY.md

Exits non-zero when a requirement scheduled into the milestone currently in
progress has no test claiming it, so this can gate a commit.

Why the scope map lives in BUILD-PROTOCOL.md rather than here: a hand-copied
list in this file would silently stop matching the plan the first time the plan
changed. Same reason check-layout.py parses its tenant list out of the
prototype instead of restating it.

No third-party dependencies, so it runs anywhere Python 3 does.
"""

import argparse
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SPEC = ROOT / "docs" / "spec" / "Dr.App.txt"
PROTOCOL = ROOT / "docs" / "plan" / "BUILD-PROTOCOL.md"
OUT = ROOT / "docs" / "plan" / "TRACEABILITY.md"

# Where a test may live. Globs are relative to the repository root.
TEST_GLOBS = [
    "tests/**/*.ts", "tests/**/*.tsx", "tests/**/*.js", "tests/**/*.sql",
    "acceptance/**/*.ts", "acceptance/**/*.js",
    "src/**/*.test.ts", "src/**/*.test.tsx", "src/**/*.spec.ts",
]

# A requirement is *defined* where its id opens a bold run: `**FR-2.2** — ...`
# or `**BR-01 — Dynamic follow-up rule policy**`. Elsewhere in the document the
# same id appears unbolded, in prose and in the milestone table, and those are
# references rather than definitions.
DEFINITION = re.compile(r"\*\*(FR-\d+(?:\.\d+)*|BR-\d+)\b")

# Definitions only count inside the BRD and the PRD.
DEFINING_SECTIONS = {"7", "8"}

TOP_HEADING = re.compile(r"^## (\d+)\.")
SUB_HEADING = re.compile(r"^#{3,4} (\d+(?:\.\d+)+)\s")

# `@spec FR-2.2` or `@spec FR-1.5, BR-02` or `@spec §4.6.1`
SPEC_TAG = re.compile(r"@spec\s+([^\n*]+)")
ID_IN_TAG = re.compile(r"§?((?:FR|BR)-\d+(?:\.\d+)*|\d+\.\d+(?:\.\d+)*)")


def norm(raw: str) -> str:
    """`§4.6.1` and `4.6.1` are the same id. FR and BR ids are already canonical."""
    return raw.strip().lstrip("§").strip()


# --------------------------------------------------------------------------- #
# The specification
# --------------------------------------------------------------------------- #
def read_spec():
    """Return (requirements in document order, section ids that exist)."""
    if not SPEC.exists():
        sys.exit("Cannot find %s" % SPEC)

    requirements: list[str] = []
    sections: set[str] = set()
    seen: set[str] = set()
    top = ""

    for line in SPEC.read_text(encoding="utf-8", errors="replace").split("\n"):
        m = TOP_HEADING.match(line)
        if m:
            top = m.group(1)
        m = SUB_HEADING.match(line)
        if m:
            sections.add(m.group(1))
        if top in DEFINING_SECTIONS:
            for rid in DEFINITION.findall(line):
                if rid not in seen:
                    seen.add(rid)
                    requirements.append(rid)

    return requirements, sections


# --------------------------------------------------------------------------- #
# The milestone scope map
# --------------------------------------------------------------------------- #
def read_scope_map():
    """Parse the ```milestone-map fenced block out of BUILD-PROTOCOL.md."""
    if not PROTOCOL.exists():
        sys.exit("Cannot find %s" % PROTOCOL)

    text = PROTOCOL.read_text(encoding="utf-8", errors="replace")
    block = re.search(r"```milestone-map\n(.*?)```", text, re.S)
    if not block:
        sys.exit("No ```milestone-map block in %s" % PROTOCOL)

    current = ""
    scope: dict[str, list[str]] = {}
    for line in block.group(1).split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        key, _, rest = line.partition(":")
        key, rest = key.strip(), rest.strip()
        if key == "current":
            current = rest
        elif re.fullmatch(r"M\d+", key):
            scope[key] = [norm(p) for p in rest.split(",") if p.strip()]

    if not current:
        sys.exit("The milestone-map block has no `current:` line.")
    if current not in scope:
        sys.exit("current is %s but the map has no %s line." % (current, current))
    return current, scope


# --------------------------------------------------------------------------- #
# Tests
# --------------------------------------------------------------------------- #
def read_tests():
    """Map requirement id -> sorted list of 'path:line' claiming it."""
    coverage: dict[str, list[str]] = {}
    for pattern in TEST_GLOBS:
        for path in sorted(ROOT.glob(pattern)):
            if not path.is_file():
                continue
            rel = path.relative_to(ROOT).as_posix()
            for n, line in enumerate(
                path.read_text(encoding="utf-8", errors="replace").split("\n"), 1
            ):
                for tag in SPEC_TAG.findall(line):
                    # Stop at the first prose separator so a trailing sentence
                    # after the ids is not scanned for stray numbers.
                    head = re.split(r"[—\-–]{1,2}\s|\.\s", tag, maxsplit=1)[0]
                    for rid in ID_IN_TAG.findall(head):
                        coverage.setdefault(norm(rid), []).append("%s:%d" % (rel, n))
    return coverage


# --------------------------------------------------------------------------- #
# Report
# --------------------------------------------------------------------------- #
def milestone_of(rid: str, scope: dict[str, list[str]]) -> str:
    for milestone in sorted(scope):
        if rid in scope[milestone]:
            return milestone
    return ""


def build_report(requirements, sections, current, scope, coverage, unknown, missing):
    ordered = sorted(scope)
    scheduled = {rid for ids in scope.values() for rid in ids}

    # Everything worth reporting: requirements defined in the spec, plus the
    # architectural section ids the scope map schedules.
    rows = list(requirements) + [r for r in sorted(scheduled) if r not in requirements]

    out = [
        "# PractixOS — requirement traceability",
        "",
        "Generated by `scripts/trace.py`. Do not edit by hand; edit the tests or the",
        "scope map in [BUILD-PROTOCOL.md](BUILD-PROTOCOL.md) and regenerate.",
        "",
        "There is deliberately no timestamp in this file, so it changes only when",
        "coverage changes and a regression is visible in the diff.",
        "",
        "```",
        "milestone in progress   %s" % current,
        "requirements defined    %d" % len(requirements),
        "scheduled into M0-M%d    %d" % (len(ordered) - 1, len(scheduled)),
        "covered by a test       %d" % sum(1 for r in rows if coverage.get(r)),
        "```",
        "",
    ]

    if unknown:
        out += [
            "## Scope map references ids that are not in the specification",
            "",
            "These are typos in the map, or requirements deleted from the spec without",
            "being unscheduled. Fix the map.",
            "",
        ] + ["- `%s` (in %s)" % (rid, m) for m, rid in unknown] + [""]

    if missing:
        out += [
            "## Gate failure — %s is incomplete" % current,
            "",
            "Scheduled into %s with no test claiming them:" % current,
            "",
        ] + ["- `%s`" % rid for rid in missing] + [
            "",
            "Tag a test with `@spec <id>`, or move the id to a later milestone in the",
            "scope map and say why in the specification's section 0.1 revision log.",
            "",
        ]

    unassigned = [r for r in requirements if r not in scheduled]
    if unassigned:
        out += [
            "## Defined but not scheduled",
            "",
            "Present in the specification, absent from every milestone. Not a build",
            "failure, but each one is either forgotten work or an implicit Phase 2",
            "decision that nobody wrote down.",
            "",
        ] + ["- `%s`" % rid for rid in unassigned] + [""]

    out += [
        "## Coverage",
        "",
        "| Requirement | Milestone | Covered by |",
        "| --- | --- | --- |",
    ]
    for rid in rows:
        where = coverage.get(rid, [])
        cell = "<br>".join("`%s`" % w for w in sorted(set(where))) if where else "—"
        out.append("| `%s` | %s | %s |" % (rid, milestone_of(rid, scope) or "—", cell))

    out += [
        "",
        "## Milestone scope",
        "",
        "| Milestone | Requirements | Covered |",
        "| --- | --- | --- |",
    ]
    for m in ordered:
        ids = scope[m]
        done = sum(1 for r in ids if coverage.get(r))
        mark = " **(in progress)**" if m == current else ""
        out.append("| %s%s | %d | %d |" % (m, mark, len(ids), done))

    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="verify only; do not rewrite TRACEABILITY.md")
    args = ap.parse_args()

    requirements, sections = read_spec()
    current, scope = read_scope_map()
    coverage = read_tests()

    known = set(requirements) | sections
    unknown = [(m, rid) for m in sorted(scope) for rid in scope[m] if rid not in known]
    missing = [rid for rid in scope[current] if not coverage.get(rid)]

    report = build_report(requirements, sections, current, scope, coverage, unknown, missing)
    if not args.check:
        OUT.write_text(report, encoding="utf-8")

    print("PractixOS traceability — %s in progress, %d requirements defined, %d covered"
          % (current, len(requirements), sum(1 for r in requirements if coverage.get(r))))

    if unknown:
        print("\n  Scope map references ids that do not exist in the specification:")
        for m, rid in unknown:
            print("    %-10s %s" % (m, rid))
        return 2

    if missing:
        print("\n  %s is incomplete. No test claims these ids:" % current)
        for rid in missing:
            print("    %s" % rid)
        print("\n  Tag a test with `@spec <id>`, or reschedule the id in the scope map")
        print("  in docs/plan/BUILD-PROTOCOL.md and record why in spec section 0.1.")
        return 1

    print("  %s complete: every scheduled id is claimed by a test." % current)
    if not args.check:
        print("  Wrote %s" % OUT.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
