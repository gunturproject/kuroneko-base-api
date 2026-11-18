import { Request, Response } from 'express';
import axios from 'axios';
import * as cheerio from 'cheerio';
import { createHash } from 'crypto';
import { parsePublicHttpUrl } from '../../src/security/url';

type SiteKey = 'singular' | 'plural';
type JsonRecord = Record<string, unknown>;

interface WpTerm {
    id?: number;
    name?: string;
    slug?: string;
    taxonomy?: string;
}

interface WpEmbedded {
    author?: Array<{ name?: string }>;
    'wp:featuredmedia'?: Array<{ source_url?: string }>;
    'wp:term'?: Array<WpTerm[]>;
}

interface WpPost {
    id: number;
    date: string;
    date_gmt?: string;
    modified?: string;
    modified_gmt?: string;
    slug: string;
    link: string;
    title?: { rendered?: string };
    content?: { rendered?: string; protected?: boolean };
    excerpt?: { rendered?: string };
    author?: number;
    featured_media?: number;
    categories?: number[];
    tags?: number[];
    rttpg_featured_image_url?: { full?: unknown[] };
    _embedded?: WpEmbedded;
}

interface Target {
    site: SiteKey;
    slug?: string;
    id?: number;
}

const SITES: Record<SiteKey, { host: string; origin: string; label: string }> = {
    singular: { host: 'scriptpastebin.com', origin: 'https://scriptpastebin.com', label: 'ScriptPastebin' },
    plural: { host: 'scriptpastebins.com', origin: 'https://scriptpastebins.com', label: 'ScriptPastebins' }
};

const HOST_TO_SITE: Record<string, SiteKey> = {
    'scriptpastebin.com': 'singular',
    'www.scriptpastebin.com': 'singular',
    'scriptpastebins.com': 'plural',
    'www.scriptpastebins.com': 'plural'
};

const SITE_ALIASES: Record<string, SiteKey> = {
    singular: 'singular',
    'scriptpastebin': 'singular',
    'scriptpastebin.com': 'singular',
    'www.scriptpastebin.com': 'singular',
    plural: 'plural',
    'scriptpastebins': 'plural',
    'scriptpastebins.com': 'plural',
    'www.scriptpastebins.com': 'plural'
};

const UA = 'Mozilla/5.0 (compatible; KuroNeko-ScriptPastebin/1.0)';
const BROWSER_UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/131.0 Safari/537.36';
const SLUG_RE = /^[a-z0-9][a-z0-9-]{2,120}$/;
const MAX_JSON_BYTES = 3 * 1024 * 1024;
const MAX_HTML_BYTES = 3 * 1024 * 1024;
const MAX_CODE_CHARS = 200_000;
const MAX_LINKS = 20;
const MAX_TERMS = 24;

class UpstreamError extends Error {
    constructor(public status: number, message: string) {
        super(message);
        this.name = 'UpstreamError';
    }
}

const cleanText = (value: unknown): string =>
    String(value ?? '').replace(/\s+/g, ' ').trim();

const stripSiteSuffix = (value: unknown): string =>
    cleanText(value).replace(/\s*[–—·|-]\s*ScriptPastebins?\s*$/i, '');

const normalizeKey = (value: string): string =>
    cleanText(value)
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, ' ')
        .trim()
        .split(' ')
        .filter(Boolean)
        .sort()
        .join(' ');

const safeUrl = (raw: unknown): string | null => {
    const value = cleanText(raw);
    if (!value) return null;
    const parsed = parsePublicHttpUrl(value);
    return parsed ? parsed.toString() : null;
};

const boundedInt = (raw: unknown, fallback: number, min: number, max: number): number | null => {
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    return Number.isInteger(value) && value >= min && value <= max ? value : null;
};

const htmlToText = (html: unknown): string => {
    const source = String(html ?? '');
    if (!source.trim()) return '';
    const $ = cheerio.load(source);
    $('script,style,noscript,iframe').remove();
    const blocks = $('p,li,h1,h2,h3,h4,h5,h6,pre')
        .map((_, element) => cleanText($(element).text()))
        .get()
        .filter(Boolean);
    return blocks.length ? uniqueLines(blocks).join('\n') : cleanText($.root().text());
};

