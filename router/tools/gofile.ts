import { Request, Response } from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { parsePublicHttpUrl } from '../../src/security/url';

const GOFILE_HOSTS = new Set(['gofile.io', 'www.gofile.io']);
const CONTENT_ID_RE = /^[A-Za-z0-9_-]{6,64}$/;
const CRAWLER_UA = 'Mozilla/5.0 (compatible; Googlebot/2.1; +http://www.google.com/bot.html)';
const MAX_HTML_BYTES = 6 * 1024 * 1024;
const SIZE_UNITS: Record<string, number> = {
    B: 1,
    KB: 1024,
    MB: 1024 ** 2,
    GB: 1024 ** 3,
    TB: 1024 ** 4
};

type JsonRecord = Record<string, unknown>;

const cleanText = (value: string) => value.replace(/\s+/g, ' ').trim();

const stripGofileSuffix = (value: string) =>
    cleanText(value).replace(/\s*·\s*Gofile\s*$/i, '');

const readMeta = ($: cheerio.CheerioAPI, selector: string) =>
    cleanText($(selector).first().attr('content') || '');

const parseSize = (raw?: string | null): number | null => {
    if (!raw) return null;
    const match = /^([\d.,]+)\s*(B|KB|MB|GB|TB)$/i.exec(cleanText(raw));
    if (!match) return null;
    const amount = Number(match[1].replace(/,/g, ''));
    const factor = SIZE_UNITS[match[2].toUpperCase()];
    if (!Number.isFinite(amount) || !factor) return null;
    return Math.round(amount * factor);
};

const sizeFromText = (raw: string): string | null => {
    const match = /([\d.,]+\s*(?:B|KB|MB|GB|TB))\b/i.exec(raw);
    return match ? cleanText(match[1]) : null;
};

const dateFromText = (raw: string): string | null => {
    const match = /[A-Z][a-z]{2}\s+\d{1,2},\s*\d{4},?\s*\d{1,2}:\d{2}\s*(?:AM|PM)/i.exec(raw);
    return match ? cleanText(match[0]) : null;
};

