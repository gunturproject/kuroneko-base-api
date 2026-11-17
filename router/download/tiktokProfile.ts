import { Request, Response } from 'express';
import axios from 'axios';

/*
 * Scrape profil TikTok publik via username.
 *
 * Strategi 3 sumber + validasi silang supaya "lengkap & akurat":
 *  1. SSR blob mobile (`__UNIVERSAL_DATA_FOR_REHYDRATION__`)
 *     -> angka presisi dari `statsV2`, bio, avatar, dll.
 *  2. oEmbed resmi TikTok (`/oembed`)
 *     -> nickname & URL resmi, dipakai buat cross-check.
 *  3. OG meta (UA facebook bot)
 *     -> og:image, deep link, dan angka pembulatan buat cross-check.
 *
 * CATATAN:
 * - Desktop UA sering kena Slardar WAF -> pakai mobile Safari UA untuk SSR.
 * - `stats` = angka public yang dibulatkan; `statsV2` = angka presisi.
 * - `itemList` hampir selalu kosong untuk request tanpa login/signature.
 *   Kita tidak mengklaim daftar video lengkap; ditaruh di `content.videos_note`.
 */

const MOBILE_UA =
    'Mozilla/5.0 (iPhone; CPU iPhone OS 16_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/16.0 Mobile/15E148 Safari/604.1';
const DESKTOP_UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const SOCIAL_UA = 'facebookexternalhit/1.1 (+http://www.facebook.com/externalhit_uatext.php)';

interface TikTokStats {
    followerCount?: number | string;
    followingCount?: number | string;
    heart?: number | string;
    heartCount?: number | string;
    videoCount?: number | string;
    diggCount?: number | string;
    friendCount?: number | string;
}

interface TikTokUser {
    id?: string;
    shortId?: string;
    uniqueId?: string;
    nickname?: string;
    avatarLarger?: string;
    avatarMedium?: string;
    avatarThumb?: string;
    signature?: string;
    createTime?: number;
    verified?: boolean;
    secUid?: string;
    ftc?: boolean;
    privateAccount?: boolean;
    secret?: boolean;
    openFavorite?: boolean;
    bioLink?: { link?: string; risk?: number };
    commentSetting?: number;
    duetSetting?: number;
    stitchSetting?: number;
    commerceUserInfo?: { commerceUser?: boolean };
    ttSeller?: boolean;
    language?: string;
    isADVirtual?: boolean;
    profileTab?: Record<string, boolean>;
    relation?: number;
    roomId?: string;
    uniqueIdModifyTime?: number;
    downloadSetting?: number;
    followingVisibility?: number;
    recommendReason?: string;
    nowInvitationCardUrl?: string;
    nickNameModifyTime?: number;
    isEmbedBanned?: boolean;
    canExpPlaylist?: boolean;
    profileEmbedPermission?: number;
    eventList?: unknown[];
    suggestAccountBind?: boolean;
    isOrganization?: number;
    UserStoryStatus?: number;
    shortDramaCreator?: Record<string, unknown>;
}

interface TikTokDetail {
    userInfo?: {
        user?: TikTokUser;
        stats?: TikTokStats;
        statsV2?: TikTokStats;
        itemList?: unknown[];
    };
    shareMeta?: { title?: string; desc?: string };
    statusCode?: number;
    statusMsg?: string;
    needFix?: boolean;
}

interface TikTokScope {
    detail: TikTokDetail | null;
    seo: Record<string, any> | null;
    appContext: Record<string, any> | null;
    bizContext: Record<string, any> | null;
    waf: boolean;
}

interface OgMeta {
    title: string | null;
    description: string | null;
    image: string | null;
    url: string | null;
    androidUrl: string | null;
    iosUrl: string | null;
}