const uniqueLines = (lines: string[]): string[] => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const line of lines) {
        const key = cleanText(line).toLowerCase();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        out.push(cleanText(line));
    }
    return out;
};

const sanitizeHtml = (html: unknown): string => {
    const source = String(html ?? '');
    if (!source.trim()) return '';
    const $ = cheerio.load(source);
    $('script,style,noscript,iframe,object,embed,form,link,meta,base').remove();
    $('*').each((_, element) => {
        const node = $(element);
        for (const attr of Object.keys(node.attr() || {})) {
            if (/^on/i.test(attr)) node.removeAttr(attr);
        }
        for (const attr of ['href', 'src', 'action', 'formaction', 'xlink:href']) {
            const value = cleanText(node.attr(attr));
            if (value && /^(javascript|data|blob|vbscript):/i.test(value)) node.removeAttr(attr);
        }
    });
    return $('body').html() || '';
};

const extractCode = (html: unknown): string => {
    const source = String(html ?? '');
    if (!source.trim()) return '';
    const $ = cheerio.load(source);
    const candidates = [
        $('#script-code').first().text(),
        $('pre code').first().text(),
        $('pre').first().text()
    ];
    for (const candidate of candidates) {
        const code = String(candidate ?? '').replace(/\r\n/g, '\n').trim();
        if (code) return code;
    }
    return '';
};

const readMeta = ($: cheerio.CheerioAPI, selector: string): string =>
    cleanText($(selector).first().attr('content') || '');

const extractPageMeta = (html: string, fallbackUrl: string): JsonRecord => {
    const $ = cheerio.load(html);
    const canonical = cleanText($('link[rel="canonical"]').first().attr('href') || '') ||
        readMeta($, 'meta[property="og:url"]') || fallbackUrl;
    return {
        title: stripSiteSuffix(readMeta($, 'meta[property="og:title"]') || $('title').first().text()),
        description: readMeta($, 'meta[name="description"]') || readMeta($, 'meta[property="og:description"]') || null,
        canonical: safeUrl(canonical) || fallbackUrl,
        image: safeUrl(readMeta($, 'meta[property="og:image"]')),
        robots: readMeta($, 'meta[name="robots"]') || null
    };
};

const extractLinks = (html: unknown, baseUrl: string): JsonRecord[] => {
    const source = String(html ?? '');
    if (!source.trim()) return [];
    const $ = cheerio.load(source);
    const out: JsonRecord[] = [];
    const seen = new Set<string>();
    $('a[href],iframe[src]').each((_, element) => {
        if (out.length >= MAX_LINKS) return;
        const node = $(element);
        const raw = cleanText(node.attr('href') || node.attr('src') || '');
        if (!raw || /^(javascript|data|blob|mailto|tel):/i.test(raw)) return;
        let absolute = raw;
        try {
            absolute = new URL(raw, baseUrl).toString();
        } catch {
            return;
        }
        const url = safeUrl(absolute);
        if (!url || seen.has(url)) return;
        seen.add(url);
        out.push({
            url,
            label: cleanText(node.text()) || cleanText(node.attr('title') || '') || null,
            kind: node.is('iframe') ? 'embed' : 'link'
        });
    });
    return out;
};

const findPluralHref = (html: unknown): string | null => {
    const $ = cheerio.load(String(html ?? ''));
    const hrefs = $('a[href]').map((_, element) => $(element).attr('href') || '').get();
    for (const href of hrefs) {
        const safe = safeUrl(href);
        if (!safe) continue;
        try {
            const parsed = new URL(safe);
            if (HOST_TO_SITE[parsed.hostname.toLowerCase()] === 'plural') return safe;
        } catch {
            continue;
        }
    }
    return null;
};

const extractPostTerms = (post: WpPost): JsonRecord[] => {
    const groups = post._embedded?.['wp:term'] || [];
    const terms: JsonRecord[] = [];
    for (const group of groups) {
        for (const term of group) {
            if (!term || !term.name || terms.length >= MAX_TERMS) continue;
            terms.push({
                id: term.id ?? null,
                name: cleanText(term.name),
                slug: cleanText(term.slug),
                taxonomy: cleanText(term.taxonomy)
            });
        }
    }
    return terms;
};

