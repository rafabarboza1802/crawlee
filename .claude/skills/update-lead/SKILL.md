---
name: update-lead
description: Update a Best Construction lead's status. Use when the owner says they contacted a company, need a follow-up, got a bid invitation, or want a lead rejected — e.g. "I called Cahill", "mark 321 Florida St as follow-up", "we're bidding the Clarendon project", "show my leads".
---

# Update a lead

In `bc-lead-crawler`:

- Show the current list: `npm run leads`.
- Set a status for a lead (lead id, project address, or company name — a company updates all its leads):
  `npm run lead-status -- "<lead id | address | company>" <STATUS> --note "<what happened>"`
  Statuses: CONTACTED, FOLLOW-UP, BID OPPORTUNITY, REJECTED, COMPETITOR (and the automatic ones). The system never
  overwrites a status the owner set.
- Hand a lead back to the automatic pipeline: `npm run lead-status -- "<lead>" AUTO`.
- If the owner says a company is a competitor or a buyer, also record it in `buyer-registry.json` with their reason
  (`"decidedBy": "owner"`, today's date) so every future lead from that company is classified the same way.

Then commit `data/` and `buyer-registry.json` with `chore: update lead status (YYYY-MM-DD)` and push.
