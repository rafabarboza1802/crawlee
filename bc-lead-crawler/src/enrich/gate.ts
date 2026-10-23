import type { Account } from './accounts.js';
import { accountIdFor, searchNameFor } from './accounts.js';
import type { BuyerDecision, BuyerRegistry } from './buyers.js';
import { classifyFromHistory, classifyFromRegistry } from './buyers.js';
import type { PermitHistory } from './research.js';
import type { FileCache } from './store.js';

export interface GateResult {
    buyers: Account[];
    blocked: Account[];
    review: Account[];
}

export type HistoryLookup = (license: string) => Promise<PermitHistory>;

/**
 * Classifies every company before enrichment. Buyers continue (renamed to the canonical company, or to a joint
 * venture's managing GC); competitors are blocked; everything else stops for manual review. Never uses Apollo.
 */
export async function applyBuyerGate(
    accounts: Account[],
    registry: BuyerRegistry,
    lookupHistory: HistoryLookup,
    cache: FileCache,
    now: Date,
): Promise<GateResult> {
    const buyers = new Map<string, Account>();
    const blocked: Account[] = [];
    const review: Account[] = [];

    for (const account of accounts) {
        let decision: BuyerDecision | undefined = classifyFromRegistry(registry, account.displayName, account.license);
        if (!decision) {
            if (!account.license) {
                decision = { classification: 'uncertain', reason: 'Unknown company with no licence number to research: manual review.', evidence: [], source: 'permit_research' };
            } else {
                const key = `research:sf-permits:${account.license}`;
                let history = cache.get<PermitHistory>(key);
                if (!history) {
                    try {
                        history = await lookupHistory(account.license);
                        await cache.set(key, history, now);
                    } catch {
                        history = undefined;
                    }
                }
                decision = classifyFromHistory(account.displayName, history);
            }
        }

        if (decision.classification !== 'buyer') {
            (decision.classification === 'competitor' ? blocked : review).push({ ...account, buyer: decision });
            continue;
        }

        // Buyer: enrich the canonical company (for a JV, the managing GC), merging permits that resolve to it.
        const name = decision.resolvedName ?? account.displayName;
        const accountId = accountIdFor(name);
        const existing = buyers.get(accountId);
        if (existing) {
            existing.opportunities.push(...account.opportunities);
            existing.bestScore = Math.max(existing.bestScore, account.bestScore);
            continue;
        }
        buyers.set(accountId, {
            ...account,
            accountId,
            displayName: decision.jointVenture ? `${name} (managing GC of ${decision.jointVenture})` : name,
            searchName: searchNameFor(name),
            // A JV's licence belongs to the JV, not to the managing GC.
            license: decision.jointVenture ? undefined : account.license,
            buyer: decision,
        });
    }
    return { buyers: [...buyers.values()], blocked, review };
}
