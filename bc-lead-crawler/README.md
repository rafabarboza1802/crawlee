# bc-lead-crawler

Phase 1 of Best Construction's lead-generation pipeline: a polite crawler (built on
[Crawlee](https://crawlee.dev)) that visits a hand-picked list of company websites and turns each one
into a **prospect record** with public business information and evidence of construction needs.
The records are the input contract for the `agency-agents` pipeline, which does segment
classification, scoring, the "why they need us" write-up, and Apollo enrichment.

> This folder is self-contained (own `package.json`, uses the published `crawlee@3.18.2` from npm) so it can be
> moved into its own repository with `git subtree split --prefix=bc-lead-crawler`.

## Guardrails (enforced in `src/crawl.ts`)

| Rule | How |
|---|---|
| Obey robots.txt | `respectRobotsTxtFile` with the `BestConstructionBot` token; disallowed URLs are never fetched and are logged in `skipped` |
| Honest identity | `User-Agent: BestConstructionBot/0.1 (+https://bestconstruction.pro)`, no generated browser fingerprint headers |
| No evasion | No proxies, no session/cookie rotation, `retryOnBlocked: false` |
| Blocks are final | 401/403/407/429/451 and CAPTCHA / bot-challenge pages are recorded as `blocked` and never retried |
| No logins or paywalls | Login/portal/account links are excluded; only public pages linked from the home page are visited |
| Light footprint | Home page + up to 7 contact/about/services/team/properties pages per site, 4 s between requests to the same domain, 30 requests/min overall |
| Minimal personal data | Only generic mailboxes (`info@`, `office@`, `bids@`, …) are kept; personal emails and people's names are not collected — job titles only |
| Traceability | Every phone, email, role and signal carries its `source_url`; signals include a short quote |

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
  "phones": [{ "value": "+15105550142", "source_url": "https://bayview.example/contact" }],
  "business_emails": [{ "value": "info@bayview.example", "source_url": "https://bayview.example/contact" }],
  "contact_page_urls": ["https://bayview.example/contact-us"],
  "address": { "city": "Oakland", "region": "CA", "source_url": "https://bayview.example/" },
  "service_area_mentions": [{ "value": "Walnut Creek", "source_url": "https://bayview.example/" }],
  "public_roles": [{ "value": "Regional Property Manager", "source_url": "https://bayview.example/about" }],
  "signals": [{ "category": "hardscape", "keyword": "pavers", "snippet": "…new pavers in common areas…", "source_url": "https://bayview.example/" }],
  "crawl_status": "ok",
  "pages": [{ "url": "https://bayview.example/", "status": "ok", "http_status": 200, "fetched_at": "…" }],
  "skipped": [{ "url": "https://bayview.example/team", "reason": "robotsTxt" }]
}
```

`business_emails` are **not verified** and are not meant for cold outreach — outreach uses Apollo-verified contacts.

## Development

```bash
npm test           # unit tests + a local-server test of the robots.txt / block / link-filter guardrails
npm run typecheck
```

## Next phases

1. Public permit feed (DataSF building permits): business-entity contractors/owners with demolition or new-construction permits become seeds with a concrete signal.
2. Public bid notices readable without login.
3. Playwright fallback for public pages that only render with JavaScript (no stealth).
