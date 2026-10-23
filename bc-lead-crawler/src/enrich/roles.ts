import type { SegmentGroup } from '../schema.js';

export type AccountKind = 'contractor' | 'developer' | 'property_owner_manager';

export interface RoleTarget {
    category: string;
    /** Titles sent to the people search, most important first. */
    titles: string[];
}

/** Owner's priority list (2026-10-20), per kind of company. Order = contact priority. */
const ROLE_TARGETS: Record<AccountKind, RoleTarget[]> = {
    // Owner's list (2026-10-23): the people who invite and award subcontractor bids first; leadership only as a fallback.
    contractor: [
        {
            category: 'estimating_preconstruction',
            titles: ['Chief Estimator', 'Senior Estimator', 'Estimator', 'Director of Preconstruction', 'Preconstruction Manager', 'Preconstruction'],
        },
        {
            category: 'procurement',
            titles: ['Subcontractor Manager', 'Subcontractor Coordinator', 'Vendor Manager', 'Procurement Manager', 'Purchasing Manager', 'Buyout Manager', 'Purchasing'],
        },
        { category: 'project_leadership', titles: ['Project Executive', 'Senior Project Manager', 'Project Manager'] },
        { category: 'construction_management', titles: ['Construction Manager', 'General Superintendent', 'Superintendent'] },
        { category: 'business_development', titles: ['Director of Business Development', 'Business Development Manager'] },
        { category: 'leadership', titles: ['Director of Operations', 'Operations Manager', 'President', 'Owner'] },
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
