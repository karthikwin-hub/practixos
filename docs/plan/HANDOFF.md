# Open work on `m0-m4-local-deployment`

M0–M4 are built. This is what is left before M5 can start, and why each item is
here rather than done. Read [AGENTS.md](../../AGENTS.md) and
[BUILD-PROTOCOL.md](BUILD-PROTOCOL.md) first — both changed, and the changes are
the reason this file exists.

## What changed in the rules, and why it matters to you

The interface is the part the build got wrong. An earlier run took M0–M4 to
completion with a placeholder UI and a green build, because nothing in the
toolchain could see the gap:

- `AGENTS.md` §2 said the prototype "is not a source for production structure",
  which was meant as *do not copy its single-file organisation* and read as *do
  not build the UI from this*. It now separates the two explicitly.
- `.cursor/rules/client-mobile-first.mdc` globbed `src/client/**`. The client is
  at `web/`. **The rule never loaded once.** It now globs `web/**` and covers the
  design system, not only touch ergonomics.
- Specification §6, the whole design system, was scheduled into no milestone.
  `scripts/trace.py` is now default-deny on spec sections, so that cannot recur.
- The layout gate measured `prototype/PractixOS.html`, which the build never
  touches, and was therefore green regardless of the product. It now also
  measures the built client.

## The ten uncovered ids

`python3 scripts/trace.py` prints this list and fails until it is empty.

| Id | Milestone | What a test has to show |
| --- | --- | --- |
| `§4.4.3` | M0 | `audit_log` is append-only **at the grant level** — `UPDATE` and `DELETE` are refused to the application role, not merely unused by it |
| `§4.4.5` | M0 | The core schema extract matches what the migrations actually produce: `FORCE` RLS on every tenant-scoped table, `btree_gist`, the audit trigger |
| `§5.4` | M0 | The production topology is what §5.4 describes — services, ports, volumes, and the roles they connect as |
| `§5.6` | M0 | The restore drill runs unattended and the restored database answers a query. `scripts/restore-drill.sh` exists; nothing asserts its result |
| `§4.3` | M1 | The client tier is a static PWA reading Dexie first, per plan §1 DEVIATION 5 |
| `§4.5` | M1 | Each external adapter is behind one interface, and a failure in one does not take the request down |
| `§6.1` | M1 | Clinical Ink: the client's custom properties are the prototype's, not a re-derivation |
| `§6.3` | M1 | **Self-hosted subsetted Indic fonts. Not implemented at all — see below.** |
| `§6.4` | M1 | Undo with an eight-second window and no confirmation dialog; keypads for vitals, fees and tooth numbers; motion 150–200 ms |
| `§6.2` | M2 | Six role modes as six distinct visual registers over shared components |

`§4.1` and `§4.2` are waived, not scheduled: plan §1 overrides both in six places
marked DEVIATION, so a test that the system matches them would assert against a
settled decision. The reasoning is in BUILD-PROTOCOL §4.2.

## Two product defects, not just missing tests

**§6.3 — there are no self-hosted fonts.** No `@font-face`, no `woff2`, no
`unicode-range` anywhere in `web/`. `web/src/styles.css` sets
`"Nirmala UI", "Noto Sans", sans-serif`, and §6.3 names a system font stack as
specifically *not* self-hosting. The failure mode is the one the specification
calls out: on the low-cost Android handsets this product targets, Telugu and
Bengali render as rows of empty boxes — on precisely the hardware the
localisation was built for. Ship subsetted `woff2` per script, built at package
time, checked into the artifact, loaded per language with `unicode-range` and
`font-display: swap`.

**The patient Doorway needs a staff token.** `web/src/App.tsx:122` reads
`if (route.startsWith("#/setup") || !token()) return <Gate />;`, so `#/book`
renders the staff sign-in screen to a patient. §6.2 describes the Doorway as the
patient's surface, "used once, under stress, possibly by someone who does not
read comfortably". Whether the patient surface should be a separate entry point
or an unauthenticated route is a design question the specification does not
settle — **stop and ask before choosing**, per AGENTS.md §7.

`web/src/styles.css` also still imports Tailwind and sets a background of
`#f4f1ea`, which fights `clinical.css`'s `--paper: #FBFAF7`. That looks like
placeholder-era residue rather than a decision.

## Running the client layout gate

It needs a signed-in, populated client, so it runs from the gate test rather
than standing alone:

```bash
npm --prefix web run build     # the gate skips without web/dist
npm run test:gates             # boots the API, seeds a clinic, measures
```

Standalone, it measures only the screens marked `"auth": false` in
`web/layout-screens.json` and says so. A signed-in screen that renders as the
sign-in screen fails the run rather than passing as a measured screen — that
guard exists because the first version of this gate reported "56 screens passed"
having measured one screen 56 times.

Every route the client serves belongs in `web/layout-screens.json`. A route
absent from it is a route nobody checks.
