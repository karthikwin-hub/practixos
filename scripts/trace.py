#!/usr/bin/env python3
"""Requirement traceability gate for PractixOS.

    python3 scripts/trace.py

Reads   docs/spec/Dr.App.txt              the requirement universe
        docs/plan/BUILD-PROTOCOL.md       the scope map, `current:`, the waivers
        tests/, src/**/*.test.ts, ...     `@spec` tags
Writes  docs/plan/TRACEABILITY.md

Exits non-zero when a requirement scheduled into the milestone currently in
progress has no test claiming it, so this can gate a commit. Also non-zero when
a numbered section of the specification is scheduled nowhere and waived nowhere
— an agent once built four milestones without §6, the design system, because
nothing in the toolchain could see that no milestone owned it.

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
    """Return (requirements in document order, section ids, requirement -> section)."""
    if not SPEC.exists():
        sys.exit("Cannot find %s" % SPEC)

    requirements: list[str] = []
    sections: list[str] = []
    defined_in: dict[str, str] = {}
    seen: set[str] = set()
    top = ""
    sub = ""

    for line in SPEC.read_text(encoding="utf-8", errors="replace").split("\n"):
        m = TOP_HEADING.match(line)
        if m:
            top = m.group(1)
        m = SUB_HEADING.match(line)
        if m:
            sub = m.group(1)
            if sub not in sections:
                sections.append(sub)
        if top in DEFINING_SECTIONS:
            for rid in DEFINITION.findall(line):
                if rid not in seen:
                    seen.add(rid)
                    requirements.append(rid)
                    defined_in[rid] = sub

    return requirements, sections, defined_in


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


def read_waivers() -> dict[str, str]:
    """Parse the ```waived-sections block: `§5.1 — reason` per line.

    Waiving a spec section is how you say "this one carries no build obligation"
    in a way a reviewer can see and argue with. Silence is not an option, which
    is the whole point of orphan_sections() below.
    """
    text = PROTOCOL.read_text(encoding="utf-8", errors="replace")
    block = re.search(r"```waived-sections\n(.*?)```", text, re.S)
    if not block:
        sys.exit("No ```waived-sections block in %s" % PROTOCOL)

    waivers: dict[str, str] = {}
    for line in block.group(1).split("\n"):
        line = line.strip()
        if not line or line.startswith("#"):
            continue
        parts = re.split(r"\s[—–-]\s", line, maxsplit=1)
        sid = norm(parts[0])
        reason = parts[1].strip() if len(parts) > 1 else ""
        if not reason:
            sys.exit("Waiver for §%s has no reason. Every waiver states why." % sid)
        waivers[sid] = reason
    return waivers


def covers(section: str, ids) -> bool:
    """True when `section` is accounted for by any id in `ids`.

    An id accounts for a section if it is that section or sits inside it, so
    scheduling §4.4.1 accounts for §4.4 and a waiver on §9 accounts for §9.2.
    """
    return any(i == section or i.startswith(section + ".") for i in ids)


def orphan_sections(sections, scope, waivers, requirements, defined_in):
    """Spec subsections that are scheduled nowhere, waived nowhere, and empty of
    scheduled requirements. Each one is a piece of the specification that no
    milestone owns and nobody decided to drop."""
    scheduled = {rid for ids in scope.values() for rid in ids}
    # §8.1 is accounted for by the FR ids defined inside it, §7.3 by its BR ids.
    via_requirements = {defined_in[r] for r in scheduled if r in defined_in}

    return [
        s for s in sections
        if not covers(s, scheduled)
        and not any(s == w or s.startswith(w + ".") for w in waivers)
        and not covers(s, via_requirements)
    ]


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


def build_report(requirements, sections, current, scope, coverage, unknown, missing,
                 orphans, waivers):
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

    if orphans:
        out += [
            "## Specification sections that no milestone owns",
            "",
            "Each of these is a numbered section of the specification that is scheduled in no",
            "milestone, contains no scheduled requirement, and carries no waiver. Schedule it in",
            "the scope map, or waive it with a reason in the `waived-sections` block — both live",
            "in [BUILD-PROTOCOL.md](BUILD-PROTOCOL.md) §4.",
            "",
        ] + ["- `§%s`" % s for s in orphans] + [""]

    if missing:
        out += [
            "## Gate failure — M0 through %s are incomplete" % current,
            "",
            "Scheduled into a milestone already reached, with no test claiming them:",
            "",
        ] + ["- `%s` (%s)" % (rid, milestone_of(rid, scope)) for rid in missing] + [
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

    out += [
        "",
        "## Waived specification sections",
        "",
        "Sections judged to carry no build obligation. Listed here so the judgement is visible",
        "rather than implied by absence.",
        "",
        "| Section | Why |",
        "| --- | --- |",
    ] + ["| `§%s` | %s |" % (s, waivers[s]) for s in sorted(waivers)]

    return "\n".join(out) + "\n"


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--check", action="store_true",
                    help="verify only; do not rewrite TRACEABILITY.md")
    args = ap.parse_args()

    requirements, sections, defined_in = read_spec()
    current, scope = read_scope_map()
    waivers = read_waivers()
    coverage = read_tests()

    known = set(requirements) | set(sections)
    unknown = [(m, rid) for m in sorted(scope) for rid in scope[m] if rid not in known]
    orphans = orphan_sections(sections, scope, waivers, requirements, defined_in)

    # Every milestone up to and including the current one, not just the current
    # one. "Do not begin M(n+1) until M(n) passes" means M0..M(current) all hold;
    # gating only the current milestone lets a finished one quietly lose coverage,
    # and lets an id added to a finished milestone never be asked for at all.
    n = int(current[1:])
    reached = [m for m in sorted(scope, key=lambda k: int(k[1:])) if int(m[1:]) <= n]
    missing = [rid for m in reached for rid in scope[m] if not coverage.get(rid)]

    report = build_report(requirements, sections, current, scope, coverage, unknown, missing,
                          orphans, waivers)
    if not args.check:
        OUT.write_text(report, encoding="utf-8")

    print("PractixOS traceability — %s in progress, %d requirements defined, %d covered"
          % (current, len(requirements), sum(1 for r in requirements if coverage.get(r))))

    if unknown:
        print("\n  Scope map references ids that do not exist in the specification:")
        for m, rid in unknown:
            print("    %-10s %s" % (m, rid))
        return 2

    if orphans:
        print("\n  Specification sections that no milestone owns and no waiver covers:")
        for s in orphans:
            print("    §%s" % s)
        print("\n  Schedule each one in the milestone-map, or waive it with a reason in the")
        print("  waived-sections block. Both are in docs/plan/BUILD-PROTOCOL.md section 4.")
        return 2

    if missing:
        print("\n  M0 through %s are incomplete. No test claims these ids:" % current)
        for rid in missing:
            print("    %-10s %s" % (milestone_of(rid, scope), rid))
        print("\n  Tag a test with `@spec <id>`, or reschedule the id in the scope map")
        print("  in docs/plan/BUILD-PROTOCOL.md and record why in spec section 0.1.")
        return 1

    print("  M0 through %s complete: every scheduled id is claimed by a test." % current)
    if not args.check:
        print("  Wrote %s" % OUT.relative_to(ROOT))
    return 0


if __name__ == "__main__":
    sys.exit(main())
