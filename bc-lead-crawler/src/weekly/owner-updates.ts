import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';

import type { LeadDatabase } from '../leads/db.js';
import { LEAD_STATUSES, type LeadStatus } from '../leads/types.js';

/**
 * data/owner-updates.csv lets the owner change leads from the GitHub website (no code, no Claude):
 *   lead_or_company,status,note
 *   Cahill Contractors,BID_INVITED,Got the invite for Clarendon
 *   356 West Clarendon Rd,WON,
 * Each row is applied once (remembered by its content). STOP = DO_NOT_CONTACT; AUTO hands the lead back to the system.
 */
export async function applyOwnerUpdates(path: string, db: LeadDatabase, now: Date): Promise<{ applied: string[]; problems: string[] }> {
    let text = '';
    try {
        text = await readFile(path, 'utf8');
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { applied: [], problems: [] };
        throw error;
    }
    const applied: string[] = [];
    const problems: string[] = [];
    for (const line of text.split(/\r?\n/).slice(1)) {
        if (!line.trim() || line.startsWith('#')) continue;
        const hash = createHash('sha256').update(line.trim()).digest('hex').slice(0, 16);
        if (db.file.applied_owner_updates.includes(hash)) continue;
        const [query = '', rawStatus = '', ...noteParts] = line.split(',').map((x) => x.trim());
        const note = noteParts.join(',').trim();
        const status = rawStatus.toUpperCase().replace(/[\s-]+/g, '_').replace(/^STOP$/, 'DO_NOT_CONTACT');
        const leads = db.find(query);
        if (!leads.length) {
            problems.push(`owner-updates.csv: no lead or company matches "${query}"`);
            continue;
        }
        if (status !== 'AUTO' && !(LEAD_STATUSES as readonly string[]).includes(status)) {
            problems.push(`owner-updates.csv: unknown status "${rawStatus}" for "${query}"`);
            continue;
        }
        for (const lead of leads) {
            if (status === 'AUTO') db.releaseStatus(lead.lead_id, now);
            else db.setStatus(lead.lead_id, status as LeadStatus, note || 'Set by owner (owner-updates.csv)', 'owner', now);
            if (note) lead.owner_note = note;
        }
        db.file.applied_owner_updates.push(hash);
        applied.push(`${query} → ${status} (${leads.length} lead${leads.length === 1 ? '' : 's'})`);
    }
    return { applied, problems };
}
