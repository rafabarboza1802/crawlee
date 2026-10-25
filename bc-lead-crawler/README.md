# Best Construction lead-generation system

Every Monday morning this system finds new construction projects in public records, works out which company is
buying the work, keeps competitors out, finds the right estimator or preconstruction contact, sends a short personal
introduction email (once sending is switched on), follows up, stops when someone replies, and writes you a report.
It runs in GitHub's cloud: your computer and Claude do not need to be on.

## OWNER OPERATIONS

### What happens automatically every Monday

At about 8:15 AM Pacific, GitHub runs the weekly job (`.github/workflows/bc-weekly-leads.yml`):

1. **Discover** new building permits from the public sources that are switched on (today: San Francisco).
2. **Verify** each project: active, has an address, worth at least $100,000, includes our work (demolition,
   excavation, grading, sitework, utilities, concrete, paving/hardscape, clearing, hauling). Small interior remodels
   and tiny repairs are rejected.
3. **Identify** the GC, developer and owner named on the permit, and **classify** the company: approved buyer,
   competitor, small contractor, or needs review. Joint ventures are matched to the partner that runs subcontractor
   bidding. A word like "Paving" in a name is never enough to block a company; evidence is.
4. **Score** and **de-duplicate** (one record per project, one email sequence per person).
5. **Find the decision maker** (estimator, preconstruction, project executive/manager, procurement) at approved
   buyers with Apollo, only within the credit limits, never twice for the same company.
6. **Email** each new contact once, then follow up on day 4 and day 10 (3 emails maximum), in the same thread. It
   stops at once when they reply, unsubscribe, the email bounces, the company turns out to be a competitor, or you mark
   the lead STOP. Companies that are not proven buyers are never emailed.
7. **Report**: saves the weekly report, emails it to you, and saves the lead database.

### Where things are

| What | Where |
|---|---|
| This week's report | `bc-lead-crawler/data/reports/weekly/<date>.md` (also emailed to you, with contact names and emails) |
| Week-by-week history | `bc-lead-crawler/data/reports/weekly-history.csv` |
| Qualified leads | `bc-lead-crawler/data/reports/qualified-opportunities.csv` (open it on GitHub, or download and open in Excel) |
| Approved buyers / competitors / needs review | `approved-buyers.csv`, `rejected-competitors.csv`, `manual-review.csv` in the same folder |
| Apollo spending | `apollo-ledger.csv` in the same folder |
| Master lead database | `bc-lead-crawler/data/lead-db.json` (public business facts only) |
| Contact names, emails, email log | `bc-lead-crawler/data/private.vault`, encrypted; only readable with your `LEAD_DATA_KEY` |

This repository is public, so names and email addresses are never stored in readable form there. You receive them
in the Monday email. To get a full private spreadsheet, ask Claude "Export my private CRM" (it runs `npm run crm`).

### Lead statuses

| Status | Meaning |
|---|---|
| NEW | Just discovered |
| QUALIFIED | Good project; the buyer still needs a decision maker, or no GC is named yet (watch list) |
| NEEDS_REVIEW | Good project, but the company is not yet proven to be a buyer. Never emailed |
| CONTACT_READY | Approved buyer with a verified business email; first email goes out on the next run |
| CONTACTED / FOLLOW_UP | Emails sent; waiting for a reply |
| REPLIED | They answered; follow-ups stopped; your turn |
| ESTIMATING / BID_INVITED / BID_SUBMITTED / WON / LOST | Set by you |
| COMPETITOR | Self-performs our scopes or a known competitor. Never contacted |
| DO_NOT_CONTACT | Opted out, bounced, blocked or STOP. Never contacted again |
| REJECTED | Not a fit (too small, inactive, homeowner, unrelated) |

The system never overwrites a status you set.

### How to…

