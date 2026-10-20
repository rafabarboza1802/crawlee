# bc-lead-crawler

Phase 1 of Best Construction's lead-generation pipeline: a polite crawler (built on
[Crawlee](https://crawlee.dev)) that visits a hand-picked list of company websites and turns each one
into a **prospect record** with public business information and evidence of construction needs.
The records are the input contract for the `agency-agents` pipeline, which does segment
classification, scoring, the "why they need us" write-up, and Apollo enrichment.

> This folder is self-contained (own `package.json`, uses the published `crawlee@3.18.2` from npm) so it can be
> moved into its own repository with `git subtree split --prefix=bc-lead-crawler`.

## Guardrails (enforced in `src/crawl.ts` and `src/robots.ts`)

| Rule | How |
|---|---|
| Obey robots.txt (RFC 9309) | robots.txt is fetched by us with our User-Agent and checked for the `BestConstructionBot` token before every page. 4xx = no rules; **5xx or unreachable = treat the whole site as disallowed** (`robots_unavailable`). Disallowed URLs are never fetched and are logged in `skipped` |
| Honor Crawl-delay | The per-domain delay is raised to the strictest accepted `Crawl-delay`; sites asking for more than 20 s get only their home page crawled (`crawlDelayTooLong`) |
| Honest identity | `User-Agent: BestConstructionBot/0.1 (+https://bestconstruction.pro)` on pages and robots.txt, no generated browser fingerprint headers |
| No evasion | No proxies, no session/cookie rotation, `retryOnBlocked: false` |
| Blocks are final | 401/403/407/429/451 and CAPTCHA / bot-challenge pages are recorded as `blocked` and never retried |
| No logins or paywalls | Login/portal/account links are excluded; only same-host public pages linked from the home page are visited (subdomains such as resident portals are not followed). Bid-portal links are recorded, never visited |
| Light footprint | Home page + up to 7 relevant pages per site, at least 4 s between requests to the same domain, 30 requests/min overall |
| Minimal personal data | Only generic mailboxes (`info@`, `office@`, `bids@`, `purchasing@`, …) are kept; personal emails, fax numbers and people's names are not collected — job titles only |
| Traceability | Every phone, email, role, portal link and signal carries its `source_url`; signals include a short quote |

## Lead segments

Set `segment_hint` per seed; the record also carries the derived `segment_group`.

| Segment group | `segment_hint` values | Pages followed (besides contact/about/services/team) | Signals |
|---|---|---|---|
| `property_management` (PM / HOA / multifamily) | `property_manager`, `multifamily_property_manager`, `hoa_management`, `commercial_property_manager` | properties, communities, portfolio | units/communities counts, HOA, common areas, pool deck, pavers, parking lot, capital improvements |
| `general_contractor` | `general_contractor` | projects, subcontractors, trade-partners, prequalification | subcontractors, bid list, prequalification, plan room + bid-platform links (BuildingConnected, SmartBid, …) |
| `developer_home_builder` | `developer`, `home_builder` | developments, new-homes, communities | under construction, now selling, new homes, entitlements, infill, townhomes |
| `commercial_real_estate` | `commercial_real_estate` | properties, leasing, listings, portfolio | square footage, shopping/retail center, business/office park, tenant improvements |
| `public_construction` | `public_agency` | bids, bid-opportunities, rfp(s), procurement, purchasing, public-works, capital-projects | notice inviting bids, RFP/RFQ/IFB, prevailing wage, capital improvement program + bid-portal links (PlanetBids, BidNet, Cal eProcure, …) |
| `residential` | `residential_homeowner` | outdoor-living | backyard, outdoor living, retaining wall, ADU, design studio |

**Residential = organization websites only** (new-home communities, community associations, design studios).
Do not seed individual homeowners' or personal websites: homeowner leads should come from inbound channels, not crawling.

## Usage

Requires Node.js 22+.

```bash
npm install
cp seeds/seeds.example.csv seeds/seeds.csv   # then add 30-50 Bay Area companies
npm run crawl                                # or: npm run crawl -- --seeds my.csv --out output --max-pages 5
```

Output (in `output/`):

- `prospects-YYYY-MM-DD.jsonl` — one JSON prospect per line; the contract for agency-agents (schema: `src/schema.ts`, `schema_version: 1`)
- `prospects-YYYY-MM-DD.csv` — flat copy for a quick human review

Seed CSV columns: `website` (required), `company_name`, `segment_hint`, `source`, `notes`. Lines starting with `#` are ignored.

## Prospect record (abridged)

```json
{
  "schema_version": 1,
  "prospect_id": "bayview.example",
  "website": "https://bayview.example",
  "company_name": "Bayview Residential Management, Inc.",
  "segment_hint": "multifamily_property_manager",
  "segment_group": "property_management",
  "phones": [{ "value": "+15105550142", "source_url": "https://bayview.example/contact" }],
  "business_emails": [{ "value": "info@bayview.example", "source_url": "https://bayview.example/contact" }],
  "contact_page_urls": ["https://bayview.example/contact-us"],
  "address": { "city": "Oakland", "region": "CA", "source_url": "https://bayview.example/" },
  "service_area_mentions": [{ "value": "Walnut Creek", "source_url": "https://bayview.example/" }],
  "public_roles": [{ "value": "Regional Property Manager", "source_url": "https://bayview.example/about" }],
  "bid_portal_links": [],
  "signals": [{ "category": "hardscape", "keyword": "pavers", "snippet": "…new pavers in common areas…", "source_url": "https://bayview.example/" }],
  "crawl_status": "ok",
  "pages": [{ "url": "https://bayview.example/", "status": "ok", "http_status": 200, "fetched_at": "…" }],
  "skipped": [{ "url": "https://bayview.example/team", "reason": "robotsTxt" }]
}
```

`crawl_status` is one of `ok`, `partial`, `blocked`, `robots_disallowed`, `robots_unavailable`, `unreachable`.

`business_emails` are **not verified** and are not meant for cold outreach — outreach uses Apollo-verified contacts.

## Development

```bash
npm test           # Phase 1 + Phase 2 unit tests, plus local fake-server tests of the crawler guardrails and the DataSF pipeline
npm run typecheck
```

## Phase 2: opportunity discovery from public permits

`npm run discover` turns official permit records into scored construction opportunities. It is **read-only**:
it never emails, texts, calls or submits anything. Output goes to `output/` for review, then to agency-agents.

### Sources

| Source id | Jurisdiction | Data | Status |
|---|---|---|---|
| `sf-dbi` | San Francisco | DataSF [Building Permits `i98e-djp9`](https://data.sf.gov/d/i98e-djp9) + [Building Permits Contacts `3pee-9qhc`](https://data.sf.gov/d/3pee-9qhc) (public domain; DataSF moved from `data.sfgov.org` to `data.sf.gov`) | active |
| `contra-costa`, `alameda`, `san-mateo`, `santa-clara`, `marin`, `solano`, `sonoma`, `napa` | | | planned (`--list-sources`) |

Only official open-data APIs are used: robots.txt is checked first (5xx/unreachable = stop), requests identify as
`BestConstructionBot`, pages are fetched 1,000 rows at a time with pauses, 429/5xx are retried with back-off and
401/403 stop the run. Set `SOCRATA_APP_TOKEN` (free from the portal) for higher rate limits.

### What each opportunity contains (`src/discover/types.ts`)

Permit number/type/status/dates, project description, address, parcel, neighborhood, coordinates, estimated value
(revised cost when published), existing/proposed use and units, **business** contacts (contractor, owner entity,
architect, engineer — firm name and licence only), matched Best Construction services with the words that
triggered them, lead segment + reason, contact policy, score 0–100 with every point explained, related permits on
the same property, `is_new`, and the public `record_url` the data came from.

### Pipeline

1. Fetch permits filed or updated in the last `--days` (default 30).
2. Drop duplicates, inactive permits (complete/expired/cancelled/withdrawn…), sign permits and other trades
   (reroof, solar, windows, electrical…).
3. Match services: demolition (buildings, structures, site elements), interior demolition (strip-outs: partitions,
   drywall, ductwork, bathrooms — scored much lower), excavation, grading, concrete, pavers/hardscape, paving/driveways, drainage,
   retaining walls, site work, land clearing, hauling/debris, remodel, ADU, general construction
   (`src/discover/services.ts`). Soft-story retrofits count as foundation (concrete/excavation) work.
4. Look up business contacts for the remaining permits — the query asks only for
   `permit_number, role, firm_name, license1`, so people's names are never downloaded. A firm name is kept only when
   it looks like a company: "Owner"/"Owner Builder" (the homeowner did the work) and person-like names ("Jane Doe",
   "J. Doe AIA") are dropped. Owners are kept only when they are clearly businesses (LLC, developer, agency…).
5. Group permits on the same parcel (e.g. demolition + new building) into one project, plus permits filed the same
   day for adjacent parcels on the same block with near-consecutive numbers (one site split over several lots).
6. Classify the lead segment and score; flag what is new since the last run (`output/discovery-state.json`).

### Scoring (`src/discover/score.ts`)

| Factor | Max | Rule |
|---|---|---|
| Service fit | 40 | Best matched service (core site work 33–35, hardscape/paving 32, concrete 30, ADU 28, new build 22, interior demolition 18, remodel 15) + 2 per extra service |
| Project value | 20 | ≥$5M 20 · ≥$1M 17 · ≥$250K 13 · ≥$75K 9 · ≥$15K 5 · smaller 2 · not published 6 (neutral) |
| Stage | 15 | Filed/plan check/approved 15 (bid window open) · issued 12 (subs being hired) · stalled 4 |
| Recency | 15 | Last activity ≤14 days 15 · ≤30 12 · ≤60 9 · ≤90 6 · ≤180 3 |
| Who to approach | 10 | Named contractor/owner business 10 · architect/engineer 6 · source has no contacts 4 · none listed 2 |
| Adjustments | | +3 several permits on the property · −5 revision permits · inactive capped at 10 · **homeowner-only projects capped at 40** |

Bands: high ≥70, medium 45–69, low <45. `--min-score` (default 40) hides the rest.

### Lead segments and homeowner privacy

| Segment | Rule |
|---|---|
| `public_construction` | Owner is a public agency |
| `developer_home_builder` | New construction adding units, or new build by an owner business |
| `commercial_real_estate` | Office/retail/industrial/other commercial use |
| `property_management` | Apartments/condos or 3+ units (incl. soft-story retrofits) |
| `general_contractor` | Homeowner or other project with a named contractor: approach the contractor for sub work |
| `residential` | Homeowner project with no business named: **market signal only** (`contact_policy: no_direct_contact`) |

Homeowners are never enriched or targeted. Their permits stay in the data only as public signals, approached
through their licensed contractor when one is published.

### Testing with real public records

1. Allow `data.sf.gov` (and `data.sfgov.org`, which redirects to it) on the machine/network you run from (no account needed). If you sit behind an HTTP proxy,
   Node needs `NODE_USE_ENV_PROXY=1`.
2. Check the field names against the live datasets (reads column metadata only):
   ```bash
   npm run discover -- --probe
   ```
   `i98e-djp9` must list `permit_number, description, status, filed_date, status_date` (plus the optional fields
   used in `src/discover/sources/sf.ts`); `3pee-9qhc` must list `permit_number, role, firm_name, license1`.
   If a name differs, the run stops with a schema error listing the real columns — fix the mapping in `sf.ts`.
3. Small first run, then a normal one:
   ```bash
   npm run discover -- --days 7 --max-rows 500 --min-score 0
   npm run discover -- --days 30
   ```
4. Spot-check: open 5–10 rows of `output/opportunities-sf-dbi-<date>.csv`, follow `record_url`, and compare
   the description, status and value with the DataSF record. Run again the next day: only new projects are `NEW`.
5. Offline alternative: save a DataSF API response from a browser, e.g.
   `https://data.sf.gov/resource/i98e-djp9.json?$where=filed_date>='2026-09-15T00:00:00'&$limit=1000`, then
   `npm run discover -- --from-file saved.json --days 30` (contacts are skipped offline).

### Adding a jurisdiction

Find the official permit dataset on the city/county open-data portal. For a Socrata portal, copy
`src/discover/sources/sf.ts`, change the base URL, dataset IDs and field mapping, register it in
`src/discover/sources/registry.ts`, add a fixture-based test, and run `--probe` first. Permit-search websites
without an open-data export (Accela/eTRAKiT search forms, logins) are out of scope.

## Next phases

1. Phase 3 — decision-maker enrichment (Apollo API + public leadership pages, strict budget, compliant LinkedIn use):
   design in [docs/phase3-decision-makers.md](docs/phase3-decision-makers.md), not implemented yet.
2. More jurisdictions (verify each county's open-data permit dataset first).
3. Public bid notices readable without login.
4. Feed named contractors/developers from opportunities into the Phase 1 website crawler as seeds.