const extractFeaturedImage = (post: WpPost): string | null => {
    const embedded = safeUrl(post._embedded?.['wp:featuredmedia']?.[0]?.source_url);
    if (embedded) return embedded;
    const full = post.rttpg_featured_image_url?.full;
    return safeUrl(Array.isArray(full) ? full[0] : null);
};

const parseTarget = (raw: unknown): Target | null => {
    const value = cleanText(raw);
    if (!value) return null;
    const parsed = parsePublicHttpUrl(value);
    if (!parsed || parsed.protocol !== 'https:') return null;
    const site = HOST_TO_SITE[parsed.hostname.toLowerCase()];
    if (!site) return null;

    const slugMatch = /^\/([A-Za-z0-9][A-Za-z0-9-]{2,120})\/?$/.exec(parsed.pathname);
    if (slugMatch) return { site, slug: slugMatch[1].toLowerCase() };

    const idValue = parsed.searchParams.get('p');
    if (idValue && /^\d{1,10}$/.test(idValue)) return { site, id: Number(idValue) };
    return null;
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const isRetryableUpstreamError = (error: unknown): boolean => {
    const err = error as { code?: string; message?: string; status?: number };
    const status = err instanceof UpstreamError ? err.status : err?.status;
    const message = `${err?.code || ''} ${err?.message || ''}`;
    return status === 429 || (typeof status === 'number' && status >= 500) ||
        /timeout|aborted|ECONNABORTED|ETIMEDOUT|ECONNRESET|socket hang up/i.test(message);
};

async function wpFetch<T>(site: SiteKey, path: string, params: Record<string, string | number>): Promise<{
    data: T;
    total: number;
    pages: number;
}> {
    const url = new URL(`/wp-json/wp/v2/${path}`, SITES[site].origin);
    for (const [key, value] of Object.entries(params)) {
        if (value === '' || value === undefined) continue;
        url.searchParams.set(key, String(value));
    }

    let lastError: unknown;
    for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) await wait(300 * attempt);
        try {
            const response = await axios.get<T>(url.toString(), {
                timeout: 12000,
                maxRedirects: 0,
                validateStatus: () => true,
                responseType: 'json',
                maxContentLength: MAX_JSON_BYTES,
                maxBodyLength: MAX_JSON_BYTES,
                headers: { 'User-Agent': UA, Accept: 'application/json' }
            });
            const payload = response.data as unknown as { code?: string; message?: string };
            if (response.status === 400 && /page_number/i.test(String(payload?.code || ''))) {
                return { data: [] as T, total: 0, pages: 0 };
            }
            if (response.status === 404) return { data: [] as T, total: 0, pages: 0 };
            if (response.status !== 200) {
                throw new UpstreamError(response.status, cleanText(payload?.message) || `HTTP ${response.status}`);
            }
            return {
                data: response.data,
                total: Number(response.headers['x-wp-total'] || 0),
                pages: Number(response.headers['x-wp-totalpages'] || 0)
            };
        } catch (error) {
            lastError = error;
            if (!isRetryableUpstreamError(error) || attempt === 1) throw error;
        }
    }
    throw lastError || new Error('Upstream gagal merespons.');
}

async function fetchHtml(url: string): Promise<string> {
    const response = await axios.get<string>(url, {
        timeout: 15000,
        maxRedirects: 0,
        validateStatus: () => true,
        responseType: 'text',
        maxContentLength: MAX_HTML_BYTES,
        maxBodyLength: MAX_HTML_BYTES,
        headers: {
            'User-Agent': BROWSER_UA,
            Accept: 'text/html,application/xhtml+xml'
        }
    });
    if (response.status !== 200) {
        throw new UpstreamError(response.status, `HTTP ${response.status}`);
    }
    return typeof response.data === 'string' ? response.data : String(response.data ?? '');
}

