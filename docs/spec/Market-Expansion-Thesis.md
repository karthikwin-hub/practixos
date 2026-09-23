# PractixOS — Market Expansion Thesis

**Status:** analysis, September 2026. Companion to `Market-Opportunity-Corrections.md`.
**Question it answers:** the corrections memo sized full capture at **₹356 crore per year** and noted that one percent penetration is ₹3.6 crore. Read cold, that reads like a market with no room in it. This document explains why that figure is arithmetically correct and strategically misleading, and sets out what the ceiling actually is.

**Scope.** Sections 1–4 and 7–9 are the live argument and are reflected on the investor one-pager. Sections 5 and 6 — adjacent revenue lines and international expansion — are **analysis only, on no roadmap, and deliberately absent from the pitch.** They are retained so the reasoning is on file if that changes.

**Convention.** Figures marked **[D]** are derived from the specification or the corrections memo and should be treated as settled. Figures marked **[E]** are estimates made in this document, with the reasoning shown so they can be argued with. Do not quote an **[E]** figure to an investor without the reasoning attached.

---

## 1. ₹356 crore measures the price, not the market

The arithmetic is sound: ~266,000 billable facilities × a blended **₹1,115** per month × 12 ≈ ₹356 crore. **[D]**

But every term in it except the facility count is a decision the company made, and the blend is dominated by the ₹999 solo tier. So the number describes the revenue available *at a price chosen to remove adoption friction from a market that has never paid for software*. It is a floor, not a size.

Consider what it implies about the customer. A solo practice collecting ₹1–1.5 lakh a month **[E]** pays ₹999 for the system that runs its front desk, clinical record, billing, statutory compliance and owner reporting. That is **under 1% of collections**. Dental practices in the United States and Western Europe spend 2–4% of collections on practice-management and adjacent software. **[E, benchmark]**

PractixOS is priced at roughly a third of what the category sustains elsewhere. That was the right call for launch. Sizing the market at that price, in perpetuity, is not.

---

## 2. The pricing-power argument, and why FR-7.4 is the instrument

The usual reason a vendor cannot raise price is that it cannot prove value. §3.3 exists precisely to remove that excuse.

The worked example in §3.3 shows **₹16,600 per month recovered** against a ₹1,999 subscription. **[D]** The platform is therefore capturing about **12%** of the value it demonstrably creates, and the ledger (FR-7.4) is an append-only, evidence-linked, anti-double-counted record of it. That is an unusually strong position: the renewal conversation is not a feature comparison, it is a reading of the clinic's own audited numbers.

Capturing 20–25% of proven recovery rather than 12% implies **₹3,000–4,000 per month** for a practice of that size. Blended across the solo tier — which recovers less in absolute terms because it books fewer appointments — a realistic mature blend is **₹2,500 per month**. **[E]**

| Blended ARPU | Basis | Full-capture subscription pool |
| --- | --- | --- |
| ₹1,115 / month | Today's list, solo-weighted **[D]** | **₹356 crore** |
| ₹2,000 / month | ~15% of proven recovered value **[E]** | ₹638 crore |
| ₹2,500 / month | ~20% of proven recovered value **[E]** | **₹798 crore** |

> 266,000 × ₹2,500 × 12 = ₹798 crore.

Roughly **₹800 crore of subscription pool, with no change to the customer count.** The lever is price, and the ledger is what makes pulling it defensible rather than extractive — the clinic keeps 75–80% of a number it can audit line by line.

**Risk on this line.** Repricing an installed base is the single hardest commercial manoeuvre in SaaS, and it is much harder in a price-sensitive market with low switching costs. The credible version is not a price rise on existing customers: it is that **new cohorts are sold at the higher price once the ledger has twelve months of evidence behind it**, with legacy customers grandfathered. This means ARPU migrates over four to five years, not two.

---

## 3. Penetration percentages are the wrong frame

"One percent penetration is ₹3.6 crore" frames the company as a rounding error in its own market. A focused vertical player in a fragmented category does not take one percent; it takes 20–30% of the segment it concentrates on, because the whole point of verticalising is that the product fits one segment better than any horizontal alternative.

The pitch should be stated as **segment share of the beachhead**:

| | Figure | Source |
| --- | --- | --- |
| Dental practitioners, India | 80,168 | **[D]** |
| Converted to facilities at ~1.6 practitioners per dental facility | ~50,000 | **[E]** |
| Revenue pool at ₹2,500 / month | ₹150 crore | **[E]** |
| **At 10% segment share** | **₹15 crore ARR** | **[E]** |

₹15 crore of ARR from dentistry alone, before a second vertical, is a credible Series A-to-B outcome and a far more useful thing to put in front of an investor than 1%.

Ten percent is the figure to quote. A focused vertical player can reach 20–30% of its beachhead over a long enough horizon, and it is tempting to pitch that — but share in this segment is won one self-service signup at a time against an installed base of paper, and nothing in the first twenty clinics will justify the higher number. Quote 10% and beat it.

