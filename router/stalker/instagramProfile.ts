import { Request, Response } from 'express';
import axios from 'axios';

/*
 * Scrape profil Instagram publik via username — anti rate-limit.
 *
 * Strategi:
 *  1. Cache CDN lewat Cache-Control s-maxage (Vercel menyimpan response GET).
 *  2. Cache memory per instance + request coalescing (1 fetch per username).
 *  3. Circuit breaker: kalau Instagram balas 429 atau redirect ke /accounts/login/,
 *     fetch berikutnya diskip selama cooldown dan memakai snapshot stale kalau ada.
 *  4. Fallback proxy baca publik (Google Translate) dipakai kalau IP datacenter
 *     dilayani halaman login, karena proxy itu mengambil OG meta asli.
 *  5. Compact tidak memanggil web_profile_info sama sekali; full memanggilnya
 *     hanya kalau OG tersedia dan tidak sedang cooldown.
 *
 * Tanpa login: phone/email, follower list, story, dan like/comment per akun
 * tidak tersedia. Field tersebut ditandai, bukan dikarang.
 */

const FB_UA =
    'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';
const BROWSER_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';
const IG_APP_ID = '936619743392459';

const CACHE_TTL = 5 * 60 * 1000;
const ERROR_TTL = 30 * 1000;
const NOT_FOUND_TTL = 2 * 60 * 1000;
const STALE_TTL = 60 * 60 * 1000;
const API_COOLDOWN = 60 * 1000;
const OG_COOLDOWN = 30 * 1000;
const OG_BLOCK_COOLDOWN = 5 * 60 * 1000;
const MAX_CACHE_ENTRIES = 500;
const GTRANSLATE_ORIGINS = [
    'https://www-instagram-com.translate.goog',
    'https://instagram-com.translate.goog'
];

interface InstagramInput {
    username: string;
    source: string;
}

interface HandlerInput extends InstagramInput {
    raw: string;
    compact: boolean;
    compactRaw: string;
}

interface Meta {
    [key: string]: string | null;
}

interface CachedSnapshot {
    snapshot: Snapshot;
    expires: number;
    staleUntil: number;
}

interface Snapshot {
    ok: boolean;
    statusCode: number;
    errorBody?: any;
    ogHtml: string;
    ogMeta: Meta;
    apiJson: any;
    apiUser: any;
    statuses: Record<string, string>;
    httpInfo: Record<string, any>;
    sources: string[];
    notFoundPage: boolean;
    fetchedAt: number;
    cacheTtl: number;
    servedFrom: 'network' | 'cache' | 'stale' | 'inflight';
    stale?: boolean;
    degraded?: boolean;
    blockReason?: string;
    blockDetail?: any;
}

const snapshotCache = new Map<string, CachedSnapshot>();
const inflight = new Map<string, Promise<Snapshot>>();
let apiCooldownUntil = 0;
let ogCooldownUntil = 0;

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

function normalizeInstagramInput(raw: string): InstagramInput {
    let value = raw.trim();

    if (/^https?:\/\//i.test(value)) {
        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            throw new Error('Format URL tidak valid');
        }
        if (!/(^|\.)instagram\.com$/i.test(parsed.hostname)) {
            throw new Error('URL harus berasal dari Instagram (instagram.com)');
        }
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (!parts.length) throw new Error('Username tidak ditemukan di URL tersebut');
        value = decodeURIComponent(parts[0]);
    }

    value = value.replace(/^@+/, '').replace(/^\/+|\/+$/g, '').trim();

    if (!/^[A-Za-z0-9._]{1,30}$/.test(value)) {
        throw new Error(
            'Username Instagram tidak valid (1-30 karakter: huruf, angka, titik, underscore)'
        );
    }

    return { username: value, source: raw.includes('://') ? 'url' : 'username' };
}

function decodeEntities(input: string): string {
    return input
        .replace(/&nbsp;/gi, ' ')
        .replace(/&amp;/gi, '&')
        .replace(/&lt;/gi, '<')
        .replace(/&gt;/gi, '>')
        .replace(/&quot;/gi, '"')
        .replace(/&#0*39;/gi, "'")
        .replace(/&apos;/gi, "'")
        .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
        .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)));
}

