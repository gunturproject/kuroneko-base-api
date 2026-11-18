/*
 * Hardening middleware: security headers + input exploit filter.
 *
 * Tidak mengubah field UI, ID, state class, atau data-* apa pun.
 * Hanya menolak request yang mengandung pola eksploitasi jelas.
 */
import { Request, Response, NextFunction } from 'express';
import { isSafePublicUrl } from '../security/url';

type Pattern = { name: string; re: RegExp };

const ATTACK_PATTERNS: Pattern[] = [
    { name: 'sqli_tautology', re: /(['"]?\s*(?:or|and)\s+['"]?\d+['"]?\s*=\s*['"]?\d+['"]?)/i },
    { name: 'sqli_union', re: /\bunion\b\s+(?:all\s+)?\bselect\b/i },
    { name: 'sqli_timebased', re: /\b(?:sleep|benchmark|pg_sleep)\s*\(/i },
    { name: 'sqli_waitfor', re: /\bwaitfor\s+delay\b/i },
    { name: 'sqli_destructive', re: /;\s*(?:drop|delete|truncate|alter)\s+(?:table|database)?/i },
    { name: 'sqli_comment', re: /(?:--|\/\*)[\s\S]{0,40}\b(?:or|and)\b/i },
    { name: 'xss_script', re: /<\s*script\b/i },
    { name: 'xss_js_scheme', re: /javascript\s*:/i },
    { name: 'xss_event', re: /\bon(?:error|load|click|focus|mouseover|mouseenter)\s*=/i },
    { name: 'xss_element', re: /<\s*(?:iframe|object|embed|svg|img)\b[^>]*(?:\bon\w+\s*=|javascript\s*:)/i },
    { name: 'xss_cookie', re: /document\s*\.\s*cookie/i },
    { name: 'path_traversal', re: /(?:\.\.[\\/]|%2e%2e(?:%2f|%5c|%2f))/i },
    { name: 'sensitive_file', re: /(?:\/etc\/passwd|\\windows\\win\.ini|\bwin\.ini\b|\bboot\.ini\b)/i },
    { name: 'rce_shell', re: /\$\(|`[^`]+`|\|\s*sh\b|;\s*(?:cat|wget|curl|nc|python|bash|sh)\b/i },
    { name: 'nosql_operator', re: /\$(?:where|ne|gt|gte|lt|lte|regex|expr)\b/i },
    { name: 'prototype_pollution', re: /__proto__|constructor\s*\[\s*['"]prototype|\bprototype\s*\[/i },
    { name: 'log4shell', re: /\$\{jndi:/i },
    { name: 'template_injection', re: /(?:<%=|<%#|\{\{[^}]{0,120}(?:\$\{|process\.env|constructor)[^}]{0,120}\}\})/i },
    { name: 'null_byte', re: /\u0000/ }
];

const FREE_FORM_KEYS = new Set([
    'script',
    'q',
    'query',
    'text',
    'caption',
    'message',
    'prompt',
    'response'
]);

const URL_KEYS = new Set(['url', 'link', 'target', 'scripturl', 'imageurl']);

const MAX_STRING_LENGTH = 20000;
const MAX_DEPTH = 6;
const MAX_KEYS = 200;

const safeDecode = (value: string): string => {
    try {
        return decodeURIComponent(value);
    } catch {
        return value;
    }
};

const isPlainObject = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value);

const reject = (res: Response, name: string, field: string) => {
    res.setHeader('Cache-Control', 'no-store');
    return res.status(400).json({
        status: false,
        message: 'Request ditolak oleh filter keamanan.',
        detail: { reason: name, field }
    });
};

const checkString = (
    value: string,
    field: string,
    skipPatterns: boolean
): string | null => {
    if (value.length > MAX_STRING_LENGTH && !skipPatterns) return 'payload_too_long';

    if (URL_KEYS.has(field.toLowerCase()) && value && !isSafePublicUrl(value)) {
        return 'unsafe_url';
    }

    if (skipPatterns) return null;

    const haystacks = [value, safeDecode(value)];
    for (const haystack of haystacks) {
        for (const pattern of ATTACK_PATTERNS) {
            if (pattern.re.test(haystack)) return pattern.name;
        }
    }

    return null;
};

const inspect = (
    value: unknown,
    field: string,
    depth: number,
    counter: { count: number }
): string | null => {
    if (depth > MAX_DEPTH) return 'payload_too_deep';
    counter.count += 1;
    if (counter.count > MAX_KEYS) return 'payload_too_complex';

    if (typeof value === 'string') {
        const skip = FREE_FORM_KEYS.has(field.toLowerCase());
        return checkString(value, field, skip);
    }

    if (Array.isArray(value)) {
        for (const item of value) {
            const hit = inspect(item, field, depth + 1, counter);
            if (hit) return hit;
        }
        return null;
    }

    if (isPlainObject(value)) {
        for (const [key, child] of Object.entries(value)) {
            const hit = inspect(child, key, depth + 1, counter);
            if (hit) return hit;
        }
    }

    return null;
};

export const securityHeaders = (req: Request, res: Response, next: NextFunction) => {
    res.removeHeader('X-Powered-By');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    res.setHeader(
        'Permissions-Policy',
        'camera=(), microphone=(), geolocation=(), payment=(), usb=()'
    );
    res.setHeader('Cross-Origin-Opener-Policy', 'same-origin');
    res.setHeader('Cross-Origin-Resource-Policy', 'cross-origin');

    if (req.secure || req.headers['x-forwarded-proto'] === 'https') {
        res.setHeader(
            'Strict-Transport-Security',
            'max-age=63072000; includeSubDomains; preload'
        );
    }

    if (req.path.startsWith('/api/')) {
        res.setHeader(
            'Content-Security-Policy',
            "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'none'"
        );
    }

    next();
};

export const inputGuard = (req: Request, res: Response, next: NextFunction) => {
    const decodedUrl = safeDecode(req.originalUrl || '');
    const urlHit = checkString(decodedUrl, 'original_url', false);
    if (urlHit) return reject(res, urlHit, 'original_url');

    const counter = { count: 0 };
    const sources: Array<[string, unknown]> = [
        ['query', req.query],
        ['params', req.params],
        ['body', req.body]
    ];

    for (const [field, source] of sources) {
        const hit = inspect(source, field, 0, counter);
        if (hit) return reject(res, hit, field);
    }

    next();
};
