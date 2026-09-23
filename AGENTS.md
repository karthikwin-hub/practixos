# AGENTS.md — the contract for building PractixOS

You are building a clinical product that will hold Indian patients' medical records under the DPDP
Act. Several of the guarantees in the specification are the only reason a clinic can be asked to put
patient data into it at all. Treat them as load-bearing, not as features.

Read this file completely before your first edit. Then read
[docs/plan/BUILD-PROTOCOL.md](docs/plan/BUILD-PROTOCOL.md), which is the long form of everything
below.

---

## 1. What exists today

| Path | State |
| --- | --- |
| `docs/spec/Dr.App.txt` | **The specification, v2.2. Normative.** 13 sections, ~36 numbered requirements. |
| `docs/spec/Dr.App.Spec.html` | The same document, generated. Never edit directly. |
| `docs/plan/IMPLEMENTATION-PLAN.md` | The engineering plan: architecture decisions, schema, M0–M6. |
| `prototype/PractixOS.html` | A working single-file prototype. Reference behaviour, not production code. |
| `prototype/harness.js` | 786 logic assertions over the prototype. |
| `prototype/check-layout.py` | 630 layout screens, 7 widths, asserts no overflow and no collapse. |
| `src/`, `migrations/`, `infra/` | **Do not exist yet.** M0 creates them. |

There is no production code, no database and no patient data in this repository today.

## 2. Source of truth, in order

1. **`docs/spec/Dr.App.txt`** — what the product must do. If something contradicts this, this wins.
2. **`docs/plan/IMPLEMENTATION-PLAN.md`** — how it gets built. It deliberately overrides the
   specification's §4.1 technical architecture in six places, each marked **DEVIATION**. Those six
   are settled; do not relitigate them.
3. **`prototype/PractixOS.html`** — how it should behave and feel. When the spec is ambiguous about
   an interaction, the prototype is the tiebreaker. It is not a source for production structure.

Your own judgement ranks below all three. If you believe one of them is wrong, say so and stop —
see §7.

## 3. Spec-driven: no code without an id

Every change traces to an identifier that already exists in the specification: `FR-1.1.2`, `BR-02`,
`§4.6.1`, or a named non-functional requirement from §8.2.

```
1. Quote the requirement you are implementing, by id, in the PR or commit body.
2. Write the failing test first, tagged with that id (§4).
3. Implement the smallest thing that passes it.
4. Run ./scripts/verify.sh. All green, or you are not done.
5. Regenerate docs/plan/TRACEABILITY.md.
```

**If the specification is wrong, silent or contradictory, you amend the specification first.** Add a
row to the §0.1 revision log saying what changed and why, regenerate the HTML with
`python3 docs/spec/build-spec-html.py`, and only then write code. Reinterpreting a requirement in
your head and coding to the reinterpretation is the single most damaging thing you can do here,
because it is invisible in the diff.

Inventing a requirement that has no id is the same offence.

## 4. Test-driven: the test carries the id

Specification §10.1 already requires this: the verification gates "run on every pull request, they
block merge, **and they are written before the code they protect**."

Every test file carries a machine-readable tag that `scripts/trace.py` reads:

```ts
/** @spec FR-2.2 — walk-in creation needs only mobile number and name, under 10 seconds. */
test("walk-in registration creates patient and per-practitioner token", async () => { ... });
```

An id with no test covering it, inside the milestone currently in progress, fails the build.

**Gate tests run against a real PostgreSQL container with the real policies applied.** The spec says
it plainly: "An isolation test that does not execute `CREATE POLICY` is testing the test." Mocking
the database in a gate test is worse than having no gate, because it reports green.

## 5. Milestone discipline

Milestones are defined in specification §10 and elaborated in plan §5. Each has a written exit
criterion. **Do not begin M(n+1) until M(n)'s exit criterion passes as a named acceptance test.**

M0 is not negotiable and comes first. Its exit criterion is that all four verification gates run
green in CI **before a single business endpoint exists**:

| Gate | Asserts |
| --- | --- |
| Tenant isolation | Two tenants interleaved over a pool of size 1 never see each other's rows; an unset context reads zero rows |
| BR-02 concurrency | N simultaneous bookings on one chair and overlapping range produce exactly one appointment |
| Vault non-recoverability | Plaintext is unrecoverable from a full dump plus every server-held secret, without the patient PIN |
| Layout integrity | Every view, every tenant, seven widths: no horizontal overflow, no collapsed content |

Each gate is cheaper to write against an empty schema than to retrofit against a full one, which is
why they come first rather than at a review.

## 6. Prohibitions

These are settled decisions from plan §1. Violating one is a defect even if the code works.

**Architecture**
- No ORM-generated migrations. Plain SQL, explicit `down` for every `up` (plan §1.10).
- No Redis, no Kubernetes, no API gateway, no separate microservices, no server-side rendering.
- No second stateful system. Jobs run on pg-boss inside PostgreSQL.
- No commercial licence anywhere in the production path.

**Tenancy — the highest-severity trap in this codebase**
- Never `SET app.clinic_id`. It is session-scoped, survives release back to the pool, and hands the
  next request the previous tenant's data with no error. Use `SET LOCAL` via
  `set_config('app.clinic_id', $1, true)` inside an explicit transaction, through the single
  `withTenant()` accessor.
- Never call `pool.query` or `pool.connect` outside `src/db/tenant.ts`.
- Never interpolate a tenant id into SQL text.

**Verticalisation**
- **No code may branch on `clinics.vertical`.** No `if`, no `switch`, no ternary, no lookup keyed on
  it. The column seeds configuration at onboarding and is otherwise inert. This is the whole of the
  M4 thesis and `harness.js` already fails the build on it for the prototype.

**Residency and hosting**
- Production runs on OCI `ap-mumbai-1`. Never on Azure credits, never on Vercel, never behind a
  proxy that terminates TLS outside India. Cloudflare is DNS only.

**Security**
- Argon2id, never SHA-256 or bare PBKDF2, for passwords and for the vault.
- The vault has no administrator override. If you can write a code path that decrypts a note without
  the patient's PIN, the requirement is broken.
- `audit_log` and the recovered-revenue ledger are append-only at the database grant level.

**Testing**
- No mocked PostgreSQL in a gate test.
- Never weaken or skip a failing gate to make a build pass. A red gate is information.

## 7. Stop and ask

Do not guess. Stop and ask when:

- The specification is silent, ambiguous or self-contradictory on what you are about to build.
- A requirement appears to conflict with another requirement, or with a plan DEVIATION.
- You are about to touch one of the four open questions in plan §8 — payment service provider,
  Konkani reviewer, Azure Investor Network eligibility, pilot clinics. These are unresolved
  business decisions. Do not invent a PSP or pick a vendor.
- A gate fails and the fix is not obviously in your own change.
- The work needs a credential, an external account, or a certification you do not have.

Asking costs a message. Guessing costs a rewrite, and in this domain it can cost a reportable
breach.

## 8. Verification

One command. Run it before you claim anything is done.

```bash
./scripts/verify.sh
```

It runs lint, typecheck, unit tests, the four gates, the prototype harness, the layout check and the
traceability gate. Steps whose tooling does not exist yet are skipped with a notice, so it is useful
from the first commit of M0 and tightens as the build lands.

Do not report a milestone complete on the strength of reading the code. Report it on the strength of
a green run and the named acceptance test for that milestone's exit criterion.