| I want to… | Do this |
|---|---|
| **See qualified leads** | Open the Monday email, or `data/reports/qualified-opportunities.csv` on GitHub. In Claude: "Show my leads." |
| **Pause all emails** | GitHub → repository **Settings → Secrets and variables → Actions → Variables** → create `OUTREACH_MODE` with value `off`. Delete it (or set `test`) to resume. Takes effect on the next run. |
| **Block a company** | Add its name or web domain on a new line in `bc-lead-crawler/data/blocklist.txt` (GitHub: open the file → pencil icon → Commit). Or tell Claude "Block <company>". For a competitor, Claude also records it in `buyer-registry.json`. |
| **Stop emails to one lead** | Add a line `<company or address>,STOP,<note>` to `data/owner-updates.csv`, or tell Claude "Stop emailing <company>". |
| **Mark a lead WON / LOST / BID_INVITED…** | Add `<company or address>,WON,<note>` to `data/owner-updates.csv` (applied on the next run), or tell Claude "Mark Clarendon as won". |
| **Change sending limits** | Edit `bc-lead-crawler/outreach.config.json` → `limits` (`maxNewPerRun`: new prospects per week, default 10; `maxEmailsPerRun`: all emails per week, default 25; `delaySeconds` between emails) and `sequence` (`followUpDays` [4, 10], `maxEmails` 3). |
| **Change the Apollo budget** | Edit `bc-lead-crawler/enrich.config.json`: `monthlyCreditCap` (500), `monthlyBudgetUsd` (50), `autoEnrich.maxCreditsPerRun` (20 per weekly run), `autoEnrich.enabled` (false = only with your approval). |
| **Run it now** | GitHub → **Actions** → "Best Construction weekly leads" → **Run workflow** (choose email mode `test` or `off` for a safe run). In Claude: "Find new Best Construction leads." |
| **Turn on real sending** | After a successful test run, fill in `liveAuthorization` (your name and the date) and the `sender` details in `outreach.config.json`, and set `"mode": "live"`. |

### When something fails

- **A permit source is down**: the run continues with the other sources; the report lists the failed source under
  "Errors and source failures", and the GitHub run is marked red so GitHub emails you.
- **Email login fails** (password change, revoked access): nothing is sent, nothing is lost. Emails stay queued for
  the next run, and the report says what to fix.
- **Apollo fails or the budget is reached**: the leads stay QUALIFIED and are retried next week.
- **The encryption key is missing or wrong**: no contacts are bought and no emails are sent (to avoid buying or
  emailing twice); discovery and the report still run.

### Email rules (built in)

- Plain-text emails, personalized with the recipient's first name, company, project, location, and only the
  scopes that project involves. No claims about licences, bonding, experience or past projects.
- Every email identifies Best Construction Inc., includes the website, your mailing address and an opt-out line
  ("reply unsubscribe"). A List-Unsubscribe header is also included.
- Only Apollo-verified business emails on the company's own domain are used. Addresses are never guessed.
- Conservative limits: 10 new prospects and 25 emails per week, at most 1 email per company per run, 30 seconds
  between emails. One sequence per person; the same person is not approached again within 60 days.
- Suppression lists: opt-outs, permanent bounces, competitors and your blocks. Never emailed again.
- **Test mode** sends every message to your test address only, marked [TEST]. **Live mode** refuses to start
  until a test has passed and you have filled in `liveAuthorization`.

### One-time setup (secrets)

All credentials go in GitHub → **Settings → Secrets and variables → Actions → Secrets**, never in files:

| Secret | What it is |
|---|---|
| `LEAD_DATA_KEY` | A long random password you invent (keep a copy in your password manager). Encrypts private data. |
| `APOLLO_API_KEY` | Your Apollo API key |
| `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` | From Google Cloud Console → APIs & Services → Credentials → OAuth client (Desktop app), with the Gmail API enabled |
| `GMAIL_REFRESH_TOKEN` | Authorizes the sending mailbox: run `npx tsx scripts/gmail-auth.ts` on your computer (see below) |
| `OUTREACH_FROM` | The Best Construction mailbox that sends (the one you authorized) |
| `OUTREACH_TEST_TO` | A company-controlled address that receives test emails |
| `OWNER_REPORT_TO` | Where the Monday report goes |

Gmail authorization (Google Workspace): in Google Cloud Console create a project, enable the **Gmail API**, set the
OAuth consent screen to **Internal** (Workspace) so the authorization does not expire, and create an **OAuth client
ID** of type **Desktop app**. Then on your computer, inside `bc-lead-crawler` (after `npm ci`), run
`npx tsx scripts/gmail-auth.ts`. It asks for the client ID and secret (the secret is not shown), opens Google's
sign-in page in your browser, and prints the refresh token. Sign in with the sending mailbox and paste the token into
the `GMAIL_REFRESH_TOKEN` secret. If the browser does not open, paste the short `http://127.0.0.1:…` link it prints.
Scopes requested: send, and read (only to detect replies, bounces and unsubscribe requests). No password is stored.