---

## 4. Geography inside India is not a lever — state this plainly

It is tempting to answer the sizing problem with "and then we add more cities." The numbers do not support it, and an investor who checks will find out.

The 266,000 facilities derive from 235,785 solo plus 107,175 small-polyclinic practitioners **[D]** — that is **the national solo-and-small-polyclinic population**, not the eleven focus cities named in §2.4. The eleven cities are a go-to-market sequencing decision, not a boundary on the addressable count. Expanding to tier-3 India deepens the funnel; it does not enlarge the denominator.

The ~86,000 practitioners outside that segment sit in hospitals, chains and institutional settings. That is a genuine up-market pool, but it is a different product, a different sales motion, and it directly conflicts with the sovereignty guarantee in FR-1.1.2. §4 of the corrections memo already ruled it out of scope for v1, and that ruling should hold.

**Conclusion: the three real vectors are price (§2), a second revenue line (§5) and international (§6).**

---

## 5. The second revenue line — analysed, deliberately not planned

> **Status: off the roadmap, and off the pitch.** Sections 5 and 6 were written as a sizing exercise and are retained because the reasoning is worth having on file. Neither is in any milestone, neither is costed, and **neither appears on the investor one-pager.** A one-pager that sizes a procurement marketplace nobody has started building invites precisely the scrutiny the rest of the document is designed to survive. Read these two sections as optionality the architecture happens to preserve, not as plan.
>
> What *is* on the pitch is §1–§4 and §8: one revenue line, subscription, priced to the value the ledger proves.

### 5.1 Concede the payments point before it is raised

Every vertical-SaaS comparison an investor will reach for — Toast, Shopify, Mindbody — monetises a payments take-rate far larger than its subscription. **That route is closed in India.** UPI person-to-merchant carries zero merchant discount rate by regulation, and UPI is how a cash-pay outpatient clinic gets paid. **[D — noted in corrections memo §2]**

Say this first, unprompted. It is the most obvious hole in an Indian vertical-SaaS story, and conceding it converts a weakness into evidence that the analysis is honest.

On the one-pager the concession now stands alone, with nothing offered in its place: *this is subscription revenue only, and we are not sizing an adjacent line we have not built.* That is a stronger position than gesturing at a marketplace with no owner, no timeline and no working capital behind it. The two subsections below record what the options would be if that changes.

### 5.2 Procurement — the largest adjacent pool

A dental practice spends **15–20% of revenue** on consumables, materials and laboratory work. **[E]**

The platform is already sitting on the demand signal. `inventory_batches` (§4.6.4) tracks item, batch, expiry and buffer level with FEFO issue, and the structured laboratory work order (§2.4) already routes to the lab with tooth number, shade and due date. The system therefore knows **what each clinic consumes, at what rate, and when it will run out** — which is the hard part of any procurement marketplace.

Sizing, conservatively: **[E]**

| Step | Assumption | Result |
| --- | --- | --- |
| Procurement per facility | ₹20,000 / month (15% of ₹1.3 lakh collections) | — |
| Across the base | 266,000 facilities | ₹6,400 crore / year |
| Share routed through the platform | 12% — clinics have entrenched distributor relationships | ₹7,700 crore GMV |
| Net take rate | 4% | **≈ ₹310 crore** |

Comparable to, or larger than, the subscription pool. Two cautions that must travel with the number: physical-goods marketplaces carry working-capital and logistics burdens that software does not, and this is a materially different company to operate. It is a Phase 3 line, not a Phase 1 one.

### 5.3 Treatment-plan financing

Named in the corrections memo as the natural second line, and the reasoning holds. The odontogram produces a **phased treatment plan with staged costs** — exactly the artefact a lender needs to underwrite a ₹60,000 full-mouth rehabilitation, a ₹90,000 LASIK procedure or a six-session laser course.

The verticals in §2.4 were sequenced on clinical fit, but they happen to be the four highest-ticket elective segments in Indian outpatient care, which is also where financing penetrates.

Estimated at **₹100–250 crore** at maturity **[E]** — smaller than procurement, but high margin, low operational burden, and it converts the patient's affordability objection into a closed case. That makes it a retention feature as well as a revenue line, which procurement is not.

---

## 6. International — the same status: analysed, not planned

§4.6 is currently presented as an engineering property: a new specialty is configuration, not code, enforced by a CI gate. That undersells it. **The same property makes a new country configuration rather than a rebuild.**

The target markets share India's structure: predominantly cash-pay outpatient care, fragmented single-practitioner facilities, mobile-first, WhatsApp-native, price-sensitive, and poorly served by Western practice-management software priced in dollars. Southeast Asia, MENA and Sub-Saharan Africa together represent a practitioner base several times India's. **[E]**

What a new market actually costs, given the engine:

