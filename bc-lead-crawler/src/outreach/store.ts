import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { z } from 'zod';

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

/** One-way fingerprint of an email address, so the public suppression list never contains addresses. */
export const emailHash = (email: string) => createHash('sha256').update(email.trim().toLowerCase()).digest('hex');
export const domainOf = (email: string) => email.split('@')[1]?.trim().toLowerCase() ?? '';
/** "sam@example.com" → "s***@example.com" (for public reports and logs). */
export const maskEmail = (email: string) => email.replace(/^(.).*@/, '$1***@');

const StepSchema = z.object({
    step: z.number().int().min(1),
    sent_at: z.string(),
    message_id: z.string(),
    rfc_message_id: z.string().optional(),
    subject: z.string(),
});

const SequenceSchema = z.object({
    id: z.string(),
    contact_id: z.string(),
    company_id: z.string(),
    company_name: z.string(),
    to: z.string(),
    first_name: z.string(),
    lead_ids: z.array(z.string()),
    thread_id: z.string(),
    state: z.enum(['active', 'replied', 'opted_out', 'bounced', 'stopped', 'completed']),
    steps: z.array(StepSchema),
    next_due_at: z.string().nullable(),
    stop_reason: z.string().optional(),
    replied_at: z.string().optional(),
});
export type Sequence = z.infer<typeof SequenceSchema>;

const TestSendSchema = z.object({ at: z.string(), to: z.string(), would_go_to: z.string(), lead_id: z.string(), step: z.number(), subject: z.string() });

const OutreachFileSchema = z.object({
    version: z.literal(1),
    sequences: z.record(z.string(), SequenceSchema).default({}),
    test_sends: z.array(TestSendSchema).default([]),
});

/** Private outreach log (recipients, threads). Lives in data/private (encrypted in the repository). */
export class OutreachStore {
    private constructor(
        private readonly path: string,
        private readonly file: z.infer<typeof OutreachFileSchema>,
    ) {}

    static async load(path: string): Promise<OutreachStore> {
        const raw = await readJson(path);
        return new OutreachStore(path, raw ? OutreachFileSchema.parse(raw) : { version: 1, sequences: {}, test_sends: [] });
    }

    get sequences(): Sequence[] {
        return Object.values(this.file.sequences);
    }

    sequence(id: string): Sequence | undefined {
        return this.file.sequences[id];
    }

    put(seq: Sequence): void {
        this.file.sequences[seq.id] = seq;
    }

    recordTest(entry: z.infer<typeof TestSendSchema>): void {
        this.file.test_sends.push(entry);
    }

    get testSends() {
        return this.file.test_sends;
    }

    async save(): Promise<void> {
        await writeJson(this.path, this.file);
    }
}

const SuppressionSchema = z.object({
    version: z.literal(1),
    /** sha256(email) → why. */
    emails: z.record(z.string(), z.object({ reason: z.enum(['opt_out', 'bounce', 'competitor', 'manual']), at: z.string() })).default({}),
});

/**
 * Suppression list: opt-outs, permanent bounces, competitors and manual blocks. Emails are stored as hashes (public
 * file); companies and domains the owner blocks come from data/blocklist.txt (one per line).
 */
export class Suppression {
    private constructor(
        private readonly path: string,
        private readonly file: z.infer<typeof SuppressionSchema>,
        private readonly blocked: string[],
    ) {}

    static async load(path: string, blocklistPath: string): Promise<Suppression> {
        const raw = await readJson(path);
        let blocked: string[] = [];
        try {
            blocked = (await readFile(blocklistPath, 'utf8'))
                .split(/\r?\n/)
                .map((l) => l.trim().toLowerCase())
                .filter((l) => l && !l.startsWith('#'));
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return new Suppression(path, raw ? SuppressionSchema.parse(raw) : { version: 1, emails: {} }, blocked);
    }

    add(email: string, reason: 'opt_out' | 'bounce' | 'competitor' | 'manual', now: Date): void {
        const h = emailHash(email);
        if (!this.file.emails[h]) this.file.emails[h] = { reason, at: now.toISOString() };
    }

    /** Why this address/company may not be emailed, or undefined if it may. */
    blockedReason(email: string, companyName: string): string | undefined {
        const hit = this.file.emails[emailHash(email)];
        if (hit) return `suppressed (${hit.reason.replace('_', '-')})`;
        const domain = domainOf(email);
        const company = companyName.toLowerCase();
        for (const b of this.blocked) {
            if (b.includes('@') ? emailHash(b) === emailHash(email) : b === domain || domain.endsWith(`.${b}`) || company.includes(b)) return `blocked by owner (${b.includes('@') ? 'email' : b})`;
        }
        return undefined;
    }

    counts(): Record<string, number> {
        const out: Record<string, number> = {};
        for (const e of Object.values(this.file.emails)) out[e.reason] = (out[e.reason] ?? 0) + 1;
        return out;
    }

    async save(): Promise<void> {
        await writeJson(this.path, this.file);
    }
}

/** Public, non-personal outreach state: whether a test run passed, last inbox check. */
const StateSchema = z.object({ version: z.literal(1), test_passed_at: z.string().optional(), last_inbox_sync_at: z.string().optional(), mailbox: z.string().optional() });
export type OutreachState = z.infer<typeof StateSchema>;

export async function loadOutreachState(path: string): Promise<OutreachState> {
    const raw = await readJson(path);
    return raw ? StateSchema.parse(raw) : { version: 1 };
}

export async function saveOutreachState(path: string, state: OutreachState): Promise<void> {
    await writeJson(path, state);
}
