import type { SegmentGroup } from '../schema.js';

export type AccountKind = 'contractor' | 'developer' | 'property_owner_manager';

export interface RoleTarget {
    category: string;
    /** Titles sent to the people search, most important first. */
    titles: string[];
}

/** Owner's priority list (2026-10-20), per kind of company. Order = contact priority. */
const ROLE_TARGETS: Record<AccountKind, RoleTarget[]> = {
    contractor: [
        { category: 'estimating_preconstruction', titles: ['Chief Estimator', 'Estimator', 'Preconstruction Manager', 'Director of Preconstruction'] },
        { category: 'project_management', titles: ['Project Manager', 'Senior Project Manager'] },
        { category: 'construction_management', titles: ['Construction Manager'] },
        { category: 'field', titles: ['Superintendent', 'General Superintendent'] },
        { category: 'purchasing', titles: ['Purchasing Manager', 'Procurement Manager'] },
        { category: 'leadership', titles: ['Owner', 'President', 'Operations Manager', 'Director of Operations'] },
    ],
    developer: [
        { category: 'construction_leadership', titles: ['Director of Construction', 'VP of Construction', 'Construction Manager'] },
        { category: 'development', titles: ['Development Manager', 'Director of Development'] },
        { category: 'project_management', titles: ['Project Manager'] },
        { category: 'purchasing', titles: ['Purchasing Manager', 'Procurement Manager'] },
        { category: 'leadership', titles: ['Owner', 'President', 'Principal'] },
    ],
    property_owner_manager: [
        { category: 'property_management', titles: ['Property Manager', 'Regional Property Manager', 'Community Manager', 'HOA Manager'] },
        { category: 'facilities', titles: ['Director of Facilities', 'Facilities Manager'] },
        { category: 'construction_management', titles: ['Construction Manager', 'Project Manager'] },
        { category: 'asset_management', titles: ['Asset Manager'] },
        { category: 'purchasing', titles: ['Purchasing Manager', 'Procurement Manager'] },
    ],
};

export function accountKindFor(role: 'contractor' | 'owner_business', segment: SegmentGroup): AccountKind {
    if (role === 'contractor') return 'contractor';
    return segment === 'property_management' || segment === 'commercial_real_estate' ? 'property_owner_manager' : 'developer';
}

export function roleTargets(kind: AccountKind): RoleTarget[] {
    return ROLE_TARGETS[kind];
}

export function targetTitles(kind: AccountKind): string[] {
    return ROLE_TARGETS[kind].flatMap((r) => r.titles);
}