function normalizeUsername(raw: string): string {
    let value = raw.trim();

    if (/^https?:\/\//i.test(value)) {
        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            throw new Error('Format URL tidak valid');
        }
        if (!/(^|\.)tiktok\.com$/i.test(parsed.hostname)) {
            throw new Error('URL harus berasal dari TikTok (tiktok.com)');
        }
        const match = parsed.pathname.match(/^\/@?([A-Za-z0-9._]+)/);
        if (!match) {
            throw new Error('Username tidak ditemukan di URL tersebut');
        }
        value = match[1];
    }

    value = value.replace(/^@+/, '').replace(/\/.*$/, '').trim();

    if (!/^[A-Za-z0-9._]{2,24}$/.test(value)) {
        throw new Error(
            'Username TikTok tidak valid (2-24 karakter: huruf, angka, titik, underscore)'
        );
    }

    return value;
}

function toNumber(value: unknown): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
}

function statNumber(stats: TikTokStats | undefined, key: keyof TikTokStats): number {
    return toNumber(stats?.[key]);
}

function formatCount(value: number): string {
    if (value >= 1_000_000_000) return `${(value / 1_000_000_000).toFixed(1)}B`;
    if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
    if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
    return String(value);
}

function decodeEntities(value: string): string {
    return value
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
        .replace(/&#39;/g, "'")
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>');
}

function parseScope(html: string): TikTokScope {
    const result: TikTokScope = {
        detail: null,
        seo: null,
        appContext: null,
        bizContext: null,
        waf: /slardar-config|_wafchallengeid|Please wait\.\.\./i.test(html)
    };

    const match = html.match(
        /<script id="__UNIVERSAL_DATA_FOR_REHYDRATION__" type="application\/json">([\s\S]*?)<\/script>/
    );
    if (!match) return result;

    try {
        const scope = JSON.parse(match[1])?.__DEFAULT_SCOPE__ || {};
        const detail = scope['webapp.user-detail'] as TikTokDetail | undefined;

        if (detail?.userInfo?.user) {
            result.detail = detail;
            result.waf = false;
        }
        result.seo = scope['seo.abtest'] || null;
        result.appContext = scope['webapp.app-context'] || null;
        result.bizContext = scope['webapp.biz-context'] || null;
    } catch {
        // biarkan null; fallback akan menangani
    }

    return result;
}

function parseOg(html: string): OgMeta {
    const pick = (property: string): string | null => {
        const patterns = [
            new RegExp(`<meta[^>]+property=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i'),
            new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+property=["']${property}["']`, 'i'),
            new RegExp(`<meta[^>]+name=["']${property}["'][^>]+content=["']([^"']*)["']`, 'i')
        ];
        for (const re of patterns) {
            const m = html.match(re);
            if (m) return decodeEntities(m[1]);
        }
        return null;
    };

    return {
        title: pick('og:title'),
        description: pick('og:description'),
        image: pick('og:image'),
        url: pick('og:url'),
        androidUrl: pick('al:android:url'),
        iosUrl: pick('al:ios:url')
    };
}

async function fetchOEmbed(username: string): Promise<Record<string, any> | null> {
    try {
        const { data } = await axios.get<Record<string, any>>(
            'https://www.tiktok.com/oembed',
            {
                params: { url: `https://www.tiktok.com/@${username}` },
                timeout: 15000,
                headers: { 'User-Agent': DESKTOP_UA, Accept: 'application/json' }
            }
        );
        return data || null;
    } catch {
        return null;
    }
}

function shortNumberFromText(text: string | null | undefined, label: string): number | null {
    if (!text) return null;
    const m = text.match(new RegExp(`([\\d.]+)\\s*([KMB])?\\s*${label}`, 'i'));
    if (!m) return null;
    const base = Number(m[1]);
    const mult = String(m[2] || '').toUpperCase();
    if (!Number.isFinite(base)) return null;
    if (mult === 'M') return Math.round(base * 1_000_000);
    if (mult === 'K') return Math.round(base * 1_000);
    if (mult === 'B') return Math.round(base * 1_000_000_000);
    return Math.round(base);
}

function stripTitleSuffix(title: string | null): string | null {
    if (!title) return null;
    return title.replace(/\s+on TikTok\s*$/i, '').trim() || null;
}

function uniqueList(values: string[]): string[] {
    return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

/*
 * Kontak yang DIPAJANGKAN PEMILIK AKUN di bio — BUKAN kredensial login.
 * TikTok tidak pernah mengirim metode login / nomor terdaftar / email
 * terdaftar milik akun lain di response publik mana pun.
 */
function extractPublicContacts(signature: string | undefined, bioLink: string | undefined) {
    const text = signature || '';
    const emails = uniqueList(
        text.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g) || []
    );
    const links = uniqueList([
        ...(text.match(/https?:\/\/[^\s]+/g) || []),
        ...(text.match(/(?:^|\s)(?:www\.|linktr\.ee\/)[^\s]+/gi) || []),
        ...(bioLink ? [bioLink] : [])
    ]);
    const waLinks = uniqueList(text.match(/https?:\/\/wa\.me\/\d+/gi) || []);
    const phones = uniqueList(
        (text.match(/(?:\+?\d[\d\s().-]{7,}\d)/g) || [])
            .map((v) => v.replace(/[^\d+]/g, ''))
            .filter((v) => v.replace(/\D/g, '').length >= 8)
    );

    return {
        email_in_bio: emails,
        phone_in_bio: phones,
        whatsapp_in_bio: waLinks,
        links_in_bio: links,
        source: 'public_bio_signature',
        note: 'Ini kontak yang sengaja dipajang di bio. Bukan nomor/email yang dipakai saat daftar atau login.'
    };
}

export default async function tiktokProfileHandler(req: Request, res: Response) {
    const raw = String(
        req.query.username ?? req.query.user ?? req.query.url ?? req.body?.username ?? ''
    ).trim();

    if (!raw) {
        return res.status(400).json({
            status: false,
            message:
                "Parameter 'username' diperlukan (contoh: andrastyt atau https://www.tiktok.com/@andrastyt)"
        });
    }

    let username: string;
    try {
        username = normalizeUsername(raw);
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error?.message || 'Username tidak valid'
        });
    }

    const profileUrl = `https://www.tiktok.com/@${username}?lang=en`;
    const htmlHeaders = {
        'User-Agent': MOBILE_UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
    };

    try {
        // Fetch 3 sumber secara paralel. Kegagalan satu sumber tidak mematikan yang lain.
        const [ssrResult, ogResult, embedResult] = await Promise.allSettled([
            axios.get<string>(profileUrl, {
                timeout: 30000,
                responseType: 'text',
                headers: htmlHeaders
            }),
            axios.get<string>(profileUrl, {
                timeout: 20000,
                responseType: 'text',
                headers: { ...htmlHeaders, 'User-Agent': SOCIAL_UA }
            }),
            fetchOEmbed(username)
        ]);

        const ssrHtml =
            ssrResult.status === 'fulfilled'
                ? String(ssrResult.value?.data ?? '')
                : '';
        const ogHtml =
            ogResult.status === 'fulfilled' ? String(ogResult.value?.data ?? '') : '';
        const embed = embedResult.status === 'fulfilled' ? embedResult.value : null;

        const scope = parseScope(ssrHtml);
        const og = parseOg(ogHtml);
        const detail = scope.detail;

        if (!detail) {
            // Fallback parsial: pakai oEmbed + OG meta kalau keduanya tersedia
            const fallbackNickname =
                embed?.author_name || stripTitleSuffix(og.title) || null;
            const fallbackName = embed?.title || og.title || null;
            const fallbackUrl =
                embed?.author_url || og.url || `https://www.tiktok.com/@${username}`;

            if (fallbackNickname || fallbackName) {
                const sources: string[] = [];
                if (embed) sources.push('oembed');
                if (og.title) sources.push('og_meta');
                const warnings: string[] = [];
                if (scope.waf) warnings.push('TikTok menolak akses SSR (WAF challenge).');
                warnings.push('Statistik tidak tersedia tanpa SSR; hanya data dasar.');

                return res.json({
                    status: true,
                    partial: true,
                    warning: warnings.join(' '),
                    data: {
                        id: embed?.embed_product_id || null,
                        username: username,
                        nickname: fallbackNickname,
                        display_name: fallbackName,
                        profile_url: fallbackUrl,
                        verified: null,
                        avatar: { og_image: og.image || null },
                        bio: null,
                        bio_link: null,
                        stats: null,
                        content: { videos: [], videos_note: 'Statistik & video tidak tersedia.' },
                        sources,
                        source: profileUrl
                    }
                });
            }

            return res.status(502).json({
                status: false,
                message: scope.waf
                    ? 'TikTok menolak akses dari server ini (WAF challenge). Coba lagi nanti.'
                    : 'Gagal mengambil data profil TikTok.'
            });
        }

        const user = detail.userInfo!.user!;
        const stats = detail.userInfo!.stats;
        const statsV2 = detail.userInfo!.statsV2;
        const hasPrecise = Boolean(statsV2 && Object.keys(statsV2).length);
        const resolvedUsername = user.uniqueId || username;

        const followers = statNumber(statsV2, 'followerCount') || statNumber(stats, 'followerCount');
        const following = statNumber(statsV2, 'followingCount') || statNumber(stats, 'followingCount');
        const likes = statNumber(statsV2, 'heartCount') || statNumber(stats, 'heartCount');
        const videos = statNumber(statsV2, 'videoCount') || statNumber(stats, 'videoCount');
        const friends = statNumber(statsV2, 'friendCount') || statNumber(stats, 'friendCount');

        // ---- Validasi silang nickname ----
        const ssrNick = user.nickname || null;
        const oembedNick = embed?.author_name || null;
        const ogNick = stripTitleSuffix(og.title);
        const nickCandidates = [ssrNick, oembedNick, ogNick].filter(
            (v): v is string => typeof v === 'string' && v.length > 0
        );
        const nicknameMatch =
            nickCandidates.length >= 2 &&
            nickCandidates.every((v) => v.toLowerCase() === nickCandidates[0].toLowerCase());
        const canonicalNickname = ssrNick || oembedNick || ogNick || null;

        // ---- Validasi silang angka pembulatan (SSR shareMeta vs OG description) ----
        const ssrDesc = detail.shareMeta?.desc || null;
        const roundedMatch =
            ssrDesc && og.description
                ? ssrDesc.trim().toLowerCase() === og.description.trim().toLowerCase()
                : null;
        const ogFollowers = shortNumberFromText(og.description, 'Followers');
        const expectedRounded = formatCount(followers);
        const roundedFollowersMatch =
            ogFollowers !== null && ogFollowers > 0
                ? Math.abs(ogFollowers - followers) / followers < 0.02
                : null;

        const sourcesOk = ['ssr'];
        if (embed) sourcesOk.push('oembed');
        if (og.title || og.description) sourcesOk.push('og_meta');

        const confidence =
            hasPrecise && nicknameMatch && roundedMatch !== false
                ? 'high'
                : hasPrecise && sourcesOk.length >= 2
                    ? 'medium-high'
                    : hasPrecise
                        ? 'medium'
                        : 'low';

        const itemList = detail.userInfo!.itemList;
        const videoCount = Array.isArray(itemList) ? itemList.length : 0;
        const contacts = extractPublicContacts(user.signature, user.bioLink?.link);

        return res.json({
            status: true,
            partial: false,
            data: {
                profile: {
                    id: user.id || null,
                    sec_uid: user.secUid || null,
                    short_id: user.shortId || null,
                    username: resolvedUsername,
                    nickname: canonicalNickname,
                    display_name: canonicalNickname,
                    profile_url: `https://www.tiktok.com/@${resolvedUsername}`,
                    verified: Boolean(user.verified),
                    private_account: Boolean(user.privateAccount || user.secret),
                    avatar: {
                        larger: user.avatarLarger || null,
                        medium: user.avatarMedium || null,
                        thumb: user.avatarThumb || null,
                        og_image: og.image || null
                    },
                    bio: user.signature || null,
                    bio_link: user.bioLink?.link || null,
                    language: user.language || scope.appContext?.language || null,
                    region: scope.appContext?.region || null,
                    created_at: user.createTime
                        ? new Date(user.createTime * 1000).toISOString()
                        : null,
                    created_at_unix: user.createTime || null,
                    deep_link: {
                        android: og.androidUrl || null,
                        ios: og.iosUrl || null
                    }
                },
                region: {
                    // Bahasa yang disimpan akun (mis. "id" = Bahasa Indonesia).
                    account_language: user.language || null,
                    // Region yang terdeteksi TikTok dari IP server tempat request ini jalan.
                    request_region: scope.appContext?.region || null,
                    request_language: scope.appContext?.language || null,
                    cluster_region: scope.appContext?.clusterRegion || null,
                    host: scope.appContext?.host || null,
                    idc: scope.bizContext?.idc || null,
                    vregion: scope.bizContext?.vregion || null,
                    vgeo: scope.bizContext?.vgeo || null,
                    tea_channel: scope.bizContext?.domains?.teaChannel || null,
                    geo: Array.isArray(scope.bizContext?.geo) ? scope.bizContext!.geo : [],
                    geo_city: scope.bizContext?.geoCity || null,
                    subdivisions: Array.isArray(scope.bizContext?.subdivisions)
                        ? scope.bizContext!.subdivisions
                        : [],
                    os: scope.bizContext?.os || null,
                    is_mobile: Boolean(scope.bizContext?.isMobile),
                    detected_as_bot: Boolean(scope.bizContext?.isBot),
                    bot_type: scope.appContext?.botType || null,
                    note: 'account_language berasal dari data akun. Field request_* / idc / vregion / vgeo adalah region yang terdeteksi dari IP server, BUKAN lokasi domisili akun (TikTok tidak menyediakannya untuk profil publik).'
                },
                stats: {
                    followers,
                    following,
                    likes,
                    videos,
                    friends,
                    diggs: statNumber(statsV2, 'diggCount') || statNumber(stats, 'diggCount'),
                    formatted: {
                        followers: formatCount(followers),
                        following: formatCount(following),
                        likes: formatCount(likes),
                        videos: formatCount(videos),
                        friends: formatCount(friends)
                    },
                    raw: {
                        public_rounded: stats || null,
                        precise: hasPrecise ? statsV2 || null : stats || null
                    }
                },
                account: {
                    ftc: Boolean(user.ftc),
                    tt_seller: Boolean(user.ttSeller),
                    commerce_user: Boolean(user.commerceUserInfo?.commerceUser),
                    ad_virtual: Boolean(user.isADVirtual),
                    open_favorite: Boolean(user.openFavorite),
                    comment_setting: user.commentSetting ?? null,
                    duet_setting: user.duetSetting ?? null,
                    stitch_setting: user.stitchSetting ?? null,
                    download_setting: user.downloadSetting ?? null,
                    following_visibility: user.followingVisibility ?? null,
                    profile_embed_permission: user.profileEmbedPermission ?? null,
                    is_embed_banned: Boolean(user.isEmbedBanned),
                    can_exp_playlist: Boolean(user.canExpPlaylist),
                    profile_tab: user.profileTab || null,
                    is_organization: user.isOrganization ?? null,
                    short_drama_creator: user.shortDramaCreator || null,
                    relation: user.relation ?? null,
                    room_id: user.roomId || null,
                    unique_id_modify_time: user.uniqueIdModifyTime ?? null,
                    nickname_modify_time: user.nickNameModifyTime ?? null,
                    recommend_reason: user.recommendReason || null,
                    invitation_card_url: user.nowInvitationCardUrl || null,
                    event_list: Array.isArray(user.eventList) ? user.eventList : [],
                    suggest_account_bind: Boolean(user.suggestAccountBind),
                    story_status: user.UserStoryStatus ?? null
                },
                contact: contacts,
                login: {
                    method: null,
                    provider: null,
                    phone: null,
                    email: null,
                    registered_with: null,
                    two_factor_enabled: null,
                    available: false,
                    reason: 'Metode login, nomor terdaftar, dan email terdaftar adalah data privat. TikTok tidak mengirimkannya di profil publik/SSR/oEmbed; hanya pemilik akun yang bisa melihatnya di Settings and privacy. Aku sengaja mengembalikan null, bukan menebak.',
                    possible_values_if_available: [
                        'google',
                        'phone',
                        'email',
                        'facebook',
                        'apple',
                        'twitter',
                        'username_password'
                    ]
                },
                flags: {
                    verified: Boolean(user.verified),
                    private_account: Boolean(user.privateAccount || user.secret),
                    ftc: Boolean(user.ftc),
                    tt_seller: Boolean(user.ttSeller),
                    ad_virtual: Boolean(user.isADVirtual),
                    is_organization: Boolean(user.isOrganization),
                    is_embed_banned: Boolean(user.isEmbedBanned)
                },
                raw: {
                    user: user,
                    stats_public: stats || null,
                    stats_precise: hasPrecise ? statsV2 || null : null,
                    scope_keys: Object.keys({
                        'webapp.user-detail': detail,
                        'webapp.app-context': scope.appContext,
                        'webapp.biz-context': scope.bizContext,
                        'seo.abtest': scope.seo
                    }),
                    oembed: embed || null,
                    og_meta: og
                },
                content: {
                    videos: Array.isArray(itemList) ? itemList : [],
                    videos_count_returned: videoCount,
                    videos_note: videoCount
                        ? null
                        : 'TikTok tidak mengirim daftar video ke request tanpa login/signature (itemList kosong). Gunakan endpoint video TikTok untuk satu video jika dibutuhkan.',
                    seo: scope.seo
                        ? {
                              canonical: scope.seo.canonical || null,
                              page_id: scope.seo.pageId || null,
                              video_ids: Array.isArray(scope.seo.vidList)
                                  ? scope.seo.vidList
                                  : []
                          }
                        : null,
                    share: {
                        title: detail.shareMeta?.title || og.title || null,
                        description: ssrDesc || og.description || null,
                        og_description: og.description || null
                    }
                },
                accuracy: {
                    confidence,
                    numeric_source: hasPrecise
                        ? 'statsV2 (counter presisi TikTok)'
                        : 'stats (public, dibulatkan)',
                    sources: sourcesOk,
                    cross_check: {
                        nickname_match: nicknameMatch,
                        nickname_sources: {
                            ssr: ssrNick,
                            oembed: oembedNick,
                            og_meta: ogNick
                        },
                        rounded_description_match: roundedMatch,
                        og_followers_approx: ogFollowers,
                        expected_rounded: expectedRounded,
                        rounded_followers_within_2pct: roundedFollowersMatch
                    },
                    note: hasPrecise
                        ? 'Angka diambil dari statsV2 (presisi). Field formatted & raw disertakan untuk transparansi.'
                        : 'Hanya stats public yang tersedia; angka mungkin dibulatkan TikTok.'
                },
                source: profileUrl
            }
        });
    } catch (error: any) {
        const timeout =
            axios.isAxiosError(error) &&
            (error.code === 'ECONNABORTED' || String(error.message).includes('timeout'));

        return res.status(timeout ? 504 : 500).json({
            status: false,
            message: timeout
                ? 'TikTok terlalu lama merespons. Coba lagi.'
                : 'Gagal mengambil profil TikTok.',
            detail: error?.message || String(error)
        });
    }
}
