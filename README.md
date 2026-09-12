# PractixOS

A verticalized practice operating system for independent outpatient clinics in India. Phase 1 targets two verticals: dental practices and mental health counselling.

This repository holds the product specification, the engineering plan, and a working interactive prototype.

## Try the prototype

`prototype/PractixOS.html` is a single self-contained file with no build step and no dependencies. Open it in a browser, or visit the deployment.

It opens on a workspace picker. Three tenants are seeded:

| Workspace | Vertical | Languages | Deep link |
| --- | --- | --- | --- |
| Aarav Dental Arts, Bengaluru | Dental | English, Marathi, Telugu | `?clinic=aarav-dental` |
| Anandi Mind & Wellness, Pune | Counselling | English, Marathi, Konkani | `?clinic=anandi-wellness` |
| Sushrut Family Polyclinic, Hyderabad | Polyclinic | English, Telugu, Bengali | `?clinic=sushrut-polyclinic` |

Append `&as=<module>` to land directly in a role, for example `?clinic=aarav-dental&as=reception`. Modules are `reception`, `nurse`, `dental`, `therapy`, `consultant`, `owner`, `patient`, plus `isolation`, `whatsapp`, `coverage`, `roadmap` and `system`.

The therapy vault demo PIN is **1234**.

### What is real and what is simulated

Real: the fee rules, the double-booking conflict checks, AES-256-GCM encryption of session notes with a PBKDF2-derived key, per-tenant data scoping, the append-only audit trail, and every layout.

Simulated: persistence (all state is in memory and resets on reload), payments, WhatsApp delivery, and the workspace directory, which is a constant rather than a database table.

## What is worth looking at first

**Tenant isolation.** The same mobile number is seeded into two workspaces as two unrelated records. At Aarav Dental that patient carries a penicillin allergy and an in-progress root canal; at Sushrut he is a first-time visitor with no alerts and no chart, and the follow-up fee rule returns a different answer for him on the same day. Both are correct. The Isolation panel also runs a live cross-workspace read, which returns zero rows rather than an authorization error — a denial would confirm the record exists.

**Mobile first.** The phone is the design target. Tablet and desktop add density, never capability. Layout follows the viewport by default and can be pinned per device to Compact, Tablet or Full from the header or the More sheet.

**Verticalization is structural.** The dental workspace has no therapy module and the counselling practice has no odontogram. They are not hidden in navigation; they are not provisioned.

## Repository layout

```
prototype/PractixOS.html      the prototype, one self-contained file
prototype/check-layout.py     layout regression check, headless Chrome
docs/spec/Dr.App.txt          product specification, v2.1 (Markdown)
docs/spec/Dr.App.Spec.html    the same specification, indexed and searchable
docs/spec/build-spec-html.py  regenerates the HTML from the Markdown
docs/plan/                    engineering plan and architecture decisions
docs/shots/                   review screenshots, phone and desktop
```

## Checks

Layout, across every view, every tenant and seven widths from 320 px to 1280 px. Asserts neither horizontal overflow nor collapsed content, and exits non-zero on failure. Needs Chrome or Chromium; skips cleanly if neither is present.

```bash
python3 prototype/check-layout.py
python3 prototype/check-layout.py --shots docs/shots   # also refresh the screenshots
```

Regenerate the indexed specification after editing `Dr.App.txt`:

```bash
python3 docs/spec/build-spec-html.py
```

## Deployment

Static, no build step. `vercel.json` rewrites `/` to the prototype and `/spec` to the indexed specification.

## Status

Prototype and specification only. No production code, no database, no patient data.
