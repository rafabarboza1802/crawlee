---
name: prepare-contacts
description: Prepare contacts for today's qualified leads. Use when the owner says "Prepare contacts for today's qualified leads", "get contacts", or "find decision makers". Calculates the exact Apollo credits for every approved buyer still needing a decision maker, asks ONE approval for the whole batch, and only then runs the paid lookup. Never contacts anyone.
---

# Prepare contacts for today's qualified leads

Paid step (Apollo credits). Only approved buyers with qualified leads (score ≥ 70) that were never looked up before are
included; cached results are reused; the monthly cap (500 credits / $50) and the ledger `data/apollo-ledger.json` are
enforced in code.

## Steps

1. `cd bc-lead-crawler` (run `npm ci` if `node_modules` is missing).
2. The Monday cloud job already buys contacts automatically within `autoEnrich.maxCreditsPerRun` (enrich.config.json).
   This workflow is for an extra batch on demand. If there are no QUALIFIED leads of approved buyers, run find-leads first.
3. Run `npm run prepare-contacts` (free estimate). It prints the companies, the checks, the EXACT credits (expected and
   maximum) and a batch id. If it says nothing is waiting, tell the owner and stop.
4. Ask the owner ONE question for the whole batch (use AskUserQuestion): list each company with its best project and
   credits, the total maximum credits, credits used this month and the cap. Options: approve the batch, or not now.
   Do not ask about individual companies.
5. Only after an explicit approval: check `APOLLO_API_KEY` exists without printing it (`test -n "$APOLLO_API_KEY"`),
   then run `npm run prepare-contacts -- --approve <batch id>`. If it says the batch changed, re-run step 3 and ask
   again. Never pass `--approve` without that approval, and never ask the owner to paste the key.
6. Report: per company, the decision maker found (name, title, verified business email or why not), credits used,
   credits left this month. Contacts are in `data/private/reports/contacts.csv` (private, not committed: the
   repository is public).
7. Commit `data/` (the database and ledger; `data/private/` is ignored) with
   `chore: record contact lookup (YYYY-MM-DD)` and push to the current branch.

Never send emails, connect on LinkedIn, call, submit forms or register anywhere. Outreach is the owner's decision.