function mapSearchResult(site: SiteKey, post: WpPost, compact: boolean): JsonRecord {
    const url = safeUrl(post.link) || `${SITES[site].origin}/?p=${post.id}`;
    return {
        site,
        site_label: SITES[site].label,
        id: post.id,
        title: stripSiteSuffix(post.title?.rendered),
        slug: cleanText(post.slug),
        url,
        date: cleanText(post.date_gmt || post.date),
        modified: cleanText(post.modified_gmt || post.modified || post.date_gmt || post.date),
        excerpt: compact ? null : htmlToText(post.excerpt?.rendered) || null,
        featured_image: extractFeaturedImage(post),
        author: cleanText(post._embedded?.author?.[0]?.name) || null,
        terms: compact ? [] : extractPostTerms(post),
        sources: [site],
        detail_url: `/api/tools/scriptpastebin?url=${encodeURIComponent(url)}`
    };
}

function mapDetailPost(site: SiteKey, post: WpPost, compact: boolean): JsonRecord {
    const base = mapSearchResult(site, post, false);
    const contentHtml = String(post.content?.rendered || '');
    const contentText = htmlToText(contentHtml);
    const lines = uniqueLines(contentText.split('\n'));
    const result: JsonRecord = {
        ...base,
        status: 'publish',
        type: 'post',
        guid: safeUrl((post as unknown as { guid?: { rendered?: string } }).guid?.rendered),
        content_text: contentText || null,
        steps: lines.filter((line) => /^\d+[\.\)]\s*/.test(line)).slice(0, 12),
        notes: lines.filter((line) => /^note\s*:/i.test(line)).slice(0, 8),
        links: compact ? [] : extractLinks(contentHtml, String(base.url)),
        has_script_link: !!findPluralHref(contentHtml)
    };
    if (!compact) result.content_html = sanitizeHtml(contentHtml);
    return result;
}

async function resolvePluralPost(primarySite: SiteKey, primaryPost: WpPost): Promise<WpPost | null> {
    if (primarySite === 'plural') return primaryPost;

    const href = findPluralHref(primaryPost.content?.rendered);
    if (href) {
        try {
            const parsed = new URL(href);
            const slugMatch = /^\/([A-Za-z0-9][A-Za-z0-9-]{2,120})\/?$/.exec(parsed.pathname);
            if (slugMatch) {
                const found = await wpFetch<WpPost[]>('plural', 'posts', { slug: slugMatch[1], _embed: 1 });
                if (found.data.length) return found.data[0];
            }
        } catch {
            // Fall through to title-based search below.
        }
    }

    const title = stripSiteSuffix(primaryPost.title?.rendered);
    if (!title) return null;
    const searched = await wpFetch<WpPost[]>('plural', 'posts', {
        search: title.slice(0, 100),
        per_page: 3,
        _embed: 1
    });
    const meaningfulTokens = (value: string): string[] =>
        normalizeKey(value).split(' ').filter((token) => token && token !== 'no' && token !== 'key');
    const wantedTokens = meaningfulTokens(title);

    return searched.data.find((post) => {
        const candidateTokens = meaningfulTokens(stripSiteSuffix(post.title?.rendered));
        if (!wantedTokens.length || !candidateTokens.length) return false;
        const overlap = wantedTokens.filter((token) => candidateTokens.includes(token)).length;
        return overlap >= 3 && (overlap === wantedTokens.length || overlap === candidateTokens.length);
    }) || null;
}

async function resolveScript(pluralPost: WpPost | null): Promise<{
    script: JsonRecord | null;
    pageMeta: JsonRecord | null;
    links: JsonRecord[];
}> {
    if (!pluralPost) return { script: null, pageMeta: null, links: [] };

    let code = extractCode(pluralPost.content?.rendered);
    let pageMeta: JsonRecord | null = null;
    let links: JsonRecord[] = [];
    const pageUrl = safeUrl(pluralPost.link);
    if (!pageUrl) return { script: null, pageMeta: null, links: [] };

    try {
        const html = await fetchHtml(pageUrl);
        code = extractCode(html) || code;
        pageMeta = extractPageMeta(html, pageUrl);
        links = extractLinks(html, pageUrl);
    } catch {
        // WP REST metadata is still usable when the live page is unreachable.
    }

    if (!code) return { script: null, pageMeta, links };

    const truncated = code.length > MAX_CODE_CHARS;
    if (truncated) code = code.slice(0, MAX_CODE_CHARS);
    return {
        script: {
            language: 'lua',
            code,
            source_url: pageUrl,
            length: code.length,
            line_count: code.split('\n').length,
            sha256: createHash('sha256').update(code).digest('hex'),
            truncated
        },
        pageMeta,
        links
    };
}

