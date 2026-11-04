# Harvey setup for Best Construction

[Harvey](https://github.com/ethanplusai/harvey) is an outreach agent that finds local businesses, writes short
personal cold emails, and handles replies, running on your Claude subscription. This folder has Harvey ready-made
for Best Construction, one folder per segment:

| Folder | Segment | What Harvey pitches |
|---|---|---|
| `property-managers/` | Property managers, HOAs, facilities | Commercial pavers, pool deck pavers, build & remodel |
| `home-builders/` | Home builders | Outdoor Living Partner Program only (3 fixed-price tiers, 90-day pilot) |

General contractors and developers are **not** here: the lead crawler already works those from building permits,
and Harvey is told never to email the companies the crawler handles (`do_not_contact`).

Safety settings in both folders:
- **Every email waits for your approval** in Harvey's Outbox (`require_approval: true`). Nothing sends on its own.
- At most **6 emails a day**, starting at 2 a day once the mailbox is warmed up.
- Sends only 8 AM to 4 PM, Monday to Friday. Plain-text emails with a "no thanks" opt-out line.
- LinkedIn is off.

Harvey runs on **your own computer** (Mac or Linux), not in GitHub.

## Before you start

1. **The sending mailbox: `info@bestconstruction.pro`** (the company Google Workspace account). Because this is
   the main business domain, keep the total cold email from `bestconstruction.pro` at 6 a day or less, including the
   lead crawler once it sends live (then set `max_daily_sends: 3` in each). Check that DKIM is on in
   admin.google.com → Apps → Google Workspace → Gmail → Authenticate email.
2. **Ramp up slowly.** The settings start at 2 cold emails a day and add one a day up to 6. The ramp is anchored to
   `channels.email.warmup.start_date` (set 14 days before 2026-11-04); if you first run Harvey later, change it to
   14 days before that day.
3. **An email verifier key.** A free [Reoon](https://reoon.com/email-verifier) key (600 checks a month) is enough.
   Without one, Harvey never sends to an address it guessed.
4. **Python 3.11+** and **Claude Code** installed and logged in (`claude login`).

## Install (one segment)

Start with `property-managers`. To use `home-builders` instead, swap the folder name in step 2.

1. Download Harvey:
   ```bash
   git clone https://github.com/ethanplusai/harvey.git harvey-property-managers
   cd harvey-property-managers
   python3 -m venv .venv && source .venv/bin/activate && pip install -e .
   ```
2. Copy in the Best Construction settings (adjust the path to wherever your copy of this repo is):
   ```bash
   cp -r ~/crawlee/bc-lead-crawler/harvey/property-managers/. .
   ```
3. Open `harvey.local.yaml` and fill in the `TODO` line:
   - `compliance.postal_address`: Best Construction's mailing address. US law requires it in every cold email.
4. Add your keys:
   ```bash
   cp .env.example .env
   ```
   In `.env`, fill in `GMAIL_CLIENT_ID`, `GMAIL_CLIENT_SECRET` (the comments in the file say where to get them) and
   `REOON_API_KEY`. Then connect the mailbox:
   ```bash
   harvey gmail auth
   ```
5. Turn on the free prospect signals and find businesses:
   ```bash
   harvey signals --confirm free
   harvey discover --estimate
   harvey discover
   ```
   The free source (OpenStreetMap) has limited coverage. For a fuller list, DataForSEO Business Listings costs about
   $0.37 per 1,000 businesses:
   ```bash
   harvey discover --provider dataforseo_listings --max-spend 2.00
   ```
6. Start it and review the drafts:
   ```bash
   harvey dashboard
   ```
   ```bash
   harvey run
   ```
   Open the link `harvey dashboard` prints, then go to **Outbox**: `A` approves an email, `R` rejects it.
   To stop everything at once: `harvey sending pause`.

**Don't run `harvey train`.** It rewrites the product and targeting in `harvey.local.yaml` from the website, which
mixes the segments together.

## Running both segments

Use a separate Harvey folder for each segment (`harvey-property-managers`, `harvey-home-builders`), because each
keeps its own prospect database and product knowledge. If both send from the same mailbox, lower
`max_daily_sends` to 3 in each so the total stays at 6 a day.

## Keeping the do-not-contact list current

The crawler adds buyers and competitors every week. To copy them into Harvey's block list:
```bash
python3 ~/crawlee/bc-lead-crawler/harvey/sync_do_not_contact.py ~/harvey-property-managers/harvey.local.yaml
```
A running Harvey picks up the change immediately. To block one more company or address by hand, add it under
`compliance.do_not_contact` in `harvey.local.yaml`.

## Files

| File | What it does |
|---|---|
| `harvey.local.yaml` | Who to target, what to offer, sending limits, compliance |
| `skills/product_knowledge.md` | What Harvey knows about Best Construction for this segment (and what it must not pitch) |
| `skills/email_rules.md` | How the emails are written: voice, length, sign-off |