### Where it looks

Working today: **San Francisco** building permits (DataSF, public, refreshed daily). Other counties (Contra Costa,
Alameda, Santa Clara, San Mateo, Sonoma, and later all of California) are added in `sources.config.json` once their
official open-data permit dataset is confirmed; no code change is needed (see `sources.config.example.json` and
"Adding a jurisdiction" below). A source that is not confirmed is never reported as working.

### Doing it by hand (optional)

The earlier commands still work inside `bc-lead-crawler/`: `npm run find-leads` (free discovery), `npm run
prepare-contacts` (Apollo estimate, then `-- --approve <id>`), `npm run lead-status -- "<lead|company>" WON`,
`npm run leads`, `npm run outreach-sample` (one sample email to the test address), `npm run crm` (private
spreadsheet, needs `LEAD_DATA_KEY`), and `npm run weekly` (the whole Monday job).

---

# Technical reference

The system is built in three layers, plus the lead pipeline that ties them together (`src/leads/`):

1. **Website crawler** (`src/crawl.ts`, `npm run crawl`): a polite crawler (built on [Crawlee](https://crawlee.dev))
   for a hand-picked list of company websites, producing prospect records.
2. **Opportunity discovery** (`src/discover/`, `npm run discover`): public permits → scored opportunities.
3. **Decision-maker enrichment** (`src/enrich/`, `npm run enrich`): buyer gate + budget-capped Apollo lookups.

The lead pipeline (`npm run find-leads` / `prepare-contacts` / `lead-status` / `leads`) runs discovery, the buyer gate
and enrichment against the master database `data/lead-db.json`. That file and the ledger are committed so they
survive new sessions. It holds public business information only, never purchased contact details.

> This folder is self-contained (own `package.json`, uses the published `crawlee@3.18.2` from npm) so it can be
> moved into its own repository with `git subtree split --prefix=bc-lead-crawler`.

## Weekly automation (technical)

- `src/weekly/main.ts` (`npm run weekly`): the Monday job. Steps are isolated: a failing source, Apollo or the
  mailbox is recorded in the report and the run continues; the process exits non-zero when anything failed so GitHub
  flags the run.
- `src/outreach/`: `engine.ts` (inbox sync → stop rules → send queue → limits → test/live sending), `gmail.ts` (Gmail
  API over OAuth refresh token, `fetch` only), `templates.ts` (3-step plain-text sequence), `store.ts` (private
  outreach log, hashed public suppression list), `vault.ts` (AES-256-GCM encryption of `data/private` into
  `data/private.vault`, key from `LEAD_DATA_KEY`), `config.ts` (modes and limits).
- `src/weekly/enrich.ts`: automatic Apollo lookups for approved buyers within `autoEnrich.maxCreditsPerRun` and the
  monthly cap. `src/weekly/owner-updates.ts`: applies `data/owner-updates.csv` once per row.
- Public state in `data/`: `lead-db.json` (leads, companies, outreach summaries without names), `suppression.json`
  (sha256 of suppressed emails), `outreach-state.json`, `apollo-ledger.json`, `research-cache.json`, reports.

## Website crawler

### Guardrails (enforced in `src/crawl.ts` and `src/robots.ts`)

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

### Lead segments

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

### Usage

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

### Prospect record (abridged)

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

Find the official permit dataset on the city/county open-data portal. For a Socrata portal no code is needed: add
an entry to `sources.config.json` (copy `sources.config.example.json`: base URL, dataset id, date columns and the
column names), run `npm run discover -- --source <id> --probe` to check the columns, then set `"enabled": true` and add
the id to `sources` in `leads.config.json`. A missing required column stops the run with the real column list. For
other portal types (ArcGIS Hub, CKAN), write a source like `src/discover/sources/sf.ts` and register it in
`src/discover/sources/registry.ts`. Permit-search websites
without an open-data export (Accela/eTRAKiT search forms, logins) are out of scope.

## Phase 3: decision-maker enrichment

Design: [docs/phase3-decision-makers.md](docs/phase3-decision-makers.md). Two steps, and nothing is ever sent to
the people found:

```bash
# 1. Plan and estimate — no Apollo calls, no credits
npm run enrich -- --dry-run --input output/opportunities-sf-dbi-<date>.jsonl [--limit 5]

# 2. Run exactly that plan (uses credits) — the command is printed by the dry run
npm run enrich -- --approve <planId> --input output/opportunities-sf-dbi-<date>.jsonl [--limit 5]
```

1. Takes Phase 2 opportunities scoring ≥ 70 (configurable). Homeowner projects, public agencies and permits with no
   contractor or business owner named are listed as excluded and never looked up.
2. **Buyer gate** (`src/enrich/gate.ts`): every company is classified Buyer, Competitor or Uncertain before
   anything can reach Apollo. Only Buyers are planned; Competitors are blocked; Uncertain stops for manual review and
   never uses credits. The executor also refuses any non-buyer. Order of checks:
   - `buyer-registry.json`: permanent allow/deny list (name, aliases, licences, reason, evidence). Joint ventures
     map to the managing GC that runs subcontractor bidding, and are enriched as that GC. An unknown JV is Uncertain.
   - Owner decisions in the registry: `do_not_enrich` (e.g. a JV partner that is not the bidding contact) is skipped,
     and `uncertain` entries keep research notes for companies still awaiting a decision.
   - Competitor-risk words (`competitorRiskPatterns`: paving, excavating, demolition, concrete, trucking …) only
     flag the company for research. A name alone never blocks; only evidence that it self-performs those scopes does.
   - Free public research for every new company: its own SF permits over 3 years (DataSF, by licence; cached 30 days
     in `output/buyer-research-cache.json`). Mostly stand-alone demolition/grading/sitework permits → Competitor.
     Otherwise Uncertain, with the evidence attached. Research cannot prove that a company subcontracts sitework,
     so a new company never becomes a Buyer automatically: confirm it, then add it to the registry.

   The dry run also writes `output/buyer-review-<date>.csv` (blocked and manual-review companies with reasons).
3. Groups buyers by company (contractor first, else a business owner), best score first, max 25 companies per run
   (`--limit` for fewer). Names are cleaned for searching (legal suffix, "*See Notes*", DataSF's 40-character cut).
4. Per company: Apollo organization search (website, company phone, LinkedIn company page; California only, name
   similarity ≥ 0.85 or it stops) → people search for the priority titles (estimator/preconstruction, PM,
   construction manager, superintendent, purchasing, owner/president/operations; property-manager and developer
   titles for owner companies) → verified business email for the primary contact only. Personal emails and phone
   reveals are off; consumer-domain or unverified emails are dropped.
5. The dry run writes `output/contact-plan-<date>.csv|jsonl` (one row per qualified opportunity with address,
   description, value, score, company, licence, reason to contact, recommended pitch, target titles, manual
   LinkedIn search link) and `output/enrich-estimate-<planId>.json` (every request a paid run would send).
6. `--approve` refuses unless the plan id matches the reviewed dry run exactly, `APOLLO_API_KEY` is set and the
   monthly cap has room. It never spends beyond the estimate's maximum, records every paid call in
   `data/apollo-ledger.json`, caches results (in `data/private/apollo-cache.json`) (including "no match") for 90 days so nothing is bought twice, stops
   the run if Apollo rejects the key, and writes `output/contact-plan-<date>-enriched.csv|jsonl`.

The key is read from the `APOLLO_API_KEY` environment variable and sent only in Apollo's `x-api-key` header. LinkedIn
is never requested by code (enforced by a guard and tests); profile URLs come only from Apollo, otherwise a manual
search link is given. Settings: copy `enrich.config.example.json` to `enrich.config.json` and set `usdPerCredit` to
see dollars. Credit costs per endpoint are assumptions to verify. Do-not-contact list: `suppression.txt` (git-ignored).

## Next steps

1. More counties: confirm each county's open-data permit dataset, allow its domain, add it to `sources.config.json`.
2. Public bid notices readable without login (e.g. agency bid boards) as a second discovery source.
3. A free website team-page provider (public leadership pages), run before Apollo to save credits.
