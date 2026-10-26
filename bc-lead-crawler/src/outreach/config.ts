import { readFile } from 'node:fs/promises';

import { z } from 'zod';

/**
 * Email outreach settings (`outreach.config.json`, committed: nothing secret here). Addresses and credentials come
 * from environment variables / GitHub Secrets only.
 *
 * Modes:
 * - off:  nothing is sent.
 * - test: every message goes to OUTREACH_TEST_TO (a company-controlled address), never to a prospect.
 * - live: real outreach. Refused unless `liveAuthorization` is filled in by the owner and a test run has passed.
 */
export const OutreachConfigSchema = z.object({
    mode: z.enum(['off', 'test', 'live']).default('off'),
    /** The owner's explicit authorization for live sending (name and date). Required for live mode. */
    liveAuthorization: z.object({ by: z.string().min(2), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).nullable().default(null),
    sender: z
        .object({
            name: z.string().default(''),
            title: z.string().default(''),
            company: z.string().default('Best Construction Inc.'),
            website: z.string().default('https://bestconstruction.pro'),
            phone: z.string().default(''),
            /** CSLB contractor license number, shown in the signature (California requires it in contractor advertising). */
            licenseNumber: z.string().default(''),
            /** Physical mailing address: required by CAN-SPAM in every commercial email. */
            postalAddress: z.string().default(''),
        })
        .default({ name: '', title: '', company: 'Best Construction Inc.', website: 'https://bestconstruction.pro', phone: '', licenseNumber: '', postalAddress: '' }),
    limits: z
        .object({
            /** New prospects started per weekly run (start small; raise slowly). */
            maxNewPerRun: z.number().int().min(0).default(10),
            /** All emails (new + follow-ups) per run. */
            maxEmailsPerRun: z.number().int().min(0).default(25),
            /** At most this many emails to the same company domain per run. */
            maxPerDomainPerRun: z.number().int().min(1).default(1),
            /** Pause between two sends. */
            delaySeconds: z.number().min(0).default(30),
            /** Test mode sends at most this many messages per run. */
            maxTestPerRun: z.number().int().min(1).default(3),
        })
        .default({ maxNewPerRun: 10, maxEmailsPerRun: 25, maxPerDomainPerRun: 1, delaySeconds: 30, maxTestPerRun: 3 }),
    sequence: z
        .object({
            /** Days after the first email for each follow-up (default: day 4 and day 10). */
            followUpDays: z.array(z.number().int().positive()).default([4, 10]),
            /** Total emails per lead, including the first. */
            maxEmails: z.number().int().min(1).max(5).default(3),
            /** Days before the same person can be approached about a different project. */
            contactCooldownDays: z.number().int().min(0).default(60),
        })
        .default({ followUpDays: [4, 10], maxEmails: 3, contactCooldownDays: 60 }),
    /** Email the weekly owner report (with contact details) to OWNER_REPORT_TO. */
    ownerReportEmail: z.boolean().default(true),
});
export type OutreachConfig = z.infer<typeof OutreachConfigSchema>;

export async function loadOutreachConfig(path: string): Promise<OutreachConfig> {
    try {
        return OutreachConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return OutreachConfigSchema.parse({});
        throw error;
    }
}

export interface OutreachEnv {
    /** The Best Construction mailbox that sends (must be the authorized Gmail/Workspace account). */
    from?: string;
    /** Company-controlled address that receives every message in test mode. */
    testTo?: string;
    ownerReportTo?: string;
    /** Repository variable OUTREACH_MODE / manual run input: "off" pauses sending without editing files. */
    modeOverride?: string;
}

export function outreachEnv(env: NodeJS.ProcessEnv = process.env): OutreachEnv {
    const v = (k: string) => env[k]?.trim() || undefined;
    return { from: v('OUTREACH_FROM'), testTo: v('OUTREACH_TEST_TO'), ownerReportTo: v('OWNER_REPORT_TO'), modeOverride: v('OUTREACH_MODE') };
}

/**
 * The mode this run actually uses. An override can only make sending safer (pause, or test instead of live) — it can
 * never switch a run to live.
 */
export function effectiveMode(config: OutreachConfig, env: OutreachEnv): OutreachConfig['mode'] {
    const override = env.modeOverride?.toLowerCase();
    if (override === 'off' || override === 'pause' || override === 'paused') return 'off';
    if (override === 'test' && config.mode !== 'off') return 'test';
    return config.mode;
}

/** Problems that block sending in this mode (empty = ready). */
export function readinessProblems(config: OutreachConfig, env: OutreachEnv, mode: OutreachConfig['mode'], testPassedAt: string | undefined): string[] {
    const problems: string[] = [];
    if (mode === 'off') return problems;
    if (!env.from) problems.push('OUTREACH_FROM (the sending mailbox) is not set.');
    if (mode === 'test' && !env.testTo) problems.push('OUTREACH_TEST_TO (company-controlled test address) is not set.');
    if (mode === 'live') {
        if (!config.liveAuthorization) problems.push('Live sending is not authorized: fill in "liveAuthorization" in outreach.config.json.');
        if (!testPassedAt) problems.push('No successful test run yet: run in test mode first.');
        if (!config.sender.name) problems.push('sender.name is empty in outreach.config.json.');
        if (!config.sender.postalAddress) problems.push('sender.postalAddress is empty (a physical mailing address is legally required).');
        if (!config.sender.licenseNumber) problems.push('sender.licenseNumber is empty (California requires the CSLB license number in contractor advertising).');
    }
    return problems;
}
