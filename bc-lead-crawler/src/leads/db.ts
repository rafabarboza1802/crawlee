import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

import type { CompanyRecord, ContactRecord, LeadDatabaseFile, LeadRecord, LeadStatus } from './types.js';
import { ContactRecordSchema, LeadDatabaseSchema, OWNER_STATUSES } from './types.js';

async function readJson(path: string): Promise<unknown | undefined> {
    try {
        return JSON.parse(await readFile(path, 'utf8'));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
        throw error;
    }
}

async function writeJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, JSON.stringify(value, null, 2) + '\n');
}

const HISTORY_LIMIT = 25;

/**
 * Master lead database: every project and company ever evaluated, with status history, so nothing is researched or
 * bought twice. Contains public business information only (no purchased contact details).
 */
export class LeadDatabase {
    private constructor(
        private readonly path: string,
        readonly file: LeadDatabaseFile,
    ) {}

    static async load(path: string): Promise<LeadDatabase> {
        const raw = await readJson(path);
        const file = raw ? LeadDatabaseSchema.parse(raw) : { version: 1 as const, updated_at: new Date(0).toISOString(), leads: {}, companies: {} };
        return new LeadDatabase(path, file);
    }

    async save(now: Date): Promise<void> {
        this.file.updated_at = now.toISOString();
        await writeJson(this.path, this.file);
    }

    get leads(): LeadRecord[] {
        return Object.values(this.file.leads);
    }

    get companies(): CompanyRecord[] {
        return Object.values(this.file.companies);
    }

    lead(id: string): LeadRecord | undefined {
        return this.file.leads[id];
    }

    company(id: string): CompanyRecord | undefined {
        return this.file.companies[id];
    }

    /** Inserts or refreshes a lead's project facts. Returns true when the lead is new. */
    upsertLead(record: Omit<LeadRecord, 'status' | 'status_reason' | 'status_by' | 'status_updated_at' | 'history' | 'first_seen_at'>, now: Date): boolean {
        const existing = this.file.leads[record.lead_id];
        if (existing) {
            this.file.leads[record.lead_id] = { ...existing, ...record, first_seen_at: existing.first_seen_at, owner_note: existing.owner_note };
            return false;
        }
        const at = now.toISOString();
        this.file.leads[record.lead_id] = {
            ...record,
            status: 'NEW',
            status_reason: 'Discovered',
            status_by: 'system',
            status_updated_at: at,
            history: [{ at, status: 'NEW', reason: 'Discovered', by: 'system' }],
            first_seen_at: at,
        };
        return true;
    }

    /**
     * Sets a status. The system never overrides a status the owner set (or an owner-only status); the owner can always
     * change it. Returns false when the change was not applied.
     */
    setStatus(id: string, status: LeadStatus, reason: string, by: 'system' | 'owner', now: Date): boolean {
        const lead = this.file.leads[id];
        if (!lead) return false;
        if (by === 'system' && lead.status_by === 'owner') return false;
        if (by === 'system' && OWNER_STATUSES.includes(status)) throw new Error(`${status} can only be set by the owner.`);
        if (lead.status === status && lead.status_reason === reason && lead.status_by === by) return true;
        const at = now.toISOString();
        lead.status = status;
        lead.status_reason = reason;
        lead.status_by = by;
        lead.status_updated_at = at;
        lead.history = [...lead.history, { at, status, reason, by }].slice(-HISTORY_LIMIT);
        return true;
    }

    /** Gives a lead back to the system (after the owner set a status by hand). */
    releaseStatus(id: string, now: Date): boolean {
        const lead = this.file.leads[id];
        if (!lead) return false;
        lead.status_by = 'system';
        lead.history = [...lead.history, { at: now.toISOString(), status: lead.status, reason: 'Owner handed the lead back to the system', by: 'owner' as const }].slice(-HISTORY_LIMIT);
        return true;
    }

    upsertCompany(record: Omit<CompanyRecord, 'first_seen_at' | 'enrichment' | 'joint_ventures'> & { joint_ventures?: string[] }, now: Date): CompanyRecord {
        const existing = this.file.companies[record.company_id];
        const merged: CompanyRecord = {
            ...existing,
            ...record,
            joint_ventures: [...new Set([...(existing?.joint_ventures ?? []), ...(record.joint_ventures ?? [])])],
            first_seen_at: existing?.first_seen_at ?? now.toISOString(),
            ...(existing?.enrichment ? { enrichment: existing.enrichment } : {}),
        };
        this.file.companies[record.company_id] = merged;
        return merged;
    }

    setEnrichment(companyId: string, enrichment: NonNullable<CompanyRecord['enrichment']>): void {
        const company = this.file.companies[companyId];
        if (company) company.enrichment = enrichment;
    }

    /** Finds leads by id, or every lead of a company (by id or name). */
    find(query: string): LeadRecord[] {
        if (this.file.leads[query]) return [this.file.leads[query]!];
        const q = query.toLowerCase();
        const companyIds = this.companies.filter((c) => c.company_id === q || c.name.toLowerCase().includes(q)).map((c) => c.company_id);
        return this.leads.filter((l) => (l.company_id && companyIds.includes(l.company_id)) || l.project.address?.toLowerCase() === q);
    }
}

const ContactStoreSchema = z.object({ version: z.literal(1), contacts: z.record(z.string(), ContactRecordSchema) });

/** Purchased contacts (names, titles, business emails). Kept in the git-ignored private folder. Deduplicated by person and email. */
export class ContactStore {
    private constructor(
        private readonly path: string,
        private readonly contacts: Record<string, ContactRecord>,
    ) {}

    static async load(path: string): Promise<ContactStore> {
        const raw = await readJson(path);
        return new ContactStore(path, raw ? ContactStoreSchema.parse(raw).contacts : {});
    }

    all(): ContactRecord[] {
        return Object.values(this.contacts);
    }

    forCompany(companyId: string): ContactRecord[] {
        return this.all().filter((c) => c.company_id === companyId);
    }

    /** Adds or updates a contact; the same email under another Apollo id is merged into the existing record. */
    upsert(contact: ContactRecord): void {
        const email = contact.business_email?.toLowerCase();
        const sameEmail = email ? this.all().find((c) => c.id !== contact.id && c.business_email?.toLowerCase() === email) : undefined;
        const id = sameEmail?.id ?? contact.id;
        this.contacts[id] = { ...this.contacts[id], ...contact, id };
    }

    async save(): Promise<void> {
        await writeJson(this.path, { version: 1, contacts: this.contacts });
    }
}
