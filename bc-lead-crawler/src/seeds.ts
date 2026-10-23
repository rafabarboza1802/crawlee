import { readFile } from 'node:fs/promises';

import type { Seed } from './schema.js';
import { SeedSchema } from './schema.js';

/**
 * Parses the seed CSV. Header row required; supported columns:
 * website (required), company_name, segment_hint, source, notes.
 * Lines starting with "#" are comments.
 */
export function parseSeedsCsv(csv: string): Seed[] {
    const rows = parseCsv(csv.split(/\r?\n/).filter((line) => !line.trimStart().startsWith('#')).join('\n'));
    const [header, ...data] = rows;
    if (!header) return [];
    const columns = header.map((h) => h.trim().toLowerCase());
    if (!columns.includes('website')) throw new Error('Seed CSV must have a "website" column.');

    return data
        .filter((row) => row.some((cell) => cell.trim()))
        .map((row, i) => {
            const raw: Record<string, string> = {};
            columns.forEach((col, j) => {
                const value = row[j]?.trim();
                if (value) raw[col] = value;
            });
            // Bare domains get https://; anything with another scheme is left as-is so validation rejects it.
            if (raw.website && !/^[a-z][a-z0-9+.-]*:/i.test(raw.website)) raw.website = `https://${raw.website}`;
            const parsed = SeedSchema.safeParse(raw);
            if (!parsed.success) {
                const issues = parsed.error.issues.map((x) => `${x.path.join('.')}: ${x.message}`).join('; ');
                // Row numbers exclude "#" comment lines, so also name the website to make the row easy to find.
                throw new Error(`Seed row ${i + 2} ("${raw.website ?? ''}") is invalid: ${issues}`);
            }
            return parsed.data;
        });
}

export async function loadSeeds(path: string): Promise<Seed[]> {
    return parseSeedsCsv(await readFile(path, 'utf8'));
}

/** Minimal RFC 4180 CSV parser (quoted fields, escaped quotes, newlines inside quotes). */
function parseCsv(input: string): string[][] {
    const rows: string[][] = [];
    let row: string[] = [];
    let field = '';
    let quoted = false;
    for (let i = 0; i < input.length; i++) {
        const c = input[i]!;
        if (quoted) {
            if (c === '"' && input[i + 1] === '"') {
                field += '"';
                i++;
            } else if (c === '"') {
                quoted = false;
            } else {
                field += c;
            }
        } else if (c === '"') {
            quoted = true;
        } else if (c === ',') {
            row.push(field);
            field = '';
        } else if (c === '\n') {
            row.push(field);
            rows.push(row);
            row = [];
            field = '';
        } else if (c !== '\r') {
            field += c;
        }
    }
    if (field || row.length) {
        row.push(field);
        rows.push(row);
    }
    return rows;
}
