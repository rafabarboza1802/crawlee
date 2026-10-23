import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from 'node:crypto';
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { gunzipSync, gzipSync } from 'node:zlib';

/**
 * Encrypted copy of data/private (purchased contacts, Apollo responses, outreach log) so it can live in a public
 * repository and survive between weekly runs. AES-256-GCM, key derived (scrypt) from LEAD_DATA_KEY, a GitHub Secret.
 * Without the key the file is unreadable; a wrong key or a tampered file fails loudly.
 */
const FORMAT = 'bc-vault-1';
/** Files worth keeping; large regenerable files (last-opportunities, estimates, reports) are left out. */
const VAULT_FILES = ['contacts.json', 'apollo-cache.json', 'outreach.json'];

export class VaultKeyError extends Error {}

const keyFrom = (secret: string, salt: Buffer) => scryptSync(secret, salt, 32);

export function seal(files: Record<string, string>, secret: string): string {
    const salt = randomBytes(16);
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', keyFrom(secret, salt), iv);
    const data = Buffer.concat([cipher.update(gzipSync(JSON.stringify(files))), cipher.final()]);
    return JSON.stringify({ format: FORMAT, salt: salt.toString('base64'), iv: iv.toString('base64'), tag: cipher.getAuthTag().toString('base64'), data: data.toString('base64') }) + '\n';
}

export function open(sealed: string, secret: string): Record<string, string> {
    const v = JSON.parse(sealed) as { format: string; salt: string; iv: string; tag: string; data: string };
    if (v.format !== FORMAT) throw new VaultKeyError(`Unknown vault format ${v.format}`);
    try {
        const decipher = createDecipheriv('aes-256-gcm', keyFrom(secret, Buffer.from(v.salt, 'base64')), Buffer.from(v.iv, 'base64'));
        decipher.setAuthTag(Buffer.from(v.tag, 'base64'));
        return JSON.parse(gunzipSync(Buffer.concat([decipher.update(Buffer.from(v.data, 'base64')), decipher.final()])).toString('utf8')) as Record<string, string>;
    } catch {
        throw new VaultKeyError('The private data vault could not be opened: LEAD_DATA_KEY is wrong or the file was changed.');
    }
}

async function exists(path: string) {
    return readFile(path).then(
        () => true,
        () => false,
    );
}

/** Restores data/private from the vault. Returns false if there is no vault yet (first run). */
export async function unlockVault(vaultPath: string, privateDir: string, secret: string | undefined): Promise<boolean> {
    if (!(await exists(vaultPath))) return false;
    if (!secret) throw new VaultKeyError('LEAD_DATA_KEY is not set, so the private contact data cannot be opened.');
    const files = open(await readFile(vaultPath, 'utf8'), secret);
    await mkdir(privateDir, { recursive: true });
    for (const [name, content] of Object.entries(files)) {
        if (VAULT_FILES.includes(name)) await writeFile(join(privateDir, name), content);
    }
    return true;
}

/** Encrypts the current data/private files into the vault. */
export async function lockVault(vaultPath: string, privateDir: string, secret: string): Promise<number> {
    const present = await readdir(privateDir).catch(() => [] as string[]);
    const files: Record<string, string> = {};
    for (const name of VAULT_FILES.filter((f) => present.includes(f))) files[name] = await readFile(join(privateDir, name), 'utf8');
    await writeFile(vaultPath, seal(files, secret));
    return Object.keys(files).length;
}
