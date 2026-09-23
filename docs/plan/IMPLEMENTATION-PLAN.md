# PractixOS — Engineering Implementation Plan

Status: draft for review
Last updated: 11 September 2026
Companion documents: [Dr.App.txt](../spec/Dr.App.txt) (product specification v2.0) · [Dr.App.Spec.html](../spec/Dr.App.Spec.html) (indexed reading copy of the same document) · [PractixOS.html](../../prototype/PractixOS.html) (interactive prototype)

---

## 0. How to read this document

The product specification describes *what* PractixOS must do. This document describes *how* it gets built, *what it costs*, and *where the specification is wrong*.

Section 1 is the architecture decision record, including six places where this plan deliberately deviates from the specification's proposed technical architecture. Sections 2 to 4 cover data, security and integrations. Section 5 is the delivery schedule. Sections 6 and 7 cover compliance and risk.

Every deviation from the specification is marked **DEVIATION** with the reasoning attached, so that a reviewer can accept or reject each one independently.

---

## 1. Architecture decision record

### 1.1 What the specification gets right

These are settled and this plan adopts them without change:

- **Offline-first Progressive Web App.** Non-negotiable in Indian clinic conditions. This is also the availability strategy, not merely a convenience — see 1.8.
- **IndexedDB via Dexie.js** for the local mirror.
- **PostgreSQL** as the system of record.
- **India-only data residency.** A legal requirement under the DPDP Act 2023, not a preference.
- **Direct Meta WhatsApp Cloud API** rather than a reseller. Resellers add 30 to 100 percent to per-message cost, and messaging is the single largest variable cost in the business.
- **Client-side encryption for psychotherapy notes.** The right instinct, though the specification's key derivation is not strong enough. See 3.2.
- **Bhashini for Indic voice.** Government-operated, free or heavily subsidised, and better on Indian languages than commercial alternatives.

### 1.2 The core problem with the proposed server architecture

The specification's own numbers contradict each other.

Section 3.2 targets **under ₹250 per active clinic per month** in hosting and database compute. Section 4.1 then specifies Cloudflare Enterprise, Kong API Gateway, three separate application services, Aurora Serverless PostgreSQL in Multi-AZ, ECS Fargate, and a Redis 7 cluster.

Priced out at the smallest viable configuration:

| Component as specified | Approximate monthly cost |
| --- | --- |
| Cloudflare Enterprise | $5,000 floor |
| Aurora Serverless v2, Multi-AZ, minimum ACUs | $90–130 |
| ECS Fargate, three services, two tasks each | $120–200 |
| ElastiCache Redis cluster | $50–90 |
| Kong (self-managed, its own database and compute) | $40–70 |
| ALB, NAT Gateway, egress | $60–120 |

Excluding Cloudflare Enterprise, that is roughly **₹35,000 to ₹60,000 per month before the first clinic signs up**. Including it, it is off the chart. The architecture is sized for five thousand clinics and would be paid for while serving fifty.

This plan replaces it with an architecture that costs **₹0 per month at pilot scale** and stays under the specification's own ₹250 target at every subsequent stage.

### 1.3 DEVIATION 1 — Cloudflare Enterprise becomes Caddy in Mumbai

**Specified:** Cloudflare Enterprise Edge for WAF, DDoS protection and SSL termination.

