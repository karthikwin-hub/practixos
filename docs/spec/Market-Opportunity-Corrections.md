# Corrections and Commentary — `PractixOS_Market_Opportunity.pdf`

**Version 1.0 · 23 September 2026 · Companion to specification v2.2**

The market opportunity document cannot itself be edited, so this note records where its figures no longer hold, and where its recommendations conflict with requirements the specification commits to. Sizing, segmentation and vertical analysis in that document are sound and were adopted into specification §2.4. The corrections below are confined to two areas: the DHIS arithmetic, and the institutional sales section.

---

## 1. The Revenue Arbitrage pitch is out of date and must be withdrawn

The document's Section 3 leads with the DHIS "Revenue Arbitrage Pitch", stating that a clinic seeing 25 patients a day earns **₹12,000+ per month**, "instantly offsetting the ₹1,999/month SaaS cost". This rests on a rate of ₹20 per transaction with no eligibility floor.

Both inputs changed in April 2026.

**Governing source.** [NHA Corrigendum 7 to the Digital Health Incentive Scheme](https://abdm.gov.in/strapicms/uploads/Corrigendum_7_f456cb207a.pdf), reference `S-12021/070/2022-ABDM(Coord)`, published 09 April 2026, effective April 2026 to September 2026.

### Current rates

| Recipient | Category 1 — Diagnostic Report, Discharge Summary | Category 2 — Prescription, OP Consultation, Immunization Record, Wellness Record, Invoice |
| --- | --- | --- |
| Health facility | ₹10 per eligible transaction | **₹5 per eligible transaction** |
| Digital Solution Company | ₹5 per eligible transaction | ₹2.50 per eligible transaction |

An outpatient dental, counselling or general practice produces OP Consultations and Prescriptions. That is **Category 2, at ₹5** — not ₹20.

### Four conditions that further reduce the realisable figure

1. **The first 100 transactions each month earn nothing.** The eligibility threshold of 100 transactions is retained, and those transactions are deducted before the incentive is computed.
2. **Only KYC-verified ABHA-linked records qualify.** Scan & Share and Health Locker transactions were removed from the scheme entirely. In walk-in outpatient practice the KYC-verified fraction is well below 100%, and this is the single largest discount on any projection.
3. **A 1-per-day and 5-per-month per-ABHA cap** applies to Category 2 transactions.
4. **v3 API conformance is mandatory from July 2026.** A non-conformant facility or Digital Solution Company earns nothing at all, which makes ABDM integration a gate on the incentive rather than an enhancement to it.

### Corrected arithmetic

Taking the document's own example — 25 patients a day, 25 working days, so 625 eligible records a month:

| KYC-verified rate | Eligible | Less 100 floor | × ₹5 | Document's claim |
| --- | --- | --- | --- | --- |
| 90% (optimistic) | 562 | 462 | **₹2,310** | ₹12,000+ |
| 60% (realistic for walk-in practice) | 375 | 275 | **₹1,375** | ₹12,000+ |

The claim is overstated by roughly **five to nine times**, and at neither rate does the incentive offset the ₹1,999 Clinic Pro subscription. The equivalent example in specification v2.1 (450 bundles, ₹9,000) was overstated on the same basis and has been corrected to ~₹1,525 in §3.4.

### Scheme durability

DHIS has been amended seven times since its launch on 1 January 2023, and the rate trajectory across those amendments is downward. Corrigendum 7's stated validity ends in **September 2026**. No commercial model may assume the scheme's continuation, its current rates or its current eligibility rules.

### What replaced it

Specification §3.3 now leads with the **Leakage Recovery Model**, and FR-7.4 makes the platform record what it recovered rather than assert what it might earn. This is a stronger pitch on three independent grounds: it is larger, it does not depend on policy, and it is evidenced from the clinic's own data. It is also a churn defence in a way a subsidy can never be, because a subsidy continues after the clinic cancels and recovered revenue does not.

Risk R6 in the specification already warned against making DHIS the sole ROI argument. R6 had in fact materialised five months before it was written. It is now recorded as such.

---

## 2. Sizing is counted in practitioners but the product is priced per facility

The document sizes the serviceable market at roughly **342,000 practitioners** in solo and small-polyclinic settings, against a total of 428,668. That segmentation is correct and useful, and specification §2.4 adopts it directly for vertical sequencing.

It does not convert to revenue, because PractixOS prices **per facility with unlimited seats** — deliberately, as the answer to per-seat pricing driving account sharing. Converting the same population to billable units:

| Setting | Practitioners | Practitioners per facility | Facilities |
| --- | --- | --- | --- |
| Solo practice | ~235,785 | 1 | ~235,785 |
| Small polyclinic | ~107,175 | 2–5, midpoint 3.5 | ~30,600 |
| **Billable total** | | | **~266,000** |

At list prices, full capture of the named geography is therefore on the order of **₹356 crore per year** (~$43M): ₹283 crore from solo practices at ₹999 and ₹73 crore from polyclinics at ₹1,999. One percent penetration is ₹3.6 crore of annual recurring revenue; ten percent is ₹36 crore.

Two consequences worth stating plainly, neither of which is a criticism of the analysis:

* **Subscription alone, in these eleven cities, is a mid-scale outcome.** A larger outcome requires wider geography, a move up-market, or a second revenue line.
* **The natural second line is treatment-plan financing**, not payments. UPI person-to-merchant is largely zero-MDR in India, so a payments take-rate is not available. But the odontogram already produces a phased treatment plan with staged costs, which is precisely the artifact a lender needs to underwrite a ₹60,000 full-mouth rehabilitation or a six-session laser course. It converts the patient's affordability objection into a closed case, which is a benefit to the clinic as well as a margin to the platform.

**Distribution.** At a ₹999–3,499 price point, direct field sales is difficult to fund. The document does not name a channel. The **dental laboratory** is the strongest candidate and is already half-built: structured work orders reduce remakes, which is real value to the laboratory, and a single commercial laboratory serves 100–300 dentists. This is recorded in specification §2.4 and should be tested before any sales hire.

---

## 3. Vertical capability gaps, now closed in the specification

The document introduces four verticals the specification did not previously address. Each names a capability the product lacked. All five gaps below are now specified in **§4.6, The Configurable Vertical Engine**, and are built in milestone M4 as per-tenant configuration rather than per-vertical code.

| Document's requirement | Vertical | Was | Now |
| --- | --- | --- | --- |
| Multi-stage waiting ("Waiting for Dilation") | Ophthalmology | Four hardcoded Kanban lanes | `queue_stages`, per tenant, with dwell alerts (§4.6.1) |
| Recurring session packages | Dermatology | Absent | `package_definitions` / `patient_packages` (§4.6.3) |
| Consumable batch and expiry tracking | Dermatology | Count and buffer only | `inventory_batches` with expiry (§4.6.4) |
| Immunisation recall, 60–80 patients per evening | Paediatrics | Absent | Recall engine (§4.6.2); compact list mode (FR-2.1) |
| A parent booking for a child | Paediatrics | **Absent — a hard blocker** | `patient_relationships` with consent by proxy (§4.6.5) |

The recall engine deserves particular note: it is named by the document for at least four verticals, was previously reduced to a single WhatsApp marketing template, and is architecturally inexpensive. It is also the mechanism behind the `plan_resumed` event in FR-7.4, so it now carries commercial weight as well as clinical.

**Sequencing.** The document's specialty table led directly to the change in §2.4: mental health counselling is 6,970 practitioners, 1.6% of the market, yet was a Phase 1 launch vertical consuming a milestone and the hardest security subsystem in the build. Dentistry now launches alone, followed by Ophthalmology, Dermatology and Paediatrics.

---

## 4. The institutional and government section conflicts with FR-1.1.2, and is out of scope for v1

Section 4 of the document proposes municipal and state health deployments — Mohalla Clinics, BMC dispensaries, Primary Health Centres — on NIC cloud or dedicated instances, with epidemiological dashboarding across wards, entered through CSR-funded pilots that bypass L1 tendering.

The commercial logic is sound and the entry strategy is genuinely clever. Two things make it wrong for version 1, and both are structural rather than a matter of effort.

**It contradicts a requirement the product is being sold on.** FR-1.1.2 states that a query for another tenant's record returns zero rows, and that there is no cross-tenant view "at any tier of the product". Epidemiological dashboarding across wards is, by definition, cross-tenant aggregation. Population health analytics is achievable — as a separate aggregation pipeline with differential privacy, reading from an export rather than from the operational database — but it must never be delivered by relaxing row-level security. The moment there exists a role that can read across tenants, the guarantee made to every private clinic is false.

**It is a second deployment topology, not a pricing tier.** The document itself notes that a government instance "cannot be multi-tenant with private clinics". That means a second runtime, a second operations model, a second release process and a second compliance surface, arriving at the same time as a sales motion with an entirely different cycle length and procurement process.

**Recommendation.** Institutional sales is explicitly out of scope for v1 and should be revisited after the private pilot. The §4.6 configurable engine is the precondition: once queue stages, recalls and billing are per-tenant configuration, a Mohalla Clinic is a configuration exercise on a separately deployed instance rather than a fork of the product. Note also that the Dynamic Token Radar, which is the strongest element of the government pitch, is Phase 1 regardless and will be demonstrable well before any institutional conversation begins.

---

## Summary of actions taken

| Finding | Where addressed |
| --- | --- |
| DHIS rate, floor, KYC gating, v3 gate, expiry | Specification §3.4, risk R6, prototype owner ledger |
| ROI argument replaced | Specification §3.3 and FR-7.4; prototype Recovered Revenue panel |
| Practitioner-to-facility conversion | This note, §2 |
| Distribution channel named | Specification §2.4, distribution note |
| Vertical sequencing | Specification §2.4 |
| Five vertical capability gaps | Specification §4.6, milestone M4 |
| Institutional sales scope | This note, §4 — deferred past v1 |