export default async function scriptPastebinHandler(req: Request, res: Response) {
    const rawUrl = cleanText(req.query.url ?? req.body?.url ?? '');
    const rawSlug = cleanText(req.query.slug ?? req.body?.slug ?? '').toLowerCase();
    const rawQuery = cleanText(req.query.q ?? req.query.search ?? req.body?.q ?? req.body?.search ?? '').slice(0, 120);
    const rawSite = cleanText(req.query.site ?? req.body?.site ?? 'both').toLowerCase();
    const compact = /^(1|true|yes)$/i.test(cleanText(req.query.compact ?? req.body?.compact ?? ''));

    let sites: SiteKey[];
    if (!rawSite || rawSite === 'both' || rawSite === 'all') {
        sites = ['singular', 'plural'];
    } else if (SITE_ALIASES[rawSite]) {
        sites = [SITE_ALIASES[rawSite]];
    } else {
        return res.status(400).json({
            status: false,
            message: "Parameter site harus 'singular', 'plural', atau 'both'."
        });
    }

    let target: Target | null = null;
    if (rawUrl) {
        target = parseTarget(rawUrl);
        if (!target) {
            return res.status(400).json({
                status: false,
                message: 'URL harus HTTPS dan mengarah ke post scriptpastebin.com atau scriptpastebins.com.'
            });
        }
        sites = [target.site];
    } else if (rawSlug) {
        if (!SLUG_RE.test(rawSlug)) {
            return res.status(400).json({
                status: false,
                message: 'Slug hanya boleh huruf kecil, angka, dan dash (3-120 karakter).'
            });
        }
        target = { site: sites[0], slug: rawSlug };
    } else if (!rawQuery) {
        return res.status(400).json({
            status: false,
            message: "Salah satu parameter 'q', 'url', atau 'slug' diperlukan."
        });
    }

    const page = boundedInt(req.query.page ?? req.body?.page ?? 1, 1, 1, 100);
    const limit = boundedInt(req.query.limit ?? req.query.per_page ?? req.body?.limit ?? 10, 10, 1, 50);
    if (page === null || limit === null) {
        return res.status(400).json({
            status: false,
            message: 'Parameter page harus 1-100 dan limit/per_page harus 1-50.'
        });
    }

    try {
        if (rawQuery && !target) {
            const merged: JsonRecord[] = [];
            const seen = new Set<string>();
            const totals: JsonRecord[] = [];
            const failures: JsonRecord[] = [];
            let hasNext = false;

            const responses = await Promise.allSettled(sites.map((site) =>
                wpFetch<WpPost[]>(site, 'posts', {
                    search: rawQuery,
                    per_page: limit,
                    page,
                    orderby: 'relevance',
                    order: 'desc',
                    _embed: 1
                })
            ));

            const siteResults: Array<{ site: SiteKey; response: Awaited<ReturnType<typeof wpFetch<WpPost[]>>> }> = [];
            responses.forEach((entry, index) => {
                if (entry.status === 'fulfilled') {
                    siteResults.push({ site: sites[index], response: entry.value });
                    return;
                }
                const err = entry.reason as { message?: string };
                failures.push({
                    site: sites[index],
                    message: cleanText(err?.message || String(entry.reason)).slice(0, 200)
                });
            });

            if (!siteResults.length && failures.length) {
                throw new Error(String(failures[0].message || '') || 'Upstream gagal merespons.');
            }

            for (const { site, response } of siteResults) {
                totals.push({
                    site,
                    count: response.data.length,
                    total: response.total,
                    pages: response.pages
                });
                if (response.pages > page) hasNext = true;

                for (const post of response.data) {
                    const item = mapSearchResult(site, post, compact);
                    const key = normalizeKey(String(item.title)) || String(item.slug);
                    const existing = merged.find((entry) => normalizeKey(String(entry.title)) === key);
                    if (existing && key) {
                        const existingSources = Array.isArray(existing.sources) ? existing.sources as string[] : [];
                        if (!existingSources.includes(site)) existingSources.push(site);
                        existing.sources = existingSources;
                        if (!existing.featured_image) existing.featured_image = item.featured_image;
                        if (!existing.excerpt) existing.excerpt = item.excerpt;
                        continue;
                    }
                    if (seen.has(key)) continue;
                    seen.add(key);
                    merged.push(item);
                }
            }

            merged.sort((a, b) => String(b.date || '').localeCompare(String(a.date || '')));
            const results = merged.slice(0, limit);
            return res.json({
                status: true,
                result: {
                    mode: 'search',
                    query: rawQuery,
                    sites,
                    pagination: { page, per_page: limit, has_next: hasNext, sites: totals, failed: failures },
                    partial: failures.length > 0,
                    count: results.length,
                    results,
                    ...(failures.length ? {
                        note: 'Sebagian situs gagal diakses; hasil dari situs lain tetap ditampilkan.'
                    } : {})
                }
            });
        }

        if (!target) {
            return res.status(400).json({ status: false, message: 'Target tidak valid.' });
        }

        const query: Record<string, string | number> = { _embed: 1 };
        if (target.slug) query.slug = target.slug;
        if (target.id) query.include = target.id;
        const primaryResponse = await wpFetch<WpPost[]>(target.site, 'posts', query);
        const primaryPost = primaryResponse.data[0];
        if (!primaryPost) {
            return res.status(404).json({
                status: false,
                message: 'Post tidak ditemukan di ScriptPastebin.',
                result: { requested: { ...target, raw_url: rawUrl || null } }
            });
        }

        const pluralPost = await resolvePluralPost(target.site, primaryPost);
        const resolved = await resolveScript(pluralPost);
        const details = mapDetailPost(target.site, primaryPost, compact);
        const pluralDetails = pluralPost && pluralPost.id !== primaryPost.id
            ? mapDetailPost('plural', pluralPost, compact)
            : null;

        const links: JsonRecord[] = [];
        const seenLinks = new Set<string>();
        for (const link of [...(details.links as JsonRecord[]), ...resolved.links]) {
            const url = String(link.url || '');
            if (!url || seenLinks.has(url)) continue;
            seenLinks.add(url);
            links.push(link);
        }
        if (resolved.pageMeta) details.page_meta = resolved.pageMeta;

        const result: JsonRecord = {
            mode: 'detail',
            site: target.site,
            requested: {
                url: rawUrl || null,
                slug: target.slug || null,
                id: target.id || null,
                site: rawSite
            },
            post: details,
            sources: pluralDetails ? [details, pluralDetails] : [details],
            code: resolved.script,
            links: compact ? [] : links.slice(0, MAX_LINKS),
            note: resolved.script
                ? 'Kode diambil dari halaman publik ScriptPastebins yang ditautkan dari post ScriptPastebin.'
                : 'Post ditemukan, tetapi kode script tidak tersedia di halaman publik terkait.'
        };
        if (!compact) {
            result.search_endpoint = `/api/tools/scriptpastebin?q=${encodeURIComponent(
                stripSiteSuffix(primaryPost.title?.rendered) || primaryPost.slug
            )}&site=both`;
        }
        return res.json({ status: true, result });
    } catch (error) {
        const err = error as { code?: string; message?: string; response?: { status?: number } };
        const message = cleanText(err?.message || String(error));
        const status = err instanceof UpstreamError ? err.status : err.response?.status;
        const timeout = /timeout|aborted|ECONNABORTED|ETIMEDOUT/i.test(`${err?.code || ''} ${message}`);
        const upstreamStatus = status || (timeout ? 504 : 502);
        return res.status(timeout ? 504 : upstreamStatus >= 500 ? 502 : upstreamStatus).json({
            status: false,
            message: timeout
                ? 'ScriptPastebin terlalu lama merespons.'
                : `Gagal mengambil data dari ScriptPastebin (HTTP ${upstreamStatus}).`,
            detail: message.slice(0, 200)
        });
    }
}
