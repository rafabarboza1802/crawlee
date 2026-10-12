import { describe, expect, test } from 'vitest';

import { parseSeedsCsv } from '../src/seeds.js';

describe('parseSeedsCsv', () => {
    test('parses quoted fields, comments, defaults and bare domains', () => {
        const seeds = parseSeedsCsv(
            [
                '# comment line',
                'website,company_name,segment_hint,source,notes',
                'acme-pm.example,"Acme, Property Management",hoa_management,apollo,"says ""HOA"" on site"',
                'https://builder.example,,,,',
                '',
            ].join('\n'),
        );
        expect(seeds).toEqual([
            {
                website: 'https://acme-pm.example',
                company_name: 'Acme, Property Management',
                segment_hint: 'hoa_management',
                source: 'apollo',
                notes: 'says "HOA" on site',
            },
            { website: 'https://builder.example', segment_hint: 'unknown', source: 'manual' },
        ]);
    });

    test('rejects unknown segments with the row number', () => {
        expect(() => parseSeedsCsv('website,segment_hint\nacme.example,plumbers\n')).toThrow(/row 2/);
    });
});

describe('parseSeedsCsv website validation', () => {
    test('rejects non-http(s) websites instead of producing a garbage URL', () => {
        expect(() => parseSeedsCsv('website\nftp://acme.example\n')).toThrow(/row 2/);
    });

    test('names the offending website so it can be found even when the file has comment lines', () => {
        expect(() => parseSeedsCsv('# note\n# note\nwebsite\ngood.example\nmailto:x@y.example\n')).toThrow(/"mailto:x@y\.example"/);
    });
});
