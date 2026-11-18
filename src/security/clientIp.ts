/*
 * Client IP resolver yang tidak mudah dipalsukan.

 * Vercel mengirim x-vercel-forwarded-for (dipercaya). X-Forwarded-For biasa
 * bisa dikirim client, jadi kita ambil entry PALING KANAN (proxy terakhir),
 * bukan yang paling kiri yang bisa disuntik attacker.
 */
import { isIP } from 'net';
import { Request } from 'express';

const normalizeIp = (raw: string): string => {
    let value = raw.trim();

    if (value.startsWith('[')) {
        const end = value.indexOf(']');
        if (end > 0) value = value.slice(1, end);
    } else if (/^\d{1,3}(?:\.\d{1,3}){3}:\d+$/.test(value)) {
        value = value.split(':')[0];
    }

    value = value.split('%')[0].trim();
    if (value.startsWith('::ffff:')) value = value.slice(7);

    return isIP(value) ? value : '';
};

const pickTrusted = (value: string | string[] | undefined): string => {
    if (Array.isArray(value)) value = value[value.length - 1];
    if (typeof value !== 'string') return '';

    const parts = value
        .split(',')
        .map(normalizeIp)
        .filter(Boolean);

    return parts[parts.length - 1] || '';
};

export const getClientIp = (req: Request): string => {
    const vercel = req.headers['x-vercel-forwarded-for'];
    if (typeof vercel === 'string' && vercel.trim()) {
        const ip = normalizeIp(vercel.split(',')[0]);
        if (ip) return ip;
    }

    const forwarded = pickTrusted(req.headers['x-forwarded-for']);
    if (forwarded) return forwarded;

    const socketIp = normalizeIp(req.socket?.remoteAddress || '');
    return socketIp || 'unknown';
};
