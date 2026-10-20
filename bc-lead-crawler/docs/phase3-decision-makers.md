# Phase 3 — Decision-Maker & LinkedIn Enrichment Engine (design)

Status: **design approved, not implemented.** No paid API calls have been made.
Last updated: 2026-10-20.

## 1. Goal

For each high-value opportunity (Phase 2) or prospect company (Phase 1), identify the one to three people who decide
on or buy Best Construction's services, with a verified business email and — when a compliant source provides it —
their LinkedIn profile URL. Every fact carries its source and retrieval date. Like Phases 1–2, this engine **never
contacts anyone**; it produces a reviewed contact list for agency-agents.

## 2. Decisions (from the owner, 2026-10-20)

| # | Decision |
|---|---|
| 1 | Apollo REST API called directly with an API key (**option a**). Providers are modular so others can be added or swapped later. |
| 2 | Strict budget: **max $50/month**, **dry-run before any paid call**, **cache so the same lookup is never paid twice**, **only companies with opportunity score ≥ 70**, **estimated cost shown and confirmed before every paid run**. |
| 3 | Names and job titles may be collected **only from legitimate public business sources** (company leadership/team pages, public professional/business information via compliant providers). **No private homeowner information.** |
| 4 | LinkedIn only through compliant methods: no scraping of LinkedIn pages, no bypassing login, CAPTCHA, rate limits or access controls. |

## 3. Non-negotiable rules (enforced in code and tests)

