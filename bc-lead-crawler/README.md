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
npm test           # unit tests, per-segment extraction tests, and local-server tests of the robots.txt / block / link-filter guardrails
npm run typecheck
```

## Next phases

1. Public permit feed (DataSF building permits): business-entity contractors/owners with demolition or new-construction permits become seeds with a concrete signal.
2. Public bid notices readable without login.
3. Playwright fallback for public pages that only render with JavaScript (no stealth).