export default async function gofileHandler(req: Request, res: Response) {
    const rawUrl = String(req.query.url ?? req.body?.url ?? '').trim();
    const rawCode = String(req.query.code ?? req.body?.code ?? '').trim();

    let code = '';
    if (rawUrl) {
        const parsed = parsePublicHttpUrl(rawUrl);
        if (!parsed || parsed.protocol !== 'https:' || !GOFILE_HOSTS.has(parsed.hostname)) {
            return res.status(400).json({
                status: false,
                message: 'URL harus HTTPS dan masih berada di domain gofile.io.'
            });
        }
        const match = /^\/d\/([A-Za-z0-9_-]{6,64})\/?$/.exec(parsed.pathname);
        if (!match) {
            return res.status(400).json({
                status: false,
                message: 'URL Gofile tidak valid. Format: https://gofile.io/d/KODE'
            });
        }
        code = match[1];
    } else if (rawCode) {
        if (!CONTENT_ID_RE.test(rawCode)) {
            return res.status(400).json({
                status: false,
                message: 'Kode Gofile hanya boleh huruf, angka, underscore, dan dash (6-64 karakter).'
            });
        }
        code = rawCode;
    } else {
        return res.status(400).json({
            status: false,
            message: "Parameter 'url' atau 'code' diperlukan."
        });
    }

    const pageRaw = String(req.query.page ?? '').trim();
    const page = pageRaw ? Number(pageRaw) : 1;
    if (!Number.isInteger(page) || page < 1 || page > 1000) {
        return res.status(400).json({
            status: false,
            message: 'Parameter page harus angka 1-1000.'
        });
    }

    const filter = cleanText(String(req.query.filter ?? '').trim()).slice(0, 80);
    if (filter && !/^[A-Za-z0-9 ._-]+$/.test(filter)) {
        return res.status(400).json({
            status: false,
            message: 'Parameter filter hanya boleh huruf, angka, spasi, titik, underscore, dan dash.'
        });
    }

    const compact = /^(1|true|yes)$/i.test(String(req.query.compact ?? '').trim());
    const query = new URLSearchParams();
    if (page > 1) query.set('page', String(page));
    if (filter) query.set('filter', filter);
    query.set('cb', String(Date.now()));
    const targetUrl = `https://gofile.io/d/${encodeURIComponent(code)}?${query.toString()}`;

    try {
        const upstream = await axios.get<string>(targetUrl, {
            timeout: 25000,
            maxRedirects: 0,
            responseType: 'text',
            maxContentLength: MAX_HTML_BYTES,
            maxBodyLength: MAX_HTML_BYTES,
            validateStatus: () => true,
            headers: {
                'User-Agent': CRAWLER_UA,
                Accept: 'text/html,application/xhtml+xml',
                'Accept-Language': 'en-US,en;q=0.9'
            }
        });

        if (upstream.status === 404) {
            return res.status(404).json({
                status: false,
                message: 'Konten Gofile tidak ditemukan.',
                result: { code, url: targetUrl, upstream_status: 404 }
            });
        }
        if (upstream.status !== 200) {
            return res.status(502).json({
                status: false,
                message: `Gofile mengembalikan HTTP ${upstream.status}.`,
                result: { code, url: targetUrl, upstream_status: upstream.status }
            });
        }

        const html = typeof upstream.data === 'string' ? upstream.data : String(upstream.data ?? '');
        const $ = cheerio.load(html);
        const ogTitle = readMeta($, 'meta[property="og:title"]');
        const metaDescription = readMeta($, 'meta[name="description"]');
        const ogDescription = readMeta($, 'meta[property="og:description"]');
        const ogUrl = readMeta($, 'meta[property="og:url"]');
        const canonical = cleanText($('link[rel="canonical"]').first().attr('href') || '') || ogUrl || targetUrl;
        const robots = readMeta($, 'meta[name="robots"]');
        const title = stripGofileSuffix(ogTitle || cleanText($('title').text()));
        const description = ogDescription || metaDescription;

        const baseResult: JsonRecord = {
            kind: 'content',
            code,
            url: canonical,
            title,
            description: description || null,
            robots: robots || null,
            source: 'gofile_prerender_html',
            upstream_status: upstream.status
        };

        if (/content not found/i.test(title) || /does not exist|has been deleted/i.test(description)) {
            return res.status(404).json({
                status: false,
                message: 'Konten Gofile tidak ditemukan atau sudah dihapus.',
                result: { ...baseResult, kind: 'not_found' }
            });
        }
        if (/protected content/i.test(title) || /not publicly accessible/i.test(description)) {
            return res.status(403).json({
                status: false,
                message: 'Konten Gofile dilindungi atau tidak publik.',
                result: { ...baseResult, kind: 'protected' }
            });
        }
        if (/content expired/i.test(title) || /has expired/i.test(description)) {
            return res.status(410).json({
                status: false,
                message: 'Konten Gofile sudah kedaluwarsa.',
                result: { ...baseResult, kind: 'expired' }
            });
        }

        const sizeMatch = /^([\d.,]+\s*(?:B|KB|MB|GB|TB))\s+file\s+shared with Gofile$/i.exec(description);
        const countMatch = /^([\d,]+)\s+files?\s+shared with Gofile$/i.exec(description);
        const isEmpty = /^this folder is empty\.$/i.test(description);
        const type = sizeMatch ? 'file' : 'folder';
        const itemCount = sizeMatch ? 1 : isEmpty ? 0 : countMatch ? Number(countMatch[1].replace(/,/g, '')) : null;

        const items: JsonRecord[] = [];
        $('.fm-row[data-id]').each((_, element) => {
            const row = $(element);
            const id = cleanText(row.attr('data-id') || '');
            if (!id) return;
            const itemType = cleanText(row.attr('data-type') || 'file') || 'file';
            const name = cleanText(row.find('p.truncate').first().text()) ||
                cleanText(row.find('[aria-label^="Select "]').first().attr('aria-label') || '').replace(/^Select\s+/i, '') ||
                id;
            const metaText = cleanText(row.find('p').eq(1).text());
            const size = sizeFromText(metaText);
            items.push({
                id,
                name,
                type: itemType,
                page_url: `https://gofile.io/d/${encodeURIComponent(id)}`,
                size,
                size_bytes: parseSize(size),
                created_at: dateFromText(metaText),
                icon: row.find('svg[data-lucide]').first().attr('data-lucide') || null
            });
        });

        let file: JsonRecord | null = null;
        if (type === 'file') {
            const heading = $('h1.break-all').first();
            const fileMetaText = heading.length ? cleanText(heading.parent().find('p').first().text()) : '';
            const fileSize = sizeMatch?.[1] || sizeFromText(fileMetaText) || sizeFromText(description);
            file = {
                code,
                id: items[0]?.id ?? null,
                name: cleanText(heading.text()) || title,
                size: fileSize,
                size_bytes: parseSize(fileSize),
                created_at: dateFromText(fileMetaText),
                icon: $('h1.break-all').first().parent().find('svg[data-lucide]').first().attr('data-lucide') || null,
                page_url: canonical
            };
        }

        const folderDescription = cleanText($('#fm-description-body').text()) || null;
        const pagination = {
            page,
            has_next: $('[data-action="page-next"]').length > 0,
            has_previous: $('[data-action="page-prev"]').length > 0
        };
        const meta: JsonRecord = compact ? {} : {
            og_title: ogTitle || null,
            og_description: ogDescription || null,
            twitter_title: readMeta($, 'meta[name="twitter:title"]') || null,
            twitter_description: readMeta($, 'meta[name="twitter:description"]') || null,
            og_image: readMeta($, 'meta[property="og:image"]') || null,
            canonical: cleanText($('link[rel="canonical"]').first().attr('href') || '') || null,
            robots: robots || null
        };

        const result: JsonRecord = {
            ...baseResult,
            kind: type,
            type,
            name: title,
            item_count: itemCount,
            items: type === 'folder' ? (compact ? items.slice(0, 5) : items) : [],
            file,
            folder_description: type === 'folder' ? folderDescription : null,
            pagination,
            query: { code, page, filter: filter || null, compact }
        };
        if (!compact) {
            result.meta = meta;
            result.note = 'Data diambil dari halaman prerender publik Gofile. Listing API Gofile sendiri memerlukan akun Premium.';
        }

        return res.json({ status: true, result });
    } catch (error) {
        const err = error as { code?: string; message?: string; response?: { status?: number } };
        const message = cleanText(err?.message || String(error));
        const timeout = /timeout|aborted|ECONNABORTED|ETIMEDOUT/i.test(`${err?.code || ''} ${message}`);
        return res.status(timeout ? 504 : 502).json({
            status: false,
            message: timeout ? 'Gofile terlalu lama merespons.' : 'Gagal mengambil data dari Gofile.',
            detail: message.slice(0, 200)
        });
    }
}