1. **No requests to `linkedin.com`** from any module. A shared HTTP guard rejects LinkedIn hosts; a test asserts it.
   LinkedIn profile URLs are accepted only as data returned by a provider (e.g. Apollo's `linkedin_url`) or as a
   search link a human opens manually.
2. **Homeowners are never enriched.** Opportunities with `contact_policy: no_direct_contact`, `lead_segment:
   residential`, or no business entity are filtered out *before* any provider is called. Individuals and family
   trusts from permit contacts were already dropped in Phase 2.
3. **No paid call without an approved estimate.** Paid endpoints are only reachable through the budget guard
   (section 7); there is no code path that calls them directly.
4. **Business data only.** Personal emails are never requested (`reveal_personal_emails=false`), phone reveals are off
   by default, and personal mobiles are excluded. No email-pattern guessing and no SMTP probing.
5. **Public, robots-compliant web sources only** for website extraction (Phase 1 guardrails: robots.txt per RFC 9309,
   honest User-Agent, no login/CAPTCHA/paywall pages).
6. **Suppression first.** The do-not-contact list is checked before enrichment and again before output.
7. **Provenance.** Every person field records `source`, `source_url` or provider record id, and `retrieved_at`.

## 4. Inputs and outputs

**Inputs**
- Phase 2 `opportunities-*.jsonl`: business entities (contractor, owner business, architect/engineer) with licence
  numbers, lead segment, score.
- Phase 1 `prospects-*.jsonl`: company domains, public roles, leadership pages.
- `suppression.csv`: emails/domains/names that must never be returned (opt-outs, existing customers, competitors).

**Output** (`output/decision-makers-<date>.jsonl` + review CSV), one record per company:

```jsonc
{
  "schema_version": 1,
  "account_id": "examplebuilders.com",
  "company": { "name": "Example Builders Inc", "domain": "examplebuilders.com", "licence": "1000001",
               "match_confidence": 0.92, "match_evidence": ["name", "licence", "city"] },
  "segment": "general_contractor",
  "opportunity_ids": ["sf-dbi:9901/001"],
  "contacts": [
    {
      "rank": "primary",                       // primary | reserve
      "name": "…", "title": "Chief Estimator",
      "role_category": "gc_estimating",        // see section 6
      "seniority": "manager",
      "email": "…@examplebuilders.com", "email_status": "verified",   // verified | unverified | none
      "linkedin_url": "https://www.linkedin.com/in/…",                // from provider only
      "linkedin_search_url": null,             // manual-assist link when no profile URL
      "location": "San Francisco, CA",
      "sources": [ { "provider": "apollo", "record_id": "…", "retrieved_at": "…" },
                   { "provider": "website", "source_url": "https://examplebuilders.com/team", "retrieved_at": "…" } ],
      "fit_score": 86, "fit_reasons": ["Title matches GC estimating", "Verified email", "Bay Area"],
      "outreach_ready": true
    }
  ],
  "review_needed": false,
  "cost": { "credits_spent": 2, "cached_hits": 1 }
}
```

`outreach_ready` = verified business email ∧ not suppressed ∧ fit_score ≥ threshold ∧ company match ≥ threshold.
It is a flag for agency-agents; nothing is sent.

## 5. Architecture

```
opportunities (score ≥ 70) ─┐
prospects (Phase 1)  ───────┼─► 1 Eligibility filter (score, segment, homeowner block, suppression)
                            │   2 Account resolution  (name/licence → domain, confidence)
                            │   3 Role targeting      (segment → title list)
                            │   4 Providers           [free first, paid last]
                            │        website team pages (free) → Apollo search (free*) → Apollo enrich (paid)
                            │   5 Merge + rank         (1 primary + ≤2 reserves)
                            │   6 Compliance gate      (verified email, suppression, provenance)
                            └─► decision-makers JSONL/CSV + SQLite (cache, ledger, audit)
```
\* "free" only if verified in your Apollo account (section 12).

### Module layout (`src/enrich/`)

| File | Responsibility |
|---|---|
| `types.ts` | Zod schemas: `Account`, `PersonCandidate`, `DecisionMakerRecord` |
| `eligibility.ts` | Score/segment/homeowner/suppression filter |
| `accounts.ts` | Company → domain resolution and match confidence |
| `roles.ts` | Segment → role categories → title patterns, seniority |
| `providers/provider.ts` | `DecisionMakerProvider` interface |
| `providers/website.ts` | Leadership/team page extraction (Phase 1 crawler) |
| `providers/apollo.ts` | Apollo REST adapter |
| `providers/linkedin-assist.ts` | Builds a LinkedIn search URL for manual use; never fetches |
| `budget.ts` | Cost estimates, monthly ledger, approval tokens, hard caps |
| `cache.ts` / `store.ts` | SQLite: lookup cache, ledger, suppression, audit log |
| `rank.ts` | Fit score and primary/reserve selection |
| `gate.ts` | Compliance gate and `outreach_ready` |
| `main.ts` | CLI (`npm run enrich`) |

### Provider interface

```ts
interface DecisionMakerProvider {
    id: string;                       // 'website' | 'apollo' | …
    paid: boolean;
    /** Cost of the calls `findPeople` would make for this account, without making them. */
    estimate(account: Account, roles: RoleTarget[]): Promise<CostEstimate>;
    findPeople(account: Account, roles: RoleTarget[], ctx: ProviderContext): Promise<PersonCandidate[]>;
}
```
Providers run cheapest-first; paid providers only run for accounts still missing a qualified primary contact.
Adding Clay, ZoomInfo, etc. later = one new file implementing this interface.

## 6. Role targeting (owner's priority list)

| Role category | Title patterns (case-insensitive) | Segments |
|---|---|---|
| `property_management` | Property Manager, Regional Property Manager, Community Manager, HOA Manager, Community Association Manager | property_management, commercial_real_estate |
| `facilities` | Director of Facilities, Facilities Manager | property_management, commercial_real_estate, public_construction* |
| `construction_leadership` | Director of Construction, VP Construction, Construction Manager | developer_home_builder, commercial_real_estate, general_contractor |
| `project_management` | Project Manager, Senior Project Manager | general_contractor, developer_home_builder |
| `purchasing` | Purchasing Manager, Procurement Manager, Buyer (construction), Director of Purchasing | all business segments; builders especially |
| `development` | Development Manager, Director of Development | developer_home_builder |
| `asset_management` | Asset Manager | commercial_real_estate, property_management |
| `gc_estimating` | Estimator, Chief Estimator, Preconstruction Manager, Director of Preconstruction | general_contractor |
| `builder_construction` | Builder purchasing/construction contacts: Purchasing Manager, Construction Manager, Director of Construction, Design Studio / Options Manager | developer_home_builder (home builders) |

\* Public agencies: no people search. Use only the procurement contact named on the public bid notice, and vendor
registration. Residential/homeowner: excluded entirely.

Owner/President is a fallback only for small firms (≤ 20 employees per provider data) when no priority role exists.

## 7. Budget and cost control

**Ledger.** Every paid call is recorded in SQLite (`ledger`: time, provider, endpoint, account, credits, request hash).
Monthly spend = sum over the calendar month (or Apollo's credit cycle).

**Limits (defaults in `enrich.config.json`):**

| Setting | Default | Meaning |
|---|---|---|
| `minOpportunityScore` | 70 | Accounts below this are never sent to paid providers |
| `monthlyBudgetUsd` | 50 | Hard cap; a run that would exceed it is refused |
| `usdPerCredit` | *required* | Your effective cost per Apollo credit (plan price ÷ credits, or overage price) |
| `monthlyCreditCap` | derived | `floor(monthlyBudgetUsd / usdPerCredit)`, and never above remaining plan credits |
| `maxAccountsPerRun` | 25 | Per-run cap |
| `maxContactsPerAccount` | 3 | 1 primary + 2 reserves |
| `revealPhones` | false | Phone reveals cost extra credits; off unless explicitly enabled |
| `cacheTtlDays` | 90 | Cached lookups are reused, never re-bought, within this window |

**Flow — no paid call without an approved estimate:**

```
npm run enrich -- --dry-run
  → lists eligible accounts, cache hits, free-provider results, and for each paid call:
    endpoint, account, estimated credits; totals in credits and USD; month-to-date spend; remaining cap.
  → writes output/enrich-estimate-<id>.json (hash of the exact planned calls), spends nothing.

npm run enrich -- --approve <estimate-id>
  → re-plans; if the plan differs from the approved estimate (new accounts, cache changed, price changed)
    it stops and asks for a new dry run. Otherwise executes only the approved calls,
    stopping immediately if actual credits exceed the estimate or the monthly cap.
```

**Cache keys** (never pay twice): `apollo:org:<domain>`, `apollo:search:<domain>:<role-set-hash>`,
`apollo:person:<apollo_person_id>`. Negative results ("no match") are cached too.

**Rules:** no automatic credit top-ups; Apollo account should have overage/auto-purchase disabled; the engine reads
remaining credits from Apollo before a paid run and refuses if the plan balance is below the estimate.

## 8. Apollo adapter (to verify against your plan before implementation)

| Step | Endpoint | Credits (per Apollo docs / to verify) | Used for |
|---|---|---|---|
| Organization lookup | `GET /api/v1/organizations/enrich?domain=` | verify | Domain → org id, employee count, location |
| People search | `POST /api/v1/mixed_people/api_search` (filters: org domain, titles, location) | Apollo's API page says no credits; **verify** | Candidate names/titles/LinkedIn URLs, no emails |
| People enrichment | `POST /api/v1/people/match` (by Apollo id) with `reveal_personal_emails=false` | consumes credits | Verified work email for the chosen 1–3 people only |
| Credit balance | profile / usage stats | none | Pre-flight balance check |

Authentication: `X-Api-Key` header from env `APOLLO_API_KEY` (never logged, never written to output). Rate limits:
respect 429 + `Retry-After`; small fixed concurrency (2).

**Worst-case cost per account:** 1 org lookup + 0 search + ≤ 3 enrichments ≈ ≤ 4 credits (to confirm). The dry run
reports the real number from the plan; nothing is assumed in code.

## 9. Website provider (public leadership/team pages)

Extends the Phase 1 crawler with an opt-in extractor for **business websites only**:
- Pages: `/team`, `/our-team`, `/leadership`, `/about`, `/staff`, `/contact` already allowed by robots.txt.
- Extracts **name + title pairs** only where they appear together (headings/cards, schema.org `Person` with
  `jobTitle`, `worksFor`). Keeps people whose title matches section 6.
- Never extracts: personal emails, home addresses, photos, family details, or anything from residential/homeowner
  sites. Generic mailboxes stay as in Phase 1.
- Free; runs before Apollo so paid calls are only made where the website gave nothing usable.

## 10. LinkedIn — compliant use only

| Allowed | Not allowed |
|---|---|
| Storing a `linkedin_url` returned by Apollo (or another licensed provider) | Fetching any linkedin.com page by code |
| A `linkedin_search_url` (e.g. `https://www.linkedin.com/search/results/people/?keywords=<title>%20<company>`) for a human to open while logged in to their own account | Logged-in browser automation, Sales Navigator automation, headless browsing |
| Manual review/notes by a person, recorded as `source: manual` | Bypassing login walls, CAPTCHA, rate limits; buying scraped LinkedIn datasets |

LinkedIn's official APIs do not offer people search for this use case, so no LinkedIn developer app is needed.

## 11. Ranking and compliance gate

`fit_score` (0–100) = role match for the segment (0–40) + seniority/decision authority (0–20) + verified business
email (0–15) + Bay Area location (0–10) + source agreement, e.g. website and Apollo both list the person (0–10) +
recency of data (0–5). Primary = highest score; reserves = next two in different role categories where possible.

Gate before output: suppression check (email, domain, name+company), business email only, provenance present,
company match confidence ≥ 0.8, else `review_needed: true`.

**Retention:** person records not refreshed for 12 months are deleted; suppression entries are kept indefinitely.
**Audit:** every provider call (no keys, no full payloads) with time, account, endpoint, credits, result count.

## 12. Things to verify before the first paid call

1. Your Apollo plan includes **API access** with an API key (some sources list API access only on higher tiers).
2. Which endpoints your key may call (people search may need a "master" key).
3. Actual credit cost of `organizations/enrich`, `mixed_people/api_search` and `people/match` on your plan.
4. Whether overage/auto-purchase of credits is disabled.
5. `usdPerCredit` for the $50 cap (plan price ÷ monthly credits, or the overage price if you buy extra).

Account check on 2026-10-20 (read-only): 2,500 lead credits per cycle (cycle 2026-10-18 → 2026-11-18), 0 used,
0 export credits. Plan tier and API-key access were not visible from that check.

## 13. Testing (no paid calls in tests)

- Fake Apollo server (local) for the adapter: auth header, 429 back-off, credit accounting, error mapping.
- Budget tests: refusal over cap, estimate/approval mismatch, cache hit = zero credits, negative-result caching.
- Compliance tests: LinkedIn host guard, homeowner/residential never reaches providers, suppression, no personal
  emails requested, provenance on every field.
- Website extractor tests on fixture team pages (name/title pairs, schema.org `Person`).

## 14. Build order

1. Types, eligibility filter, role table, SQLite store, LinkedIn guard — **no network**.
2. Website provider (free) + ranking + gate → first useful output with zero spend.
3. Budget ledger, estimate/approve flow, cache.
4. Apollo adapter against the fake server; then a **dry run** on real data (free endpoints only).
5. First paid run: ≤ 5 accounts, after showing the estimate and getting approval.
6. Later: more providers (Clay etc.), HubSpot export.
