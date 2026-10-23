---
name: update-lead
description: Update a Best Construction lead or block a company. Use when the owner says they contacted a company, got a bid invitation, won or lost a job, wants emails stopped, wants a company blocked, or asks to see leads or export the private CRM — e.g. "Mark Clarendon as won", "We got invited to bid on 321 Florida St", "Stop emailing Cahill", "Block XYZ Paving", "Show my leads", "Export my private CRM".
---

# Update a lead

In `bc-lead-crawler` (run `npm ci` if `node_modules` is missing):

- Show leads: `npm run leads`.
- Set a status (lead id, project address, or company name — a company updates all its leads):
  `npm run lead-status -- "<lead | address | company>" <STATUS> --note "<what happened>"`
  Owner statuses: ESTIMATING, BID_INVITED, BID_SUBMITTED, WON, LOST, DO_NOT_CONTACT (STOP is the same), REJECTED,
  COMPETITOR. The system never overwrites a status the owner set; `AUTO` hands the lead back to the system.
  Any owner status stops that lead's email follow-ups.
- Block a company or domain from all email: add it on its own line to `data/blocklist.txt`. If the owner says it is a
  competitor (or a buyer), also record that in `buyer-registry.json` with their reason (`"decidedBy": "owner"`, today's
  date) so future leads are classified the same way. Never write a person's email address into a public file: for an
  individual address, add `<company>,STOP,<note>` to `data/owner-updates.csv` instead.
- Export the private CRM (names, emails, outreach log): needs `LEAD_DATA_KEY` in the environment; never paste it into
  chat or files. Run `npm run crm` and give the owner the path `data/private/reports/contacts.csv` (not committed).

Then commit `data/` (never `data/private/`) and `buyer-registry.json` with `chore: update lead status (YYYY-MM-DD)` and push.
