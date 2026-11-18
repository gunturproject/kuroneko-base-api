/*
 * Validasi URL publik untuk mencegah SSRF dan skema URL berbahaya.
 * Dipakai guard global dan bisa dipakai handler yang menerima parameter url.
 */

const PRIVATE_HOSTNAMES = new Set([
    'localhost',
    'localhost.localdomain',
    'metadata',
    'metadata.google.internal',
    'instance-data',
    'kubernetes.default',
    'redis',
    'mysql',
    'postgres',
    'mongodb'
]);

const isPrivateIpv4 = (host: string): boolean => {
    const parts = host.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) {
        return false;
    }

    const [a, b] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && b === 0) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;

    return false;
};

const isPrivateIpv6 = (host: string): boolean => {
    const value = host.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
    if (value === '::' || value === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(value)) return true;

    const ipv4Mapped = value.match(/::ffff:(\d+\.\d+\.\d+\.\d+)$/i);
    if (ipv4Mapped) return isPrivateIpv4(ipv4Mapped[1]);

    return false;
};

export const isPrivateHost = (hostname: string): boolean => {
    const host = hostname.toLowerCase().replace(/\.$/, '').replace(/^\[|\]$/g, '');

    if (PRIVATE_HOSTNAMES.has(host) || host.endsWith('.localhost')) return true;
    if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return isPrivateIpv4(host);
    if (host.includes(':')) return isPrivateIpv6(host);

    return false;
};

export const parsePublicHttpUrl = (raw: string): URL | null => {
    let value = raw.trim();
    if (!value) return null;
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        return null;
    }

    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    if (parsed.username || parsed.password) return null;
    if (!parsed.hostname || isPrivateHost(parsed.hostname)) return null;

    return parsed;
};

export const isSafePublicUrl = (raw: string): boolean => parsePublicHttpUrl(raw) !== null;
