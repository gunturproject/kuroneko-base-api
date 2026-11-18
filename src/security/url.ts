/*
 * Validasi URL publik untuk mencegah SSRF dan skema URL berbahaya.
 * Dipakai guard global dan handler yang menerima parameter url.
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

    const [a, b, c, d] = parts;
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true;
    if (a === 192 && (b === 0 || b === 88 && c === 99)) return true;
    if (a === 198 && (b === 18 || b === 19)) return true;
    if (a >= 224) return true; // multicast + reserved + broadcast

    return false;
};

const parseHexGroups = (value: string): number[] | null => {
    const parts = value.split(':').filter(Boolean);
    if (!parts.length || parts.length > 8) return null;

    const groups: number[] = [];
    for (const part of parts) {
        if (!/^[0-9a-f]{1,4}$/.test(part)) return null;
        groups.push(parseInt(part, 16));
    }
    return groups;
};

const privateFromHexPair = (groups: number[]): boolean => {
    if (groups.length < 2) return false;
    const hi = groups[groups.length - 2];
    const lo = groups[groups.length - 1];
    const ipv4 = `${(hi >> 8) & 255}.${hi & 255}.${(lo >> 8) & 255}.${lo & 255}`;
    return isPrivateIpv4(ipv4);
};

const isPrivateIpv6 = (raw: string): boolean => {
    const value = raw.toLowerCase().replace(/^\[|\]$/g, '').split('%')[0];
    if (!value) return false;
    if (value === '::' || value === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/.test(value)) return true;
    if (/^fe[89ab][0-9a-f]:/.test(value)) return true;

    // IPv4-mapped: ::ffff:127.0.0.1 / ::ffff:7f00:1
    const mapped = value.match(/^::ffff:(.+)$/);
    if (mapped) {
        if (mapped[1].includes('.')) return isPrivateIpv4(mapped[1]);
        const groups = parseHexGroups(mapped[1]);
        return groups ? privateFromHexPair(groups) : false;
    }

    // NAT64 well-known prefix maps the last 32 bits to an IPv4 address.
    if (value.startsWith('64:ff9b:')) {
        const groups = parseHexGroups(value);
        return groups ? privateFromHexPair(groups) : false;
    }

    // IPv4-compatible form: ::127.0.0.1 / ::7f00:1
    const groups = parseHexGroups(value);
    if (groups && groups.length <= 3 && groups.slice(0, -2).every((g) => g === 0)) {
        return privateFromHexPair(groups);
    }

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
    if (/[\u0000-\u001f\u007f]/.test(value)) return null;
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