| Component | Already configuration | Genuinely new work |
| --- | --- | --- |
| Queue stages, recall rules, measures, packages, inventory | ✅ §4.6 | — |
| Language and script | ✅ five Indic locales prove the pipeline | Translation |
| Currency, tax, invoice format | Partially — invoice is templated | Tax rules |
| Health-ID integration | — | Local adapter per country, replacing ABDM |
| Payment rail | — | Local rail, replacing UPI |
| Data residency | ✅ single-VM deployment model | A region |

The honest read is that a new country is perhaps three to five months of engineering rather than a rebuild, and the recurring cost is one more small VM. The bottleneck is distribution, not code. That is the right bottleneck to have.

This would be the argument that turns §4.6 from a line item in the technical plan into a reason the company is worth a venture return — **if and when there is anything behind it.** Today there is not: no market selected, no regulatory work done, no local adapter written, no one assigned. It is therefore off the one-pager.

The discipline to hold here is that §4.6 earns its place in the pitch on what it has already demonstrated — a fourth vertical added as configuration, enforced by a CI gate — and not on a geography nobody has committed to. The first claim is verifiable on a laptop this afternoon. The second is a slide.

---

## 7. The picture that goes on the pitch

Three rungs, all subscription, all India:

| Layer | Annual revenue pool at full capture | Confidence |
| --- | --- | --- |
| Beachhead: India dentistry, ~50,000 facilities | ₹150 crore | **[E]** |
| India, four verticals, today's list price | **₹356 crore** | **[D]** |
| India, four verticals, value-based ARPU | ₹798 crore | **[E]** |

**The near-term number to quote is 10% of the beachhead: ₹15 crore ARR from dentistry.** The path beyond it is two moves, both inside the company's control — add the three sequenced verticals on the existing engine, and re-rate price against proven recovery.

The layers removed from an earlier draft of this document — procurement and international — are recorded in §5 and §6 and are **not** part of this picture.

That leaves an honest conclusion which should be stated rather than hidden: **on India subscription alone this is a ₹100–200 crore revenue business at a realistic share, not a billion-dollar-revenue one.** An investor who needs a decacorn outcome should pass, and will work it out in ten minutes regardless. The right investor is one who can see that a capital-efficient, 90%-gross-margin, ₹0-infrastructure business compounding on a market that currently runs on paper is a good place to put money, and that §5 and §6 exist as options the architecture has already paid for.

Showing ₹356 crore with no explanation invites the opposite reading — *"is this market saturated?"* — which is exactly the question the first one-pager draft provoked.

---

## 8. Why the market is small, and why that is the opportunity

The reflexive reading of a ₹356 crore market is that it is crowded or exhausted. It is neither.

The majority of the 266,000 facilities run on **paper**. Practo Ray, Dentee, Bestosys and Clinicea exist and collectively serve a small fraction of the base. **[E]** This is one of the least penetrated software markets of its size anywhere.

Nobody has won it because the economics are punishing rather than because it is contested: sub-$15 monthly contract value, no budget for field sales, heavy support load, and buyers who are individually tiny and geographically scattered. So vendors price low to acquire, cannot prove value, cannot therefore raise price, and cannot fund the support the segment needs. **The market is small because it is cheap, and it is cheap because no vendor has ever been able to prove return on investment.**

Three decisions in this specification are direct attacks on that loop, and they should be presented as a single strategy rather than three unrelated features:

* **FR-7.4, the Recovered Revenue ledger** breaks the value-proof deadlock, which is what makes §2 possible at all.
* **₹0 infrastructure at pilot scale** (§5) makes a sub-$15 contract survivable while the proof accumulates.
* **FR-1.6 and FR-1.7, self-service onboarding and CSV import,** remove the sales call that the price point cannot fund.

None of the three is impressive in isolation. Together they are the only configuration in which this market can be profitably served, which is the actual defensibility claim.

---

## 9. What would falsify this

Stated so it can be checked rather than believed.

1. **Pilot clinics dispute the ledger.** If owners argue with the recovery attributions rather than accepting them, §2 collapses and the business is capped near ₹356 crore. This is the single most important thing to test in the first twenty clinics, and it should be tested before any pricing work.
2. **Recovered value is materially below ₹16,600.** The §3.3 example is deliberately conservative but it is still an assumption. Measure it.
3. **A new vertical costs code after all.** The CI gate proves no branching on `clinics.vertical` today, with four tenants. If the fifth or sixth vertical requires schema change rather than rows, the second rung of §7 weakens sharply and §6 collapses entirely.
4. **Dentistry share stalls below 10%.** The beachhead figure assumes the product can take one clinic in ten off paper in its focus geography. If self-service signups plateau in the low single digits, the ceiling is a third of what §7 states.
5. **Self-service conversion is poor.** If clinics need a human to onboard, customer acquisition cost swamps a ₹999 contract and the whole structure fails regardless of market size.