**Instead:** [Caddy](https://caddyserver.com/) (Apache 2.0) with the [Coraza](https://coraza.io/) WAF module (Apache 2.0, OWASP Core Rule Set compatible), running on the application host in Mumbai. Cloudflare is used for DNS only, on the free plan, with proxying disabled.

**Why:** Cloudflare Enterprise starts around $5,000 per month; every capability the specification asks of it — WAF, DDoS mitigation, TLS termination — is available on Cloudflare's free plan anyway, so the Enterprise line item appears to be an error rather than a decision.

More importantly, proxying through Cloudflare terminates TLS outside India. The DPDP Act governs storage rather than transit, and many Indian fintechs accept foreign edge termination, but PractixOS will be selling into clinics and eventually hospital procurement, where "all patient traffic terminates in Mumbai" is a clean, unarguable answer. Caddy gives us that, obtains and renews certificates automatically, and costs nothing.

### 1.4 DEVIATION 2 — No API gateway tier

**Specified:** Kong API Gateway performing OAuth2 and JWT validation.

**Instead:** Authentication and authorisation live in the application. Caddy is the only reverse proxy.

**Why:** An API gateway solves a problem created by having many services owned by many teams. We have one service and one team. Kong would add a component with its own database, its own upgrade cycle and its own failure modes, in exchange for functionality that is roughly forty lines of middleware. If a genuine gateway need appears later, Caddy or Traefik covers it without introducing Kong.

Session management uses [Better Auth](https://www.better-auth.com/) (MIT) rather than standing up Keycloak. Keycloak is excellent and appropriate when enterprise SSO is a requirement; it is a heavy dependency to carry for a product whose users are receptionists logging into a tablet.

### 1.5 DEVIATION 3 — Modular monolith, not three services

**Specified:** Core Ops Service, Specialty Service and Sync Service as separate deployables.

**Instead:** One deployable, with enforced module boundaries in the codebase. The calendar and webhook sync worker is the only separate process, because it is genuinely asynchronous.

**Why:** Consider the specification's own primary workflow — booking a dental appointment. It requires a chair availability check (Core Ops), an odontogram-linked treatment plan (Specialty) and a calendar availability block (Sync). Under the proposed split, one user action becomes a distributed transaction across three services with no shared database and therefore no shared transaction. You would need sagas, compensating actions and eventual-consistency handling to solve a problem that a single `BEGIN` solves for free.

Module boundaries are enforced at the source level:

```
src/
  modules/
    scheduling/     # appointments, chairs, queue, follow-up rules
    clinical/       # odontogram, treatment plans, vitals, allergies
    vault/          # encrypted psychotherapy records
    billing/        # invoices, UPI, fee splits, reconciliation
    messaging/      # WhatsApp templates, dispatch, webhooks
    abdm/           # ABHA, FHIR bundles, DHIS accounting
    sync/           # Google and Microsoft calendar adapters
  platform/         # db, auth, audit, jobs, config
```

Cross-module access goes through each module's exported service interface, never directly into another module's tables. A lint rule enforces this. That preserves the option to extract a service later — at a point where the extraction is justified by load rather than by an architecture diagram.

### 1.6 DEVIATION 4 — Plain PostgreSQL, not Aurora; pg-boss, not Redis

**Specified:** Aurora Serverless PostgreSQL Multi-AZ, plus a Redis 7 cluster for live token state and distributed locks.

**Instead:** PostgreSQL 16, self-managed on the application host initially. Job queues run on [pg-boss](https://github.com/timgit/pg-boss) (MIT) inside the same database. Live queue state propagates over Postgres `LISTEN/NOTIFY` into a WebSocket.

**Why:** Aurora is a managed convenience wrapped around a Postgres-compatible engine, at roughly ten times the price of Postgres. Nothing in the requirements needs Aurora's read scaling or storage architecture.

Redis is a second stateful system to operate, back up and monitor. Our job volume is modest and thoroughly bounded — WhatsApp sends, ABDM pushes, reminder scheduling — and pg-boss handles all of it transactionally alongside the data the jobs act on, which actually removes a class of bug where a job fires for a transaction that later rolled back. Distributed locks become Postgres advisory locks.

When Redis eventually earns its place, use **Valkey** (BSD-3, Linux Foundation) rather than Redis, following Redis's 2024 relicensing.

### 1.7 DEVIATION 5 — Static PWA shell, not server-side rendering

**Specified:** Next.js with React 18 and Tailwind, configured as a PWA.

**Instead:** Vite + React + Tailwind, built as a **statically served PWA shell**, with a Fastify API behind it. Public clinic portal pages are pre-rendered to static HTML whenever a clinic profile changes.

**Why:** Two reasons, one architectural and one economic.

Architecturally, server-side rendering and offline-first are in tension. Every authenticated screen in PractixOS must render from IndexedDB when the network is down; that means the client already owns rendering. SSR would produce a first paint that the client immediately has to reconcile against local state, which is work and a source of hydration bugs, for no benefit.

Economically, our production host has two CPU cores (see 1.9). Serving a static bundle from Caddy costs approximately zero CPU. An SSR process serving the same pages does not.

The one genuine SSR use case is FR-1.1, the public `drsharma.practix.in` portal, which needs to be indexable. That is solved by pre-rendering those pages on profile change — a handful of pages per clinic, regenerated rarely.

### 1.8 DEVIATION 6 — Restate the availability requirement honestly

**Specified:** 99.9% uptime.

**Instead:** **99.9% clinic-perceived availability**, delivered by the offline-first client, with a stated infrastructure recovery objective of 20 minutes and a data loss objective of 5 minutes.

**Why:** A single virtual machine cannot deliver 99.9% infrastructure uptime, and a clinical product should not make a claim that fails during a customer's busiest hour.

The honest version is also the better one. Because every operational surface reads and writes IndexedDB first, a server outage does not stop the clinic: reception continues checking patients in, the nurse continues logging vitals, the dentist continues charting, and the queue continues advancing. Changes sync when the server returns. What a customer actually cares about is whether their clinic can operate, and the answer is yes.

This is the commercial argument for offline-first, not just the technical one. It is what permits a credible product on ₹0 of infrastructure.

Backing this claim requires three things, all of which are non-optional:

1. **Infrastructure as code.** Terraform plus cloud-init for the entire host, so a rebuild is a 20-minute automated process rather than a day of remembering.
2. **Continuous archiving.** pgBackRest with WAL archiving to OCI Object Storage, giving a 5-minute recovery point.
3. **A weekly automated restore drill** that provisions a throwaway container, restores the most recent backup, runs a checksum and row-count verification, reports to the team channel, and destroys itself. On single-host infrastructure, an unverified backup is not a backup.

### 1.9 Hosting: Oracle Cloud Always Free, Mumbai

**Decision: production runs on Oracle Cloud Infrastructure Always Free in `ap-mumbai-1`. Microsoft for Startups Azure credits fund workloads that are expensive, time-boxed and disposable, and never the production path.**

#### Why not build on the Azure credits

The Microsoft for Startups self-serve offer is $1,000 valid for 90 days, followed by a further $4,000 for 180 days after business verification. That is roughly ₹4.4 lakh across about nine months, after which the subscription converts automatically to pay-as-you-go. Investor Network-backed startups begin at $100,000 with up to $150,000 available over two years.

Either way, credits are a subsidy with an expiry date. Putting the production database of a clinical system on an expiring subsidy guarantees a migration under deadline pressure at exactly the moment the business is trying to grow. And the commercial pitch in specification section 3.3 — that the platform recovers multiples of its own price out of clinic leakage — requires a defensible cost-per-clinic figure. "Currently free because Microsoft is paying" is not that figure.

If the Investor Network offer is available, take it. Spend it as described in 1.9.4. Do not move production onto it.

#### What OCI Always Free actually provides

Verified against Oracle's current documentation, September 2026:

| Resource | Always Free allowance |
| --- | --- |
| Ampere A1 compute (Arm) | 1,500 OCPU-hours + 9,000 GB-hours/month, i.e. **2 OCPU / 12 GB** sustained |
| AMD micro instances | 2 × VM.Standard.E2.1.Micro (1/8 OCPU, 1 GB) |
| Block storage | 200 GB total |
| Object storage | 10 GB |
| Outbound data transfer | **10 TB / month** |
| Load balancer | 1 flexible, 10 Mbps |

Two notes. Oracle **halved** the Ampere allowance in 2026, from 4 OCPU / 24 GB down to 2 / 12 — plan against the current figure, and be aware that some Oracle pages still show the old numbers. And the 10 TB egress allowance is worth emphasising, because outbound transfer is the cost line that most often surprises teams on AWS.

#### Three setup facts that will cost days if missed

1. **Upgrade to pay-as-you-go before provisioning anything.** Ampere A1 capacity is effectively unobtainable on a Free Tier account; "Out of host capacity" is the normal experience, and operators report retry scripts failing for months. On a pay-as-you-go account the Always Free allowance remains free, but you receive capacity priority and are exempt from idle-resource reclamation. The card on file is only charged for usage beyond the free allowance.
2. **The home region cannot be changed after signup on a free account.** Select `ap-mumbai-1`, which is confirmed to offer `VM.Standard.A1.Flex`. This 30-second choice determines whether the product is DPDP-compliant, and it is irreversible.
3. **Oracle does terminate free accounts.** A pay-as-you-go account with a valid card sharply reduces the risk. A tested restore into a second provider is the actual insurance — which is one more reason the weekly restore drill in 1.8 is not optional.

#### Production topology

A single Ampere A1 instance, 2 OCPU / 12 GB / 150 GB, running Docker Compose:

```
ap-mumbai-1
├── VM.Standard.A1.Flex  (2 OCPU / 12 GB / 150 GB)   [Always Free]
│   ├── caddy            TLS termination, Coraza WAF, static PWA, reverse proxy
│   ├── api              Fastify, Node 22 (arm64)
│   ├── postgres         PostgreSQL 16 + pg-boss queues
│   └── netdata          lightweight metrics
│
├── VM.Standard.E2.1.Micro (1 GB)                    [Always Free]
│   └── off-host uptime probe + weekly restore drill runner
│
├── Object Storage (10 GB)                           [Always Free]
│   └── pgBackRest WAL archive + base backups
│
└── Azure Blob, Central India                        [credits, then ~₹200/mo]
    └── geo-redundant encrypted nightly dumps
```

No Kubernetes. Kubernetes on a single host is pure overhead; OKE's free control plane does not change that, because the worker nodes are the cost and the complexity.

Observability stays deliberately light. SigNoz, and Prometheus with Grafana and Loki, all want more memory than this host can spare. Netdata is a single agent with a negligible footprint and adequate dashboards. Application errors go to a self-hosted Sentry only once there is a second host to put it on; until then, structured logs to disk with retention.

The micro instance earns its keep by living **outside** the main host: an uptime probe on the same machine it is monitoring is not a probe.

#### Where Azure credits go

The governing rule: **anything running on credits must be movable in an afternoon.** Docker Compose everywhere, no proprietary Azure PaaS in the critical path.

| Workload | Rationale |
| --- | --- |
| Geo-redundant encrypted backups (Blob, Central India) | High value, low cost, worth continuing to pay for after credits lapse |
| Staging and demo environments (an Azure VM running the production `compose.yml`) | Genuinely disposable. *Corrected after review: originally Container Apps. Staging on a different runtime to production cannot catch what staging exists to catch — Compose networking, volume permissions, memory limits and container start ordering are exactly where a single-host deployment breaks, and a managed container service papers over all four. Same Compose file, smaller VM.* |
| Load and soak testing before pilot go-live | Burst compute is precisely what credits are for |
| **GPU time to fine-tune IndicWhisper for Speech-to-Rx** | The highest-value use available: expensive compute we would never otherwise buy, and the output is model weights — a durable asset that outlives the credits |
| Azure OpenAI / Foundry for AI Enterprise tier research | Time-boxed R&D |
| ~~Production database~~ | Never |
| ~~Production application~~ | Never |
| ~~Production on any non-Indian edge, including Vercel~~ | Never. The interactive prototype is hosted on Vercel for pilot feedback, which is fine — fictional data, no backend. It must not become the production path: Vercel terminates TLS outside India, which contradicts the residency argument that Caddy-in-Mumbai, OCI `ap-mumbai-1` and DNS-only Cloudflare exist to support |

#### Cost trajectory

| Stage | Infrastructure | Monthly infrastructure | Per clinic |
| --- | --- | --- | --- |
| Pilot, 0–30 clinics | 1 × A1 (2/12), Always Free | **₹0** | ₹0 |
| Growth, 30–150 clinics | Scale to A1 (4/24) on PAYG | ~₹2,400 | ₹16–80 |
| Scale, 150–500 clinics | Separate DB and app hosts + LB | ~₹10,000 | ₹20–65 |
| 500+ clinics | Managed Postgres, read replica, multi-AD | ~₹45,000 | ₹90 |

Every band clears the specification's ₹250 per clinic target. Total marginal cost per clinic, including WhatsApp utility messaging at roughly ₹100 per clinic per month, stays between **₹100 and ₹250** — against the specification's own estimate of ₹350 to ₹550, which improves blended gross margin to roughly **88 to 92 percent**.

### 1.10 Consolidated stack

| Layer | Choice | Licence |
| --- | --- | --- |
| Client | Vite + React 18 + Tailwind, PWA | MIT |
| Local store | Dexie.js over IndexedDB | Apache 2.0 |
| Edge | Caddy + Coraza WAF | Apache 2.0 |
| API | Fastify, Node 22, TypeScript | MIT |
| Auth | Better Auth | MIT |
| Database | PostgreSQL 16 (+ `btree_gist`, RLS) | PostgreSQL Licence |
| Migrations | node-pg-migrate, plain SQL, explicit down for every up | MIT |
| Jobs | pg-boss | MIT |
| Realtime | Postgres `LISTEN/NOTIFY` → WebSocket | — |
| FHIR | HAPI FHIR (validation and serialisation) | Apache 2.0 |
| Indic voice | Bhashini API; AI4Bharat IndicWhisper / IndicTrans2 | Government / MIT |
| Metrics | Netdata | GPL-3.0 |
| Backups | pgBackRest | MIT |
| Provisioning | Terraform + cloud-init | BUSL / — |
| CI | GitHub Actions | — |

Every component is free and open source. There is no commercial licence anywhere in the production path.

**On the migration tool, added after review.** The v2.1 plan left this unnamed, which is a real gap rather than a detail. Most of this schema's correctness lives in things an ORM's migration generator does not model: row-level security policies, `EXCLUDE USING gist` constraints, generated columns, partial unique indexes and column-level `REVOKE` grants. Auto-generation round-trips those into something subtly different, or silently drops them. `node-pg-migrate` is chosen because migrations are plain SQL — a policy is written as the `CREATE POLICY` statement it actually is — with an explicit `down` for every `up`, so a failed deploy is reversible rather than archaeological. The migration runner connects as a DDL-capable role that the application role is not, and is one of the two audited exemptions from the `withTenant` lint rule in 2.1.1.

---

## 2. Data architecture

### 2.1 Tenancy and the enforcement boundary

Every tenant-scoped table carries `clinic_id`, and isolation is enforced by **PostgreSQL Row-Level Security**, not by application code.

This is the single highest-leverage compliance decision available, and the specification omits it entirely. Application-enforced tenancy fails the first time someone writes a query that forgets a `WHERE` clause. Database-enforced tenancy cannot be forgotten.

```sql
ALTER TABLE patients ENABLE ROW LEVEL SECURITY;

CREATE POLICY clinic_isolation ON patients
  USING (clinic_id = current_setting('app.clinic_id')::uuid);

-- BR-05: reception may read patients but never bulk-export contact details.
CREATE POLICY reception_no_contact_export ON patients
  FOR SELECT
  TO app_reception
  USING (clinic_id = current_setting('app.clinic_id')::uuid);

REVOKE SELECT (phone_e164) ON patients FROM app_reception;
GRANT  SELECT (phone_masked) ON patients TO app_reception;
```

Storing `phone_masked` as a generated column and revoking column-level access to the real number means FR-2.3 holds even against a SQL-injection vector, because the reception database role genuinely cannot read the column.

Policies use `FORCE ROW LEVEL SECURITY`, and the application connects as a role that does not own the tables. Without `FORCE`, the owning role bypasses every policy above.

#### 2.1.1 Setting `app.clinic_id` — the defect that would undo all of this

*Added after review. This is the highest-severity gap found in the v2.1 plan, and M0 does not exit without the three controls below.*

Everything in 2.1 depends on `app.clinic_id` being correct. The obvious way to set it is wrong.

We use a connection pool. `SET app.clinic_id = ...` is **session-scoped** and survives the connection's return to the pool. The next request to borrow that connection inherits the previous tenant's value. If that request then fails to set its own — an early return, an error path, a code path added six months later — it reads another clinic's rows, and the RLS policy happily permits it because the policy is doing exactly what it was told.

What makes this worth a subsection rather than a code comment: it **passes every single-request test**, it **raises no error**, and it becomes **more likely as concurrency rises**, so its first appearance is in production during a busy clinic hour. It is also, in DPDP terms, a reportable breach.

**Control 1 — a single accessor built on `SET LOCAL`.** `SET LOCAL` is transaction-scoped and is discarded on commit or rollback, so a released connection cannot carry it.

```ts
// src/db/tenant.ts — the only sanctioned route to tenant-scoped data.
export async function withTenant<T>(
  clinicId: string,
  fn: (tx: PoolClient) => Promise<T>,
): Promise<T> {
  const tx = await pool.connect();
  try {
    await tx.query("BEGIN");
    // set_config(..., true) is SET LOCAL. Parameterised: interpolating a tenant
    // id into this string would hand an attacker the isolation boundary itself.
    await tx.query("SELECT set_config('app.clinic_id', $1, true)", [clinicId]);
    const result = await fn(tx);
    await tx.query("COMMIT");
    return result;
  } catch (err) {
    await tx.query("ROLLBACK");
    throw err;
  } finally {
    tx.release();
  }
}
```

**Control 2 — make the bypass fail the build.** An ESLint `no-restricted-properties` rule forbids `pool.query` and `pool.connect` outside `src/db/tenant.ts`. Two audited exemptions exist, both genuinely outside any tenant context: the migration runner, and pg-boss's own queue tables. A rule that developers must remember is not a control.

**Control 3 — a CI gate that reproduces the breach conditions.** Pool `max: 1`, forcing every request onto one physical connection, two tenants interleaved, asserting that neither observes the other. It additionally asserts that a query issued with **no** tenant context returns zero rows rather than the previous tenant's — which `SET LOCAL` gives us for free, since an unset `app.clinic_id` matches nothing.

The worker is where this will be reintroduced if anywhere: pg-boss jobs have no request context, so every tenant-scoped job carries `clinic_id` in its payload and runs inside `withTenant`. A job that infers its tenant from anything else is a defect.

### 2.2 Core schema

```sql
CREATE TABLE clinics (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug            text UNIQUE NOT NULL,          -- drsharma → drsharma.practix.in
  legal_name      text NOT NULL,
  vertical        text NOT NULL CHECK (vertical IN ('dental','mental_health','polyclinic')),
  followup_days   int  NOT NULL DEFAULT 7 CHECK (followup_days BETWEEN 3 AND 15),  -- BR-01
  timezone        text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at      timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE chairs (                            -- operatories; BR-02
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id   uuid NOT NULL REFERENCES clinics(id),
  label       text NOT NULL,
  capability  text[] NOT NULL DEFAULT '{}'       -- {'rct','implant','xray'}
);

CREATE TABLE patients (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id      uuid NOT NULL REFERENCES clinics(id),
  full_name      text NOT NULL,
  phone_e164     text NOT NULL,
  phone_masked   text GENERATED ALWAYS AS
                   (left(phone_e164, 9) || '•••' || right(phone_e164, 2)) STORED,
  preferred_lang text NOT NULL DEFAULT 'en'
                   CHECK (preferred_lang IN ('en','mr','te','bn','kok')),
  abha_id        text,
  alerts         text[] NOT NULL DEFAULT '{}',   -- FR-3.2 allergy and risk tags
  UNIQUE (clinic_id, phone_e164)
);

CREATE TABLE appointments (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  clinic_id     uuid NOT NULL REFERENCES clinics(id),
  patient_id    uuid NOT NULL REFERENCES patients(id),
  practitioner_id uuid NOT NULL REFERENCES practitioners(id),
  chair_id      uuid REFERENCES chairs(id),      -- null for teletherapy
  during        tstzrange NOT NULL,
  mode          text NOT NULL CHECK (mode IN ('clinic','video')),
  state         text NOT NULL DEFAULT 'expected'
                  CHECK (state IN ('expected','waiting','in_consult','billing','done','no_show','cancelled')),
  fee_paise     bigint NOT NULL,
  fee_reason    text NOT NULL,                   -- BR-01 audit of why this fee
  prepaid       boolean NOT NULL DEFAULT false   -- BR-04
);
```

### 2.3 BR-02 enforced by the database

Chair double-booking must be impossible, including under two receptionists booking simultaneously. Application-level checking cannot guarantee this — between the `SELECT` that finds the chair free and the `INSERT` that books it, another transaction can do the same. The database solves it with an exclusion constraint:

```sql
CREATE EXTENSION IF NOT EXISTS btree_gist;

ALTER TABLE appointments
  ADD CONSTRAINT chair_not_double_booked
  EXCLUDE USING gist (
    chair_id WITH =,
    during   WITH &&
  ) WHERE (chair_id IS NOT NULL AND state NOT IN ('cancelled','no_show'));

ALTER TABLE appointments
  ADD CONSTRAINT practitioner_not_double_booked
  EXCLUDE USING gist (
    practitioner_id WITH =,
    during          WITH &&
  ) WHERE (state NOT IN ('cancelled','no_show'));
```

Two constraints, and the three-way dependency in BR-02 is guaranteed rather than hoped for. Externally synced personal calendar blocks (FR-6.3) are inserted as appointments in a reserved `state`, so they participate in the same constraint automatically.

### 2.4 BR-05 append-only audit

An audit trail the application can rewrite is not an audit trail.

```sql
CREATE TABLE audit_log (
  id         bigserial PRIMARY KEY,
  clinic_id  uuid NOT NULL,
  actor_id   uuid,
  actor_role text NOT NULL,
  action     text NOT NULL,        -- 'patient.view', 'phone.unmask', 'vault.open'
  subject    text NOT NULL,
  detail     jsonb NOT NULL DEFAULT '{}',
  at         timestamptz NOT NULL DEFAULT now()
);

REVOKE UPDATE, DELETE ON audit_log FROM app_rw;
GRANT  INSERT, SELECT ON audit_log TO app_rw;
```

Revoking `UPDATE` and `DELETE` from the application role means that even a fully compromised application cannot rewrite history. Retention and archival run under a separate role available only to a scheduled job.

Every phone unmask (FR-2.3), every vault open (FR-5.1) and every record export writes here.

---

## 3. Security

### 3.1 Transport and storage

TLS 1.3 terminated by Caddy in Mumbai. Encrypted block volumes for data at rest. Backups encrypted with age before leaving the host, so the object storage provider never holds plaintext. Argon2id for staff password hashing — not the specification's SHA-256, which is a hash function rather than a password hashing function and is unsuitable for the purpose.

### 3.2 The vault: a real problem with FR-5.1

**The specification's design is not secure, and this needs to be fixed before launch rather than after.**

FR-5.1 protects psychotherapy notes behind a 4-digit PIN, with keys derived client-side via PBKDF2. The intent is right; the arithmetic is not. A 4-digit PIN has **10,000 possible values**. Against an attacker holding the database, no key derivation function saves you — a deliberately expensive KDF turns an instant break into a few hours of GPU time. The zero-knowledge property the specification promises does not exist.

Two changes make the promise real.

**Split the key.** Derive the encryption key from the PIN *and* a server-held secret that is released only to an authenticated, rate-limited session:

```
wrapping_key = Argon2id(
    password = user_pin || server_secret,
    salt     = per_note_salt,
    m = 64 MiB, t = 3, p = 1
)
```

`server_secret` is stored in a separate keystore, never in the application database, and is released only after the therapist authenticates, with a hard rate limit and lockout. A stolen database dump now contains no brute-forceable material, because the attacker holds only half the input. The therapist's experience is unchanged: they still type four digits.

**Use Argon2id, not PBKDF2.** OWASP has recommended Argon2id since 2021; PBKDF2 remains preferred only where FIPS certification is mandated, which does not apply here.

Additional controls: automatic re-lock after 10 minutes idle, keys held only in JavaScript closure memory and never in `localStorage`, and every unlock written to the audit log.

> **Prototype note.** The interactive prototype performs genuine encryption using the Web Crypto API, which offers PBKDF2 but not Argon2id. The prototype therefore uses PBKDF2 with a high iteration count and states this limitation on screen. The production implementation uses Argon2id with the split key described above.

---

## 4. External integrations

### 4.1 WhatsApp — the critical path item nobody schedules

Meta requires every utility template to be submitted and approved before it can be sent, per language. PractixOS launches with five languages and roughly a dozen template types, which is around sixty template approvals. Approvals take days and rejections are common and often opaque.

**Submit templates in M0.** They are not a launch task; they are a lead-time item that will otherwise block a launch date that has already been promised to a pilot clinic.

Cost control follows from the specification's own observation in 3.2: the 24-hour customer service window is free. Any template that invites a reply opens that window, and every subsequent interaction within it costs nothing. Design conversational flows to run inside that window rather than sending fresh templates.

### 4.2 ABDM

M1 (ABHA creation and verification), M2 (FHIR bundle push) and M3 (consent management), against the National Health Authority sandbox before production certification. Use HAPI FHIR for bundle construction and validation rather than assembling JSON by hand — FHIR profile conformance is where these integrations fail, and the validator catches it before the gateway does.

DHIS accounting is a ledger, not a counter: every qualifying transaction is recorded with its bundle reference so that a clinic's incentive claim can be reconciled line by line. Clinic owners will audit this figure, because it is the number that justifies their subscription.

**Begin sandbox certification in M0.** Lead time is measured in weeks and is outside our control.

### 4.3 Payments and calendar

UPI via a PSP supporting dynamic QR with settlement webhooks. Every payment is reconciled against a webhook rather than a client-side success callback, since the client can lie or simply disconnect.

**Webhooks must be idempotent, and the enforcement belongs in the database.** Every gateway retries on a non-2xx response and on timeout, so each settlement will arrive more than once. Duplicate application double-credits a deposit and corrupts both the daily reconciliation (FR-7.1) and the Recovered Revenue ledger (FR-7.4).

```sql
CREATE TABLE payment_events (
  provider       text   NOT NULL,
  provider_event_id text NOT NULL,
  clinic_id      uuid   NOT NULL REFERENCES clinics(id),
  payload        jsonb  NOT NULL,
  received_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, provider_event_id)
);
```

The handler inserts the event and applies its financial effect **in one transaction**, and treats a primary-key violation as a successful no-op returning 200. An application-level "have I already seen this?" lookup is not equivalent: two concurrent retries both read "no" before either writes.

Signature verification happens before anything else, and the raw body is verified rather than the re-serialised JSON, because re-serialisation changes bytes and invalidates the HMAC.

**Rate limiting the public surface.** Every tenant portal exposes unauthenticated OTP and booking endpoints. Each OTP send costs real money, and sustained abuse degrades the WhatsApp quality rating that all 1,000 tenants share (R11). Limits are applied in two independent places, because the edge can be bypassed if the origin is ever reachable directly: Caddy enforces per-IP and per-path ceilings, and the application enforces per-phone and per-tenant ceilings with exponential backoff per destination number. Each tenant carries a monthly messaging spend cap that degrades to SMS rather than failing open, so a booking cannot be silently lost to a budget control.

Google Calendar API v3 and Microsoft Graph, bidirectional, PractixOS as master. External events are written as blocking appointments with titles masked to "Doctor Unavailable (External Sync)" per FR-6.3 — masked at write time, so the private title never enters our database at all. That is a stronger guarantee than masking at read time, and it means a database compromise cannot reveal a doctor's personal calendar.

---

## 5. Delivery plan

Milestones are ordered by revenue impact rather than by specification order. Pre-payment and the follow-up engine ship before the odontogram, because deposits stop cash leaking from day one while the odontogram, valuable as it is, does not move money.

> **How these milestones are actually executed** is set out in [BUILD-PROTOCOL.md](BUILD-PROTOCOL.md): the spec-driven and test-driven loops, the machine-readable milestone scope map that [../../scripts/trace.py](../../scripts/trace.py) gates against, and each exit criterion below transcribed into a named acceptance test. [../../AGENTS.md](../../AGENTS.md) is the short form and is loaded automatically into every agent session. Both exist because the six DEVIATIONs above, and the guarantees in section 2, are worth nothing if the next person to touch the codebase does not know they are decisions rather than accidents.

### M0 — Foundations (weeks 1–3)

Terraform and cloud-init for the OCI host; Docker Compose topology; Postgres with `FORCE` RLS, `btree_gist` and the audit trigger; **the `withTenant` accessor and its lint rule (2.1.1)**; the migration runner; CI with arm64 builds; Caddy with Coraza and the public-surface rate limits; pgBackRest and the weekly restore drill.

**The four verification gates land here, before any business logic exists**, because each is cheaper to write against an empty schema than to retrofit against a full one, and because their purpose is to fail on the commit that breaks them rather than at a milestone review weeks later:

| Gate | Asserts |
| --- | --- |
| Tenant isolation | Two tenants interleaved over a pool of size 1 never see each other's rows; an unset context reads zero rows (2.1.1) |
| BR-02 concurrency | N simultaneous bookings on one chair and overlapping range produce exactly one appointment (2.3) |
| Vault non-recoverability | Plaintext is unrecoverable from a full dump plus all server-held secrets, without the patient PIN (3.2) |
| Layout integrity | `prototype/check-layout.py` — every view, every tenant, seven widths, no overflow and no collapse |

The isolation gate runs against a real Postgres container with the real policies applied. An isolation test that never executes `CREATE POLICY` is testing itself.

Started in parallel because of lead time: **ABDM sandbox registration** and **WhatsApp template submission**.

*Exit:* a rebuild from `terraform apply` to serving traffic completes in under 20 minutes; the restore drill passes unattended; and all four gates run green in CI.

### M1 — Booking and money (weeks 4–8)

Self-service onboarding wizard and CSV import (FR-1.6, FR-1.7); public portal with five-language switching (FR-1.1, FR-1.2); WhatsApp OTP authentication (FR-1.4); slot search honouring the chair and practitioner exclusion constraints (FR-1.5, BR-02); the follow-up rule engine (BR-01); UPI deposits with idempotent webhook reconciliation (4.3); pre-payment and the 24-hour cancellation policy (BR-04); **Recovered Revenue capture for `no_show_prevented` and `deposit_converted`, with delivery-receipt storage and the anti-double-counting constraint (FR-7.4)**.

The ledger capture ships alongside the mechanisms it measures rather than with the dashboard in M5. Retrofitting it later would mean a dashboard whose first months are empty, which is the same as not having it — and delivery receipts not stored at the time cannot be reconstructed.

*Exit:* a patient books, pays and receives a WhatsApp confirmation in Marathi; concurrent booking attempts on one chair produce exactly one appointment; an owner takes a clinic from signup to a live test booking in under 15 minutes without assistance; a deposit-secured attended appointment writes exactly one ledger row.

### M2 — The clinic floor (weeks 9–13)

Reception Kanban with realtime updates (FR-2.1, FR-2.4); two-input walk-in registration (FR-2.2); phone masking with audited unmask (FR-2.3); nurse vitals and alert tagging (FR-3.1, FR-3.2); **the offline layer** — Dexie mirror, service worker, sync queue and conflict resolution.

*Exit:* a receptionist registers a walk-in in under 10 seconds; pulling the network cable leaves check-in, vitals and queue movement fully functional, and everything reconciles on reconnect.

### M3 — Dental vertical (weeks 14–18)

FDI odontogram (FR-4.1, FR-4.2); treatment plan generation from charted conditions (FR-4.3); lab work-order tracker with WhatsApp dispatch, undispatchable while tooth number, restoration type or shade is missing (FR-4.4, FR-4.5); print artifacts for prescription and receipt (FR-4.6); visiting consultant hub with calendar sync, fee-split ledger and owner-side settlement approval (FR-6.1 to FR-6.5, BR-03).

*Exit:* charting tooth 16 produces a three-sitting plan, dispatches a lab order, credits the consultant ledger correctly, and the owner can approve or dispute the resulting settlement.

### M4 — The configurable vertical engine (weeks 19–22)

*Replaces the mental health vertical, which moves to M6. See specification 2.4: mental health is 1.6% of the addressable market and was consuming a milestone and the hardest security subsystem in the build.*

Per-tenant queue stages replacing the hardcoded lanes (4.6.1); the recall engine on pg-boss (4.6.2); package and series billing (4.6.3); batch and expiry inventory (4.6.4); dependant and guardian accounts with consent by proxy (4.6.5).

These four weeks are the difference between a second vertical costing a milestone and a second vertical costing an afternoon. The governing constraint is that **no code may branch on `clinics.vertical`** — the column seeds configuration at onboarding and is otherwise inert.

*Exit:* an ophthalmology tenant is stood up **entirely through configuration, with no code change** — a *Waiting for Dilation* stage with a dwell alert, an annual refraction recall, an optical work-order type — and passes the same test suite as the dental tenant.

### M5 — Administration, recovered revenue and ABDM (weeks 23–27)

Daily cash and UPI reconciliation (FR-7.1); the Recovered Revenue owner dashboard and break-even display (FR-7.4.6, capture having landed in M1–M2); ABDM M1/M2/M3 in production against the **v3 APIs** with the Category-aware DHIS ledger (FR-7.2); chair-time profitability (FR-7.3); Phase 1 roadmap features — vernacular care drip, and the Dynamic Token Radar with its rolling-median per-practitioner estimator.

v3 API conformance is not optional: from July 2026 a non-conformant facility or Digital Solution Company earns no incentive at all.

*Exit:* ABDM production certification granted against v3; a clinic's DHIS accrual reconciles line by line against NHA records; every rupee in the Recovered Revenue total resolves to a delivery receipt, payment reference or invoice line, and no appointment is credited twice.

### M6 — Mental health vertical (weeks 28–31)

Split-key Argon2id vault (FR-5.1, FR-5.2); SOAP editor with DSM-5 coding; GAD-7 and PHQ-9 tracking (FR-5.3); recurring weekly series linked to pre-payment (FR-5.4), built on the M4 package engine rather than as bespoke recurrence.

*Exit:* an independent reviewer with full database access cannot recover note plaintext.

### Phase 2 and beyond

Ophthalmology, dermatology and paediatrics follow as configuration exercises on the M4 engine, in that order and for the reasons set out in specification 2.4. Vernacular audio consent and visual treatment explainers follow M6. Speech-to-Rx and NHCX cashless claims are Phase 3, gated on the IndicWhisper fine-tuning funded by Azure GPU credits.

---

## 6. Compliance workstream

Runs in parallel throughout, not as a phase.

| Item | Requirement | Where it is satisfied |
| --- | --- | --- |
| Data residency | All data in India | OCI `ap-mumbai-1`; Caddy terminates TLS in-region; Cloudflare DNS-only |
| Tenant isolation | Clinic data cannot cross tenants | Postgres RLS (2.1) |
| Contact protection | Reception cannot export patient lists | Column-level `REVOKE` (2.1) |
| Audit trail | Append-only, covers access and export | `audit_log` with `REVOKE UPDATE, DELETE` (2.4) |
| Clinical confidentiality | Admin staff cannot read therapy notes | Split-key client-side encryption (3.2) |
| Consent | Purpose limitation, withdrawal | Consent ledger per patient, M1 |
| Breach notification | Reportable within statutory window | Runbook, M5 |
| ABDM | M1/M2/M3 certification | Sandbox from M0, production in M5 |

---

## 7. Risk register

| # | Risk | Impact | Mitigation |
| --- | --- | --- | --- |
| R1 | OCI Ampere capacity unavailable in Mumbai | Blocks provisioning | Pay-as-you-go account from day one; Terraform retry; fallback to paid A1 at ~$55/month, which remains within budget |
| R2 | Oracle terminates the account | Total loss of production | PAYG with card on file; weekly verified restores; a documented and rehearsed migration to a second Indian provider |
| R3 | Single host fails | Outage until rebuild | Offline-first client keeps clinics operating (1.8); 20-minute automated rebuild; 5-minute RPO |
| R4 | ABDM certification slips | Blocks interoperability and any DHIS accrual; v3 conformance is a hard gate from July 2026 | Start in M0; the product remains fully saleable without it, because the ROI argument is leakage recovery rather than subsidy |
| R5 | WhatsApp templates rejected | Blocks launch messaging | Submit in M0; keep a plain-SMS fallback path |
| R6 | **DHIS scheme revised or withdrawn** — *materialised, April 2026* | The commercial pitch was overstated by roughly 5× | **Already occurred.** NHA Corrigendum 7 cut the outpatient Category 2 facility rate from ₹20 to ₹5, excluded Scan & Share and Health Locker, and restricted eligibility to KYC-verified ABHA records. Specification 3.3 and 3.4 rewritten in v2.2; the ROI argument is now the Recovered Revenue ledger, which no policy change can withdraw |
| R7 | Konkani translation quality | Poor experience in a launch language | Budget for a native reviewer; treat Konkani as beta until reviewed |
| R8 | Azure credits expire with production dependencies attached | Forced migration under pressure | The movable-in-an-afternoon rule (1.9.4); production never runs on credits |
| R9 | Offline sync conflicts corrupt clinical data | Patient safety issue | Per-field last-write-wins with vector clocks for operational data; clinical notes never auto-merge, and conflicts surface for explicit clinician resolution |
| R10 | 2 OCPU insufficient sooner than projected | Degraded performance | Netdata alerting at 70% sustained CPU; vertical scale to 4/24 is a reboot, not a migration |
| R11 | **One shared WhatsApp Business Account across all tenants** | One clinic's poor templates degrade the quality rating every other clinic messages through; at the limit Meta throttles or bans the number and all tenants lose their primary patient channel at once | Platform-owned parameterised templates, never tenant-authored free text; per-tenant quality and block-rate monitoring with automatic suspension of an offending tenant's marketing sends; marketing separated from utility traffic so a marketing problem cannot stop appointment confirmations; a documented path to per-tenant WABAs for high-volume clinics |
| R12 | **Tenant context leaks across pooled connections** | Silent total cross-tenant exposure: wrong rows, no error, reportable under DPDP. Passes every single-request test and worsens under load | `SET LOCAL` inside an explicit transaction via the single `withTenant` accessor; an ESLint rule making the bypass fail the build; a CI gate over a pool of size 1 asserting an unset context reads zero rows (2.1.1) |
| R13 | **Unauthenticated OTP and booking endpoints abused** | Direct messaging cost, plus damage to the shared quality rating R11 depends on; one public portal per tenant multiplies the surface by the tenant count | Per-IP and per-path limits at Caddy, per-phone and per-tenant limits in the application, exponential backoff per destination number, a monthly spend cap per tenant that degrades to SMS rather than failing open, and alerting on send-rate anomalies (4.3) |

---

## 8. Open questions

1. **Payment service provider.** Requires a decision on settlement timing and per-transaction pricing; affects BR-04 refund handling.
2. **Konkani reviewer.** No established vendor pool. Likely requires a direct hire in Goa.
3. **Investor Network eligibility.** Determines whether $100,000 in Azure credits is available, which changes how much Speech-to-Rx research can be funded in Phase 1.
4. **Pilot clinics.** Two dental and one mental health practice needed by M2 to validate the offline layer under real conditions.