function stripTags(input: string): string {
    const cleaned = input
        .replace(/<script[\s\S]*?<\/script>/gi, ' ')
        .replace(/<style[\s\S]*?<\/style>/gi, ' ')
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<[^>]+>/g, ' ');
    return decodeEntities(cleaned).replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n').trim();
}

function pickMeta(html: string): Meta {
    const result: Meta = {};
    const re =
        /<meta[^>]+(?:property|name)\s*=\s*["']([^"']+)["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/gi;
    const reAlt =
        /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*(?:property|name)\s*=\s*["']([^"']+)["'][^>]*>/gi;
    let match: RegExpExecArray | null;

    while ((match = re.exec(html)) !== null) {
        result[match[1].toLowerCase()] = decodeEntities(match[2]);
    }
    while ((match = reAlt.exec(html)) !== null) {
        const key = match[2].toLowerCase();
        if (!(key in result)) result[key] = decodeEntities(match[1]);
    }
    return result;
}

function parseCompactNumber(value: string | null | number | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;

    const cleaned = value.replace(/\u00a0/g, ' ').trim().toLowerCase();
    const match = cleaned.match(/^([\d\s.,]+)\s*([kmb])?$/);
    if (!match) return null;

    const unit = match[2] || '';
    let digits = match[1].replace(/\s/g, '');

    if (unit) {
        const separators = digits.match(/[.,]/g) || [];
        digits = separators.length > 1 ? digits.replace(/[.,]/g, '') : digits.replace(',', '.');
    } else {
        digits = digits.replace(/[.,]/g, '');
    }

    const base = Number(digits);
    if (!Number.isFinite(base)) return null;
    const multiplier = unit === 'b' ? 1e9 : unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1;
    return Math.round(base * multiplier);
}

function firstFinite(...values: Array<number | null | undefined>): number | null {
    for (const value of values) {
        if (value !== null && value !== undefined && Number.isFinite(value)) return value;
    }
    return null;
}

function firstString(...values: Array<string | null | undefined>): string | null {
    for (const value of values) {
        if (typeof value === 'string' && value.trim()) return value;
    }
    return null;
}

function parseOgCounts(description: string | null) {
    if (!description) return { followers_raw: null, following_raw: null, posts_raw: null };
    const num = '([\\d][\\d.,\\s\\u00a0]*[kmb]?)';
    return {
        followers_raw: description.match(new RegExp(`${num}\\s+followers?`, 'i'))?.[1]?.trim() || null,
        following_raw: description.match(new RegExp(`${num}\\s+following`, 'i'))?.[1]?.trim() || null,
        posts_raw: description.match(new RegExp(`${num}\\s+posts?`, 'i'))?.[1]?.trim() || null
    };
}

function ogMetaExists(html: string): boolean {
    return /<meta[^>]+property=["']og:(?:title|description)["']/i.test(html);
}

function notFoundPage(html: string): boolean {
    return (
        /"pageID"\s*:\s*"httpErrorPage"/i.test(html) ||
        /"pageID"\s*:\s*"errorRoot"/i.test(html)
    );
}

function loginRedirected(http: Record<string, any>): boolean {
    return Object.values(http).some(
        (info) => /\/accounts\/login\//i.test(String(info?.final_url || ''))
    );
}

function looksLikeLoginPage(html: string): boolean {
    return /Log into Instagram|log in to Instagram|accounts\/login/i.test(html);
}

function proxyProfileUrl(origin: string, username: string): string {
    return `${origin}/${username}/?_x_tr_sl=auto&_x_tr_tl=en&_x_tr_hl=en`;
}

function parseApiUser(apiJson: any): any | null {
    return apiJson?.data?.user || apiJson?.user || null;
}

function parseApiPost(node: any) {
    if (!node) return null;

    const caption = node?.edge_media_to_caption?.edges?.[0]?.node?.text ?? node?.caption?.text ?? null;
    const shortcode = node?.shortcode || null;
    const timestamp = node?.taken_at_timestamp || null;
    const sidecar = node?.edge_sidecar_to_children?.edges || [];
    const children = sidecar
        .map((edge: any) => edge?.node)
        .filter(Boolean)
        .map((child: any) => ({
            id: child?.id || null,
            display_url: child?.display_url || null,
            is_video: Boolean(child?.is_video),
            video_url: child?.video_url || null,
            accessibility_caption: child?.accessibility_caption || null
        }));

    const mediaTypes: string[] = [];
    if (children.length) mediaTypes.push('sidecar');
    if (node?.is_video || node?.video_url) mediaTypes.push('video');
    if (!children.length && !node?.is_video) mediaTypes.push('image');

    return {
        id: node?.id || null,
        pk: node?.pk || null,
        shortcode,
        url: shortcode ? `https://www.instagram.com/p/${shortcode}/` : null,
        type: node?.__typename || (node?.is_video ? 'GraphVideo' : 'GraphImage'),
        media_types: Array.from(new Set(mediaTypes)),
        caption,
        caption_length: typeof caption === 'string' ? caption.length : 0,
        taken_at_timestamp: timestamp,
        taken_at: timestamp ? new Date(Number(timestamp) * 1000).toISOString() : null,
        likes: firstFinite(node?.edge_liked_by?.count, node?.edge_media_preview_like?.count, node?.likes),
        comments: firstFinite(
            node?.edge_media_to_comment?.count,
            node?.edge_media_to_parent_comment?.count,
            node?.comments
        ),
        video_view_count: firstFinite(node?.video_view_count),
        display_url: node?.display_url || null,
        thumbnail_src: node?.thumbnail_src || null,
        video_url: node?.video_url || null,
        accessibility_caption: node?.accessibility_caption || null,
        location: node?.location
            ? { id: node.location.id || null, name: node.location.name || null }
            : null,
        sidecar_children: children,
        is_restricted: Boolean(node?.is_restricted)
    };
}

function parseApiPosts(apiUser: any, limit: number) {
    const timeline = apiUser?.edge_owner_to_timeline_media || {};
    const edges = Array.isArray(timeline.edges) ? timeline.edges : [];
    return {
        count: firstFinite(timeline.count, apiUser?.media_count),
        has_next_page: Boolean(timeline?.page_info?.has_next_page),
        end_cursor: timeline?.page_info?.end_cursor || null,
        items: edges.slice(0, limit).map((edge: any) => parseApiPost(edge?.node)).filter(Boolean)
    };
}

function parseHighlights(apiUser: any, limit: number) {
    const edges = apiUser?.highlights?.edges || [];
    return edges.slice(0, limit).map((edge: any) => ({
        id: edge?.node?.id || null,
        title: edge?.node?.title || null,
        cover_url: edge?.node?.cover_media?.thumbnail_src || edge?.node?.cover_pic_url || null,
        url: edge?.node?.id
            ? `https://www.instagram.com/stories/highlights/${edge.node.id}/`
            : null
    }));
}

function statusOf(result: PromiseSettledResult<unknown>): string {
    if (result.status === 'fulfilled') return 'ok';
    if (axios.isAxiosError(result.reason) && result.reason.response) {
        return `HTTP ${result.reason.response.status}`;
    }
    return 'error';
}

function httpOf(result: PromiseSettledResult<unknown>): Record<string, any> {
    if (result.status !== 'fulfilled') {
        return {
            ok: false,
            status: null,
            error:
                axios.isAxiosError(result.reason) && result.reason.response
                    ? `HTTP ${result.reason.response.status}`
                    : 'error'
        };
    }
    const value = result.value as any;
    const headers = value?.headers || {};
    return {
        ok: Boolean(value?.status >= 200 && value?.status < 300),
        status: value?.status ?? null,
        status_text: value?.statusText || null,
        url: value?.config?.url || null,
        final_url: value?.request?.res?.responseUrl || null,
        content_type: headers['content-type'] || null,
        body_bytes: value?.data ? String(value.data).length : null
    };
}

function isRateLimited(result: PromiseSettledResult<unknown>): boolean {
    if (result.status !== 'rejected') return (result.value as any)?.status === 429;
    return axios.isAxiosError(result.reason) && result.reason.response?.status === 429;
}

async function settledGet(url: string, config: any): Promise<PromiseSettledResult<unknown>> {
    return axios.get(url, config).then(
        (value) => ({ status: 'fulfilled', value } as PromiseSettledResult<unknown>),
        (reason) => ({ status: 'rejected', reason } as PromiseSettledResult<unknown>)
    );
}

function remember(
    username: string,
    snapshot: Snapshot,
    ttl: number
): Snapshot {
    snapshot.cacheTtl = ttl;
    snapshotCache.set(username, {
        snapshot,
        expires: Date.now() + ttl,
        staleUntil: Date.now() + Math.max(ttl, STALE_TTL)
    });
    if (snapshotCache.size > MAX_CACHE_ENTRIES) {
        const oldest = snapshotCache.keys().next().value as string | undefined;
        if (oldest) snapshotCache.delete(oldest);
    }
    return snapshot;
}

function errorSnapshot(
    statusCode: number,
    message: string,
    detail: any,
    ttl: number
): Snapshot {
    return {
        ok: false,
        statusCode,
        errorBody: { status: false, message, detail },
        ogHtml: '',
        ogMeta: {},
        apiJson: null,
        apiUser: null,
        statuses: {},
        httpInfo: {},
        sources: [],
        notFoundPage: false,
        fetchedAt: Date.now(),
        cacheTtl: ttl,
        servedFrom: 'network'
    };
}

function degradedSnapshot(
    ogHtml: string,
    statuses: Record<string, string>,
    httpInfo: Record<string, any>,
    detail: any
): Snapshot {
    return {
        ok: true,
        statusCode: 200,
        ogHtml,
        ogMeta: {},
        apiJson: null,
        apiUser: null,
        statuses,
        httpInfo,
        sources: [],
        notFoundPage: false,
        fetchedAt: Date.now(),
        cacheTtl: CACHE_TTL,
        servedFrom: 'network',
        degraded: true,
        blockReason: 'instagram_login_redirect',
        blockDetail: detail
    };
}

async function loadSnapshot(
    username: string,
    cacheKey: string,
    withApi: boolean
): Promise<Snapshot> {
    const profileUrl = `https://www.instagram.com/${username}/`;
    const cached = snapshotCache.get(cacheKey);
    const stale = cached && Date.now() < cached.staleUntil ? cached.snapshot : null;
    const common = {
        timeout: 20000,
        maxContentLength: 12 * 1024 * 1024,
        maxBodyLength: 12 * 1024 * 1024
    };
    const fbHeaders = {
        'User-Agent': FB_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'identity'
    };

    const statuses: Record<string, string> = {};
    const httpInfo: Record<string, any> = {};
    const sources: string[] = [];

    let ogHtml = '';
    let ogMeta: Meta = {};
    let isNotFound = false;

    let directBlocked = false;

    const tryOg = async (url: string, label: string) => {
        if (Date.now() < ogCooldownUntil) {
            statuses[label] = 'cooldown';
            httpInfo[label] = { ok: false, error: 'cooldown' };
            return '';
        }
        const result = await settledGet(url, { ...common, responseType: 'text', headers: fbHeaders });
        statuses[label] = statusOf(result);
        httpInfo[label] = httpOf(result);
        const html = result.status === 'fulfilled' ? String((result.value as any)?.data ?? '') : '';
        if (!ogHtml) ogHtml = html;
        if (isRateLimited(result)) ogCooldownUntil = Date.now() + OG_COOLDOWN;
        if (ogMetaExists(html)) {
            ogHtml = html;
            ogMeta = pickMeta(html);
            if (!sources.includes(label)) sources.push(label);
        } else if (notFoundPage(html)) {
            isNotFound = true;
            ogHtml = html;
        } else if (
            label.startsWith('og_profile_page') &&
            (loginRedirected(httpInfo) || looksLikeLoginPage(html))
        ) {
            directBlocked = true;
        }
        return html;
    };

    await tryOg(profileUrl, 'og_profile_page');

    // IP datacenter/Vercel sering dilayani /accounts/login/. Google Translate
    // proxy mengambil halaman dari IP berbeda dan OG meta aslinya tetap ada.
    if (!ogMetaExists(ogHtml) && !isNotFound && Date.now() >= ogCooldownUntil) {
        for (let i = 0; i < GTRANSLATE_ORIGINS.length; i++) {
            await tryOg(
                proxyProfileUrl(GTRANSLATE_ORIGINS[i], username),
                i === 0 ? 'og_proxy_gtranslate' : 'og_proxy_gtranslate_alt'
            );
            if (ogMetaExists(ogHtml) || isNotFound || Date.now() < ogCooldownUntil) break;
        }
    }

    // Fallback terakhir kalau proxy juga gagal. Sengaja dibatasi.
    if (!ogMetaExists(ogHtml) && !isNotFound && Date.now() >= ogCooldownUntil) {
        await tryOg(`https://instagram.com/${username}/`, 'og_profile_page_alt1');
    }
    if (!ogMetaExists(ogHtml) && !isNotFound && Date.now() >= ogCooldownUntil) {
        await sleep(400);
        await tryOg(`${profileUrl}?_igst=${Date.now()}`, 'og_profile_page_retry');
    }

    const upstreamBlocked =
        !ogMetaExists(ogHtml) &&
        (directBlocked || loginRedirected(httpInfo) || looksLikeLoginPage(ogHtml));
    if (upstreamBlocked) ogCooldownUntil = Date.now() + OG_BLOCK_COOLDOWN;

    let apiJson: any = null;
    let apiUser: any = null;
    let apiResult: PromiseSettledResult<unknown> | null = null;

    // Compact tidak memanggil API. Kalau IP server diblokir, full juga diskip
    // supaya tidak menambah 429 ke Instagram.
    if (withApi && !upstreamBlocked && Date.now() >= apiCooldownUntil) {
        apiResult = await settledGet(
            `https://www.instagram.com/api/v1/users/web_profile_info/?username=${encodeURIComponent(username)}`,
            {
                ...common,
                timeout: 10000,
                headers: {
                    'User-Agent': BROWSER_UA,
                    Accept: '*/*',
                    'Accept-Encoding': 'identity',
                    'X-IG-App-ID': IG_APP_ID,
                    Referer: profileUrl
                }
            }
        );
        statuses.web_profile_info = statusOf(apiResult);
        httpInfo.web_profile_info = httpOf(apiResult);
        apiJson = apiResult.status === 'fulfilled' ? (apiResult.value as any)?.data : null;
        apiUser = parseApiUser(apiJson);
        if (isRateLimited(apiResult)) {
            apiCooldownUntil = Date.now() + API_COOLDOWN;
        } else if (apiUser) {
            sources.push('web_profile_info');
        }
    } else if (withApi && upstreamBlocked) {
        statuses.web_profile_info = 'skipped_blocked';
        httpInfo.web_profile_info = { ok: false, error: 'skipped_blocked' };
    } else if (withApi) {
        statuses.web_profile_info = 'cooldown';
        httpInfo.web_profile_info = { ok: false, error: 'cooldown' };
    } else {
        statuses.web_profile_info = 'skipped_compact';
        httpInfo.web_profile_info = { ok: false, error: 'skipped_compact' };
    }

    const detail = {
        og_title: ogMeta['og:title'] || null,
        og_status: statuses.og_profile_page || null,
        og_fallback_statuses: Object.entries(statuses)
            .filter(([key]) => key.startsWith('og_'))
            .map(([key, value]) => `${key}:${value}`),
        og_bytes: ogHtml.length,
        og_http: httpInfo,
        og_page_id: (ogHtml.match(/"pageID"\s*:\s*"([^"]+)"/i) || [])[1] || null,
        og_title_tag: (ogHtml.match(/<title>([^<]*)<\/title>/i) || [])[1] || null,
        not_found_page: isNotFound,
        api_status: apiResult
            ? statusOf(apiResult)
            : upstreamBlocked
                ? 'skipped_blocked'
                : withApi
                    ? 'cooldown'
                    : 'skipped_compact',
        api_cooldown_active: Date.now() < apiCooldownUntil,
        upstream_blocked: upstreamBlocked
    };

    if (!ogMetaExists(ogHtml) && !apiUser) {
        if (isNotFound) {
            return remember(
                cacheKey,
                errorSnapshot(
                    404,
                    `Username Instagram '@${username}' tidak ditemukan atau tidak tersedia.`,
                    detail,
                    NOT_FOUND_TTL
                ),
                NOT_FOUND_TTL
            );
        }
        if (stale) {
            return { ...stale, servedFrom: 'stale', stale: true, fetchedAt: stale.fetchedAt };
        }
        if (upstreamBlocked) {
            return remember(
                cacheKey,
                degradedSnapshot(ogHtml, statuses, httpInfo, detail),
                CACHE_TTL
            );
        }
        return remember(
            cacheKey,
            errorSnapshot(
                503,
                'Instagram sedang membatasi request (rate-limit). Coba beberapa saat lagi.',
                detail,
                ERROR_TTL
            ),
            ERROR_TTL
        );
    }

    return remember(
        cacheKey,
        {
            ok: true,
            statusCode: 200,
            ogHtml,
            ogMeta,
            apiJson,
            apiUser,
            statuses,
            httpInfo,
            sources,
            notFoundPage: isNotFound,
            fetchedAt: Date.now(),
            cacheTtl: CACHE_TTL,
            servedFrom: 'network'
        },
        CACHE_TTL
    );
}

function buildSuccessBody(snapshot: Snapshot, input: HandlerInput) {
    const compact =
        input.compact === true ||
        input.compactRaw === '1' ||
        input.compactRaw === 'true';
    const meta = snapshot.ogMeta;
    const ogTitle = meta['og:title'] || '';
    const ogDescription = meta['og:description'] || '';
    const ogCounts = parseOgCounts(ogDescription);
    const apiUser = snapshot.apiUser;
    const profileUrl = `https://www.instagram.com/${input.username}/`;

    const apiFollowers = firstFinite(apiUser?.edge_followed_by?.count, apiUser?.followers_count);
    const apiFollowing = firstFinite(apiUser?.edge_follow?.count, apiUser?.following_count);
    const apiPostsCount = firstFinite(apiUser?.edge_owner_to_timeline_media?.count, apiUser?.media_count);

    const timeline = parseApiPosts(apiUser, compact ? 10 : 50);
    const highlights = parseHighlights(apiUser, compact ? 5 : 20);
    const fullNameFromOg = ogTitle.match(/^(.+?)\s*\(@/)?.[1]?.trim() || null;
    const canonicalUrl =
        (snapshot.ogHtml.match(/<link[^>]+rel=["']canonical["'][^>]+href=["']([^"']+)["']/i) ||
            [])[1] || null;
    const localeAlternates = Array.from(
        snapshot.ogHtml.matchAll(/hreflang=["']([^"']+)["']/gi)
    ).map((match) => match[1]);

    const stats = {
        followers: apiFollowers ?? parseCompactNumber(ogCounts.followers_raw),
        followers_source: apiFollowers !== null ? 'web_profile_info' : 'og:description',
        followers_raw: apiFollowers !== null ? String(apiFollowers) : ogCounts.followers_raw,
        following: apiFollowing ?? parseCompactNumber(ogCounts.following_raw),
        following_source: apiFollowing !== null ? 'web_profile_info' : 'og:description',
        following_raw: apiFollowing !== null ? String(apiFollowing) : ogCounts.following_raw,
        posts: apiPostsCount ?? parseCompactNumber(ogCounts.posts_raw),
        posts_source: apiPostsCount !== null ? 'web_profile_info' : 'og:description',
        posts_raw: apiPostsCount !== null ? String(apiPostsCount) : ogCounts.posts_raw,
        posts_returned: timeline.items.length,
        highlights: highlights.length
    };

    const statuses: Record<string, string> = {};
    const httpInfo: Record<string, any> = {};
    for (const [key, value] of Object.entries(snapshot.statuses)) {
        statuses[key] = value;
        httpInfo[key] = compact ? { ok: value === 'ok' } : snapshot.httpInfo[key];
    }

    const totalLikes = timeline.items.reduce((sum: number, post: any) => sum + (post.likes || 0), 0);
    const totalComments = timeline.items.reduce(
        (sum: number, post: any) => sum + (post.comments || 0),
        0
    );
    const videoPosts = timeline.items.filter((post: any) => post.media_types.includes('video'));

    return {
        status: true,
        partial: !snapshot.apiUser || Boolean(snapshot.degraded),
        message: snapshot.degraded
            ? 'Instagram memblokir IP server untuk halaman profil. Data tidak dapat diambil; hanya identitas username yang dikembalikan. Coba lagi nanti atau gunakan jaringan lain.'
            : undefined,
        data: {
            profile: {
                username: input.username,
                full_name: firstString(apiUser?.full_name, fullNameFromOg),
                id: firstString(apiUser?.id, apiUser?.pk),
                is_verified: apiUser?.is_verified ?? null,
                is_private: apiUser?.is_private ?? null,
                account_type: apiUser?.account_type ?? null,
                category: firstString(apiUser?.category, apiUser?.business_category_name),
                is_business: apiUser?.is_business ?? null,
                biography: apiUser?.biography ?? null,
                bio_links: Array.isArray(apiUser?.bio_links) ? apiUser.bio_links : [],
                external_url: apiUser?.external_url || null,
                profile_url: profileUrl,
                title_tag: (snapshot.ogHtml.match(/<title>([^<]*)<\/title>/i) || [])[1]
                    ? decodeEntities((snapshot.ogHtml.match(/<title>([^<]*)<\/title>/i) || [])[1])
                    : null,
                input_resolution: {
                    requested: input.raw,
                    type: input.source,
                    resolved_username: input.username
                }
            },
            avatar: {
                og_image: meta['og:image'] || null,
                api_url: apiUser?.profile_pic_url || null,
                api_hd_url: apiUser?.profile_pic_url_hd || null,
                host: (() => {
                    try {
                        return meta['og:image'] ? new URL(meta['og:image']).hostname : null;
                    } catch {
                        return null;
                    }
                })(),
                note: 'URL avatar Instagram bertanda tangan dan bisa kedaluwarsa.'
            },
            stats,
            timeline,
            highlights,
            derived: {
                username_length: input.username.length,
                og_description: ogDescription || null,
                og_description_length: ogDescription.length,
                canonical_url: canonicalUrl,
                locale_alternate_count: localeAlternates.length,
                locale_alternates: localeAlternates,
                meta_key_count: Object.keys(meta).length,
                og_keys: Object.keys(meta).filter((key) => key.startsWith('og:')),
                collected_post_count: timeline.items.length,
                avg_likes_per_collected_post:
                    timeline.items.length > 0 ? Math.round(totalLikes / timeline.items.length) : null,
                avg_comments_per_collected_post:
                    timeline.items.length > 0
                        ? Math.round(totalComments / timeline.items.length)
                        : null,
                video_post_count: videoPosts.length,
                note: 'Nilai di blok ini dihitung dari data yang berhasil dikumpulkan.'
            },
            technical: {
                endpoints: statuses,
                http: httpInfo,
                degraded: Boolean(snapshot.degraded),
                block_reason: snapshot.blockReason || null,
                block_detail: compact ? null : snapshot.blockDetail || null,
                cache: {
                    served_from: snapshot.servedFrom,
                    stale: Boolean(snapshot.stale),
                    fetched_at: new Date(snapshot.fetchedAt).toISOString(),
                    age_seconds: Math.round((Date.now() - snapshot.fetchedAt) / 1000),
                    ttl_seconds: Math.round(snapshot.cacheTtl / 1000),
                    api_cooldown_active: Date.now() < apiCooldownUntil,
                    og_cooldown_active: Date.now() < ogCooldownUntil,
                    note: snapshot.degraded
                        ? 'Mode degradasi: upstream diblokir, request dihentikan sementara (cooldown 5 menit) agar tidak menambah rate-limit.'
                        : 'Cache CDN (s-maxage) + cache memory + coalescing + fallback proxy dipakai agar Instagram tidak rate-limit.'
                },
                unavailable_public_endpoints: [
                    'nomor telepon & email (tidak dipublikasikan)',
                    'daftar follower / following (butuh login)',
                    'story (butuh login atau subscription)',
                    'like/comment per akun (butuh login)',
                    'bio & kategori tanpa web_profile_info (bisa kena cooldown 429)',
                    ...(snapshot.degraded
                        ? ['semua statistik & media: IP server diblokir Instagram']
                        : [])
                ],
                note: snapshot.degraded
                    ? 'Field kosong sengaja tidak diisi agar tidak mengarang data.'
                    : 'Data diambil dari halaman publik, fallback proxy baca publik, & endpoint web Instagram tanpa login.'
            },
            raw: {
                og_meta: meta,
                api_json: compact ? null : snapshot.apiJson,
                og_html: compact ? null : snapshot.ogHtml
            },
            accuracy: {
                sources: snapshot.sources,
                source_count: snapshot.sources.length,
                cross_check: {
                    username: input.username,
                    og_full_name: fullNameFromOg,
                    api_full_name: apiUser?.full_name || null,
                    full_name_match: Boolean(
                        fullNameFromOg && apiUser?.full_name && fullNameFromOg === apiUser.full_name
                    ),
                    followers: {
                        og: parseCompactNumber(ogCounts.followers_raw),
                        api: apiFollowers,
                        match:
                            apiFollowers !== null &&
                            parseCompactNumber(ogCounts.followers_raw) !== null &&
                            Math.abs(
                                apiFollowers - (parseCompactNumber(ogCounts.followers_raw) || 0)
                            ) /
                                Math.max(apiFollowers, 1) <
                                0.02
                    },
                    posts: {
                        og: parseCompactNumber(ogCounts.posts_raw),
                        api: apiPostsCount,
                        match:
                            apiPostsCount !== null &&
                            parseCompactNumber(ogCounts.posts_raw) === apiPostsCount
                    }
                },
                note: snapshot.degraded
                    ? 'Tidak ada cross-check karena upstream tidak bisa diakses dari server.'
                    : 'OG (langsung atau proxy) dipakai sebagai fallback bila web_profile_info gagal/429.'
            },
            source: profileUrl
        }
    };
}

function send(
    res: Response,
    snapshot: Snapshot,
    input: HandlerInput,
    servedFrom?: Snapshot['servedFrom']
) {
    const effective: Snapshot = servedFrom ? { ...snapshot, servedFrom } : snapshot;

    if (!effective.ok) {
        res.setHeader(
            'Cache-Control',
            `public, max-age=0, s-maxage=${Math.round(effective.cacheTtl / 1000)}`
        );
        res.setHeader('X-IG-Cache', effective.servedFrom);
        return res.status(effective.statusCode).json(effective.errorBody);
    }

    res.setHeader(
        'Cache-Control',
        `public, max-age=0, s-maxage=${Math.round(effective.cacheTtl / 1000)}, stale-while-revalidate=600`
    );
    res.setHeader('X-IG-Cache', effective.servedFrom);
    res.setHeader('X-IG-Upstream', effective.sources.join(',') || 'none');
    return res.json(buildSuccessBody(effective, input));
}

export default async function instagramProfileHandler(req: Request, res: Response) {
    const raw = String(
        req.query.username ?? req.query.user ?? req.query.url ?? req.body?.username ?? ''
    ).trim();

    if (!raw) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({
            status: false,
            message:
                "Parameter 'username' diperlukan (contoh: instagram atau https://www.instagram.com/instagram/)"
        });
    }

    let parsed: InstagramInput;
    try {
        parsed = normalizeInstagramInput(raw);
    } catch (error: any) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(400).json({ status: false, message: error?.message || 'Username tidak valid' });
    }

    const compactRaw = String(req.query.compact ?? req.body?.compact ?? '');
    const input: HandlerInput = {
        ...parsed,
        raw,
        compact: compactRaw === '1' || compactRaw === 'true',
        compactRaw
    };

    const withApi = !input.compact;
    const key = `${parsed.username}:${withApi ? 'full' : 'compact'}`;
    const cached = snapshotCache.get(key);
    if (cached && Date.now() < cached.expires) {
        return send(res, cached.snapshot, input, 'cache');
    }

    let pending = inflight.get(key);
    if (!pending) {
        pending = loadSnapshot(parsed.username, key, withApi).finally(() => inflight.delete(key));
        inflight.set(key, pending);
    }

    try {
        const snapshot = await pending;
        return send(res, snapshot, input);
    } catch (error: any) {
        res.setHeader('Cache-Control', 'no-store');
        return res.status(500).json({
            status: false,
            message: 'Gagal mengambil profil Instagram.',
            detail: error?.message || String(error)
        });
    }
}
