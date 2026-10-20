import { readFile } from 'node:fs/promises';

import { z } from 'zod';

/**
 * Budget and provider settings for Phase 3. Credit costs are assumptions to verify against your Apollo plan
 * (see docs/phase3-decision-makers.md §12); they are configuration, never hard-coded truths.
 */
export const EnrichConfigSchema = z.object({
    /** Opportunities below this Phase 2 score are never sent to a paid provider. */
    minOpportunityScore: z.number().min(0).max(100).default(70),
    /** Hard monthly budget in USD. */
    monthlyBudgetUsd: z.number().positive().default(50),
    /** Your effective cost per Apollo credit. Unknown until you set it; the dry run then reports credits only. */
    usdPerCredit: z.number().positive().nullable().default(null),
    /** Conservative credit cap used while usdPerCredit is unknown (20% of a 2,500-credit cycle). */
    monthlyCreditCap: z.number().int().positive().default(500),
    maxAccountsPerRun: z.number().int().positive().default(25),
    /** People shortlisted per company from the (free) people search. */
    maxCandidatesPerAccount: z.number().int().min(1).max(10).default(3),
    /** People whose verified business email is paid for, per company. Default: the primary contact only. */
    maxEnrichedPerAccount: z.number().int().min(0).max(3).default(1),
    /** Direct-dial phone reveals cost extra; off. Business phone comes from the organization record. */
    revealPhones: z.literal(false).default(false),
    cacheTtlDays: z.number().int().positive().default(90),
    /** Minimum name similarity (0–1) to accept an Apollo organization match; below it, no further spend. */
    minOrgMatch: z.number().min(0).max(1).default(0.85),
    apolloCredits: z
        .object({
            organizationSearch: z.number().min(0).default(1),
            peopleSearch: z.number().min(0).default(0),
            peopleMatch: z.number().min(0).default(1),
        })
        .default({ organizationSearch: 1, peopleSearch: 0, peopleMatch: 1 }),
});
export type EnrichConfig = z.infer<typeof EnrichConfigSchema>;

export async function loadEnrichConfig(path: string): Promise<EnrichConfig> {
    try {
        return EnrichConfigSchema.parse(JSON.parse(await readFile(path, 'utf8')));
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return EnrichConfigSchema.parse({});
        throw error;
    }
}
