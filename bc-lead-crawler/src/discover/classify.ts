import type { SegmentGroup } from '../schema.js';
import type { Business, NormalizedPermit, Opportunity, Service } from './types.js';

const PUBLIC_AGENCY_RE = /\b(?:city and county|county of|city of|state of|unified school|school district|university|community college|transit|public utilities|puc|housing authority|port of|caltrans|water district|sanitary district|parks? district)\b/i;
const COMMERCIAL_USE_RE = /\b(?:office|retail|commercial|warehouse|industrial|store|restaurant|food|hotel|motel|parking|medical|clinic|lab(?:oratory)?|manufactur|bank|church|school|theater|gym|auto)\w*/i;
const MULTIFAMILY_USE_RE = /\b(?:apartments?|residential hotel|condo\w*|multi-?family|tourist hotel|sro)\b/i;
const SMALL_RESIDENTIAL_USE_RE = /\b(?:1 family|2 family|one family|two family|single[\s-]family|duplex|dwelling)\b/i;

export interface Classification {
    segment: SegmentGroup;
    reason: string;
    contactPolicy: Opportunity['contact_policy'];
}

/**
 * Assigns the lead segment (who Best Construction would sell to) and the contact policy.
 * Individual homeowners are never a contact target: their projects are approached through the named contractor,
 * or not at all.
 */
export function classify(permit: NormalizedPermit, services: Service[], businesses: Business[]): Classification {
    const has = (s: Service) => services.includes(s);
    const contractor = businesses.find((b) => b.role === 'contractor');
    const ownerBusiness = businesses.find((b) => b.role === 'owner_business');
    const uses = `${permit.existingUse ?? ''} ${permit.proposedUse ?? ''}`;
    const newUnits = (permit.proposedUnits ?? 0) - (permit.existingUnits ?? 0);
    const isNewBuild = has('general_construction') && /new construction/i.test(permit.permitType ?? '');
    const smallResidential = SMALL_RESIDENTIAL_USE_RE.test(uses) && !MULTIFAMILY_USE_RE.test(uses) && (permit.proposedUnits ?? permit.existingUnits ?? 1) <= 2;
    const businessPolicy: Classification['contactPolicy'] = businesses.length ? 'approach_named_businesses' : 'research_contractor_first';

    if (ownerBusiness && PUBLIC_AGENCY_RE.test(ownerBusiness.name)) {
        return { segment: 'public_construction', reason: `Owner is a public agency (${ownerBusiness.name}); work is typically publicly bid.`, contactPolicy: businessPolicy };
    }
    if ((isNewBuild || (has('demolition') && has('general_construction'))) && (newUnits >= 2 || (permit.proposedUnits ?? 0) >= 3)) {
        return { segment: 'developer_home_builder', reason: `New construction adding ${Math.max(newUnits, permit.proposedUnits ?? 0)} units.`, contactPolicy: businessPolicy };
    }
    if (isNewBuild && ownerBusiness) {
        return { segment: 'developer_home_builder', reason: `New construction by ${ownerBusiness.name}.`, contactPolicy: businessPolicy };
    }
    if (COMMERCIAL_USE_RE.test(uses) && !MULTIFAMILY_USE_RE.test(uses) && !smallResidential) {
        return { segment: 'commercial_real_estate', reason: `Commercial property (${uses.trim()}).`, contactPolicy: businessPolicy };
    }
    if (MULTIFAMILY_USE_RE.test(uses) || (permit.existingUnits ?? 0) >= 3) {
        return {
            segment: 'property_management',
            reason: `Multifamily property (${permit.existingUnits ?? '?'} units${permit.softStoryRetrofit ? ', soft-story retrofit' : ''}); usually run by a property manager or HOA.`,
            contactPolicy: businessPolicy,
        };
    }
    if (smallResidential || has('adu')) {
        if (contractor) {
            return {
                segment: 'general_contractor',
                reason: `Homeowner project; approach its contractor (${contractor.name}) for sub work, never the homeowner.`,
                contactPolicy: 'approach_named_businesses',
            };
        }
        return {
            segment: 'residential',
            reason: 'Homeowner project with no business contact published: market signal only, no direct contact.',
            contactPolicy: 'no_direct_contact',
        };
    }
    if (contractor) {
        return { segment: 'general_contractor', reason: `Named contractor (${contractor.name}) may sub out site work.`, contactPolicy: 'approach_named_businesses' };
    }
    return { segment: 'unclassified', reason: 'Property type not published; review manually.', contactPolicy: businessPolicy };
}
