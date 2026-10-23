---
name: find-leads
description: Find new Best Construction leads. Use when the owner says "Find new Best Construction leads", "find leads", "any new projects?", or asks for the best current opportunities. Runs the free discovery + research + buyer-gate pipeline in bc-lead-crawler and reports the best qualified opportunities. Never spends Apollo credits and never contacts anyone.
---

# Find new Best Construction leads

Free pipeline: DISCOVER (public permits) → VERIFY PROJECT → SCORE → CLASSIFY COMPANY → BUYER GATE → report.
It never calls Apollo, never sends anything, never registers anywhere.

## Steps

1. `cd bc-lead-crawler` (inside the repository). If `node_modules` is missing, run `npm ci`.
2. Run `npm run find-leads`. It takes a few minutes: it downloads recent public permits, researches new companies in
   public DataSF records (cached), updates the master database `data/lead-db.json` and writes the reports in
   `data/reports/`. If DataSF is unreachable, say so plainly (the network allowlist must include data.sf.gov and
   data.sfgov.org) and stop.
3. Research genuinely uncertain companies so the owner is not asked about them. For each company in
   `data/reports/manual-review.csv` whose best project is worth pursuing (score ≥ 80, or value ≥ $5M, or new
   construction), use free public web search only (no logins, no sign-ups, no LinkedIn scraping) and decide:
   - **buyer** only with evidence that it solicits subcontractor bids for our scopes (demolition, excavation, grading,
     sitework/earthwork, land clearing, concrete flatwork/removal, site utilities, hauling, paving, pavers/hardscape)
     and does not self-perform them — e.g. a bid invitation, trade/bid portal, prequalification notice;
   - **competitor** only with evidence that it self-performs those scopes;
   - otherwise leave it **uncertain** with your notes.
   A name word such as Paving, Concrete, Grading, Demolition, Underground, Sitework or Trucking is never enough on
   its own. For a joint venture, add it under `jointVentures` with the partner that runs subcontractor bidding as
   `managingGc`, only when the evidence shows it.
   Record each decision in `buyer-registry.json` (reason, scope, evidence URLs, `"decidedBy": "research"`, today's
   date), then run `npm run find-leads -- --reuse` to re-classify without downloading again.
4. Report to the owner, short and plain:
   - counts: opportunities discovered, qualified, rejected, competitors blocked, manual review;
   - **Best opportunities with an approved buyer** and **strong projects to watch**, from `data/reports/summary.md`
     (project, value, GC, location, scope, score, bid timing);
   - companies you classified in step 3 and why;
   - the exact Apollo credits the next contact batch would need (from the summary), and that contacts are prepared
     only when they say "Prepare contacts for today's qualified leads."
5. Save the memory: commit `data/` (never `data/private/`, which git ignores) and `buyer-registry.json` with
   `chore: update lead database (YYYY-MM-DD)` and push to the current branch.

Never run `npm run prepare-contacts -- --approve`. Never email, call, submit forms or register anywhere: email
outreach happens only in the Monday cloud job (`npm run weekly`), under the rules in outreach.config.json.
