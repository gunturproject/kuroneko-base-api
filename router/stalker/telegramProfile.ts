import { Request, Response } from 'express';
import axios from 'axios';

/*
 * Scrape profil Telegram publik via username.
 *
 * Sumber: halaman publik t.me (main), preview /s/<username> (channel/group),
 * dan widget embed. Semua data diambil dari apa yang Telegram tampilkan ke
 * publik — tanpa login, tanpa bot token.
 *
 * USER  : username, nama, avatar, deep link, OG/Twitter meta, HTTP metadata.
 * CHANNEL/GROUP: ditambah bio, verified, counter (subscriber/photo/video/link),
 *                dan postingan lengkap (reaksi, forward, reply, link preview,
 *                photo/video URL, views, tanggal, data-view token).
 */

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

interface TelegramInput {
    username: string;
    source: string;
}

interface PageFields {
    title: string | null;
    description: string | null;
    extra: string | null;
    photo: string | null;
    action: string | null;
}

interface Meta {
    [key: string]: string | null;
}

function normalizeTelegramInput(raw: string): TelegramInput {
    let value = raw.trim();

    if (/^https?:\/\//i.test(value)) {
        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            throw new Error('Format URL tidak valid');
        }
        if (!/(^|\.)t\.me$/i.test(parsed.hostname) && !/(^|\.)telegram\.me$/i.test(parsed.hostname)) {
            throw new Error('URL harus berasal dari Telegram (t.me / telegram.me)');
        }
        const parts = parsed.pathname.split('/').filter(Boolean);
        if (!parts.length) throw new Error('Username tidak ditemukan di URL tersebut');
        value = decodeURIComponent(parts[0]);
    }

    value = value.replace(/^@+/, '').replace(/^\/+|\/+$/g, '').trim();

    if (!/^[A-Za-z0-9_]{5,32}$/.test(value)) {
        throw new Error('Username Telegram tidak valid (5-32 karakter: huruf, angka, underscore)');
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
    const re = /<meta[^>]+(?:property|name)\s*=\s*["']([^"']+)["'][^>]*content\s*=\s*["']([^"']*)["'][^>]*>/gi;
    const reAlt = /<meta[^>]+content\s*=\s*["']([^"']*)["'][^>]*(?:property|name)\s*=\s*["']([^"']+)["'][^>]*>/gi;
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

function pickClass(html: string, className: string): string | null {
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
        `<(?:div|span|a)[^>]+class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*>([\\s\\S]*?)<\\/(?:div|span|a)>`,
        'i'
    );
    const match = html.match(re);
    return match ? stripTags(match[1]) || null : null;
}

function pickAttr(html: string, className: string, attr: string): string | null {
    const escaped = className.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`<[^>]+class=["'][^"']*\\b${escaped}\\b[^"']*["'][^>]*`, 'i');
    const tag = html.match(re)?.[0];
    if (!tag) return null;
    const value = tag.match(new RegExp(`${attr}\\s*=\\s*["']([^"']+)["']`, 'i'))?.[1];
    return value ? decodeEntities(value) : null;
}

function bgUrl(chunk: string, classHint?: string): string | null {
    if (!classHint) {
        return (
            chunk.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i)?.[1] || null
        );
    }
    const re = new RegExp(
        `class=["'][^"']*${classHint}[^"']*["'][^>]*background-image\\s*:\\s*url\\(["']?([^"')]+)["']?\\)`,
        'i'
    );
    const reAlt = new RegExp(
        `background-image\\s*:\\s*url\\(["']?([^"')]+)["']?\\)[\\s\\S]{0,200}?class=["'][^"']*${classHint}`,
        'i'
    );
    return chunk.match(re)?.[1] || chunk.match(reAlt)?.[1] || null;
}

function parseCompactNumber(value: string | null): number | null {
    if (!value) return null;
    const cleaned = value.replace(/\u00a0/g, ' ').trim().toLowerCase();
    const match = cleaned.match(/^([\d\s.,]+)\s*([kmb])?$/);
    if (!match) return null;

    const unit = match[2] || '';
    let digits = match[1].replace(/\s/g, '');

    if (unit) {
        // Notasi padat Telegram pakai titik sebagai desimal: 9.95M, 17.3K.
        const separators = digits.match(/[.,]/g) || [];
        digits = separators.length > 1 ? digits.replace(/[.,]/g, '') : digits.replace(',', '.');
    } else {
        // Angka penuh pakai spasi/titik/koma sebagai pemisah ribuan.
        digits = digits.replace(/[.,]/g, '');
    }

    const base = Number(digits);
    if (!Number.isFinite(base)) return null;
    const multiplier = unit === 'b' ? 1e9 : unit === 'm' ? 1e6 : unit === 'k' ? 1e3 : 1;
    return Math.round(base * multiplier);
}

function parseViewToken(raw: string | null): Record<string, any> | null {
    if (!raw) return null;
    try {
        const decoded = Buffer.from(raw, 'base64').toString('utf-8');
        return JSON.parse(decoded);
    } catch {
        return null;
    }
}

function parseReactions(chunk: string): {
    items: Array<{ emoji: string | null; emoji_id: string | null; count_raw: string; count: number | null; paid: boolean }>;
    total: number;
    paid_total: number;
} {
    const items: Array<{
        emoji: string | null;
        emoji_id: string | null;
        count_raw: string;
        count: number | null;
        paid: boolean;
    }> = [];
    const re = /<span class="(tgme_reaction[^"]*)"[^>]*>([\s\S]*?)<\/span>/gi;
    let match: RegExpExecArray | null;

    while ((match = re.exec(chunk)) !== null) {
        const paid = /paid/i.test(match[1]);
        const inner = match[2];
        const emojiId = inner.match(/emoji-id=["']([^"']+)["']/)?.[1] || null;
        const emoji =
            inner.match(/<b>([^<]+)<\/b>/)?.[1] ||
            (paid ? '⭐' : null) ||
            null;
        const countRaw = stripTags(inner).trim();
        const count = parseCompactNumber(countRaw);
        if (!countRaw) continue;
        items.push({ emoji, emoji_id: emojiId, count_raw: countRaw, count, paid });
    }

    return {
        items,
        total: items.reduce((sum, item) => sum + (item.count || 0), 0),
        paid_total: items
            .filter((item) => item.paid)
            .reduce((sum, item) => sum + (item.count || 0), 0)
    };
}

function parseLinkPreview(chunk: string) {
    const block = chunk.match(
        /<a class="tgme_widget_message_link_preview"[\s\S]*?<\/a>/i
    )?.[0] || null;
    if (!block) return null;
    return {
        url: block.match(/href=["']([^"']+)["']/)?.[1] || null,
        site_name: pickClass(block, 'link_preview_site_name'),
        title: pickClass(block, 'link_preview_title'),
        description: pickClass(block, 'link_preview_description'),
        image: bgUrl(block, 'link_preview_image')
    };
}

function parsePosts(html: string, limit: number) {
    if (!html || html.includes('tgme_widget_message_error')) return [];
    const chunks = html.split('<div class="tgme_widget_message_wrap');
    const posts: Record<string, any>[] = [];

    for (const chunk of chunks.slice(1)) {
        if (posts.length >= limit) break;
        const dataPost = chunk.match(/data-post=["']([^"']+)["']/)?.[1] || null;
        const dataView = chunk.match(/data-view=["']([^"']+)["']/)?.[1] || null;
        const textRaw = chunk.match(
            /<div class="tgme_widget_message_text[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<div class="tgme_widget_message_footer/i
        )?.[1] || null;
        const viewsRaw = chunk.match(/<span class="tgme_widget_message_views">([^<]+)<\/span>/)?.[1] || null;
        const date = chunk.match(/<time datetime=["']([^"']+)["']/)?.[1] || null;
        const author = pickClass(chunk, 'tgme_widget_message_author_name') || pickClass(chunk, 'tgme_widget_message_owner_name');
        const edited = /,&nbsp;edited/i.test(chunk);

        const forwardedFrom = pickClass(chunk, 'tgme_widget_message_forwarded_from_name');
        const replyBlock = chunk.match(
            /<a class="tgme_widget_message_reply[^"]*"[^>]*href=["']([^"']+)["'][\s\S]*?<\/a>/
        )?.[0] || null;
        const reply = replyBlock
            ? {
                  url: replyBlock.match(/href=["']([^"']+)["']/)?.[1] || null,
                  author: pickClass(replyBlock, 'tgme_widget_message_author_name'),
                  text: pickClass(replyBlock, 'tgme_widget_message_text')
              }
            : null;

        const reactions = parseReactions(chunk);
        const photo = bgUrl(chunk, 'tgme_widget_message_photo_wrap');
        const videoThumb = bgUrl(chunk, 'tgme_widget_message_video_thumb');
        const videoUrl = chunk.match(/<video[^>]+src=["']([^"']+)["']/i)?.[1] || null;
        const linkPreview = parseLinkPreview(chunk);
        const textHtml = textRaw
            ? textRaw.replace(/<div class="tgme_widget_message_actions[\s\S]*$/i, ' ')
            : null;
        const text = textHtml ? stripTags(textHtml) : null;

        const mediaTypes: string[] = [];
        if (photo) mediaTypes.push('photo');
        if (videoUrl || videoThumb) mediaTypes.push('video');
        if (linkPreview) mediaTypes.push('link_preview');
        if (chunk.includes('tgme_widget_message_document_wrap')) mediaTypes.push('document');
        if (chunk.includes('tgme_widget_message_sticker')) mediaTypes.push('sticker');
        if (chunk.includes('tgme_widget_message_voice')) mediaTypes.push('voice');

        if (!dataPost && !text && !date) continue;

        posts.push({
            id: dataPost ? dataPost.split('/').pop() || null : null,
            post_url: dataPost ? `https://t.me/${dataPost}` : null,
            text,
            text_length: text ? text.length : 0,
            views: parseCompactNumber(viewsRaw),
            views_raw: viewsRaw?.trim() || null,
            posted_at: date,
            author,
            edited,
            forwarded_from: forwardedFrom,
            reply,
            reactions: reactions.items,
            reaction_total: reactions.total,
            reaction_paid_total: reactions.paid_total,
            link_preview: linkPreview,
            media: {
                types: Array.from(new Set(mediaTypes)),
                has_media: mediaTypes.length > 0,
                photo_url: photo,
                video_thumb_url: videoThumb,
                video_url: videoUrl
            },
            view_token: dataView,
            view_token_decoded: parseViewToken(dataView)
        });
    }
    return posts;
}

function parseChannelInfo(html: string) {
    if (!html) return null;
    const counters: Record<string, { raw: string; value: number | null }> = {};
    const re = /<div class="tgme_channel_info_counter">\s*<span class="counter_value">([^<]*)<\/span>\s*<span class="counter_type">([^<]*)<\/span>/gi;
    let match: RegExpExecArray | null;
    while ((match = re.exec(html)) !== null) {
        counters[match[2].trim().toLowerCase()] = {
            raw: match[1].trim(),
            value: parseCompactNumber(match[1])
        };
    }

    return {
        title: pickClass(html, 'tgme_channel_info_header_title'),
        username: pickClass(html, 'tgme_channel_info_header_username'),
        verified: /<div class="tgme_channel_info_header_labels">[\s\S]{0,200}?verified-icon/i.test(html),
        description: pickClass(html, 'tgme_channel_info_description'),
        counters,
        oldest_loaded_post_id: html.match(/data-before=["'](\d+)["']/)?.[1] || null,
        preview_bytes: html.length
    };
}

function statusOf(result: PromiseSettledResult<unknown>): string {
    if (result.status === 'fulfilled') return 'ok';
    return axios.isAxiosError(result.reason) && result.reason.response
        ? `HTTP ${result.reason.response.status}`
        : 'error';
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
    const v = result.value as any;
    const headers = v?.headers || {};
    return {
        ok: Boolean(v?.status >= 200 && v?.status < 300),
        status: v?.status ?? null,
        status_text: v?.statusText || null,
        url: v?.config?.url || null,
        final_url: v?.request?.res?.responseUrl || null,
        content_type: headers['content-type'] || null,
        body_bytes: v?.data ? String(v.data).length : null
    };
}

export default async function telegramProfileHandler(req: Request, res: Response) {
    const raw = String(
        req.query.username ?? req.query.user ?? req.query.url ?? req.body?.username ?? ''
    ).trim();

    if (!raw) {
        return res.status(400).json({
            status: false,
            message:
                "Parameter 'username' diperlukan (contoh: turzzxroot908 atau https://t.me/turzzxroot908)"
        });
    }

    let input: TelegramInput;
    try {
        input = normalizeTelegramInput(raw);
    } catch (error: any) {
        return res.status(400).json({
            status: false,
            message: error?.message || 'Username tidak valid'
        });
    }

    const compact =
        req.query.compact === '1' ||
        req.query.compact === 'true' ||
        req.body?.compact === true ||
        req.body?.compact === '1';

    const baseUrl = `https://t.me/${input.username}`;
    const headers = {
        'User-Agent': UA,
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9'
    };

    try {
        const [mainRes, embedRes] = await Promise.allSettled([
            axios.get<string>(baseUrl, { timeout: 25000, responseType: 'text', headers }),
            axios.get<string>(`${baseUrl}?embed=1`, {
                timeout: 25000,
                responseType: 'text',
                headers
            })
        ]);

        const mainHtml = mainRes.status === 'fulfilled' ? String(mainRes.value?.data ?? '') : '';
        const embedHtml = embedRes.status === 'fulfilled' ? String(embedRes.value?.data ?? '') : '';

        if (!mainHtml || !/<title>Telegram:\s*(?:Contact|View)/i.test(mainHtml)) {
            return res.status(404).json({
                status: false,
                message: `Username Telegram '@${input.username}' tidak ditemukan atau tidak tersedia.`
            });
        }

        const meta = pickMeta(mainHtml);
        const fields: PageFields = {
            title: pickClass(mainHtml, 'tgme_page_title'),
            description: pickClass(mainHtml, 'tgme_page_description'),
            extra: pickClass(mainHtml, 'tgme_page_extra'),
            photo: pickAttr(mainHtml, 'tgme_page_photo_image', 'src'),
            action: pickClass(mainHtml, 'tgme_page_action')
        };

        const embedIsUser = /Channel with username[\s\S]{0,120}not found/i.test(embedHtml);
        const hasDescription = Boolean(fields.description);
        const extraSubscribers = fields.extra?.match(/([\d.,\s\u00a0]+)\s+subscribers?/i)?.[1] || null;
        const extraMembers = fields.extra?.match(/([\d.,\s\u00a0]+)\s+members?/i)?.[1] || null;
        const extraOnline = fields.extra?.match(/([\d.,\s\u00a0]+)\s+online/i)?.[1] || null;
        const channelLike =
            hasDescription ||
            Boolean(extraSubscribers) ||
            Boolean(extraMembers) ||
            /subscribers?|members?/i.test(fields.extra || '');
        const accountType =
            embedIsUser || !channelLike
                ? 'user'
                : /group|members?/i.test(fields.extra || '')
                  ? 'group'
                  : 'channel';

        let previewHtml = '';
        let previewRes: PromiseSettledResult<unknown> | null = null;
        if (accountType !== 'user') {
            const result = await axios
                .get<string>(`https://t.me/s/${input.username}`, {
                    timeout: 30000,
                    responseType: 'text',
                    headers
                })
                .then(
                    (value) => ({ status: 'fulfilled', value } as PromiseSettledResult<unknown>),
                    (reason) => ({ status: 'rejected', reason } as PromiseSettledResult<unknown>)
                );
            previewRes = result;
            previewHtml = result.status === 'fulfilled' ? String((result.value as any)?.data ?? '') : '';
        }

        const channelInfo = parseChannelInfo(previewHtml);
        const posts = parsePosts(previewHtml, compact ? 10 : 50);
        const avatarUrl = fields.photo || meta['og:image'] || null;
        const displayName =
            fields.title ||
            channelInfo?.title ||
            meta['og:title']?.replace(/^Telegram:\s*(?:Contact|View)\s*@?[^\s]*\s*/i, '').trim() ||
            meta['og:title'] ||
            null;

        const subscriberCount =
            parseCompactNumber(extraSubscribers) ||
            parseCompactNumber(extraMembers) ||
            channelInfo?.counters?.subscribers?.value ||
            null;

        const endpointResults: Record<string, PromiseSettledResult<unknown>> = {
            profile_page: mainRes,
            embed_widget: embedRes
        };
        if (previewRes) endpointResults.channel_preview = previewRes;

        const statuses: Record<string, string> = {};
        const httpInfo: Record<string, any> = {};
        for (const [key, result] of Object.entries(endpointResults)) {
            statuses[key] = statusOf(result);
            httpInfo[key] = compact ? { ok: result.status === 'fulfilled' } : httpOf(result);
        }

        const sources = Object.keys(endpointResults).filter(
            (key) => endpointResults[key].status === 'fulfilled'
        );
        const totalViews = posts.reduce((sum: number, post) => sum + (post.views || 0), 0);
        const totalReactions = posts.reduce((sum: number, post) => sum + (post.reaction_total || 0), 0);
        const reactions: Record<string, number> = {};
        for (const post of posts) {
            for (const reaction of post.reactions || []) {
                const key = String(reaction.emoji || reaction.emoji_id || 'unknown');
                reactions[key] = (reactions[key] || 0) + (reaction.count || 0);
            }
        }
        const topReactions = Object.entries(reactions)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 10)
            .map(([emoji, count]) => ({ emoji, count }));

        return res.json({
            status: true,
            partial: sources.length < Object.keys(endpointResults).length,
            data: {
                profile: {
                    username: input.username,
                    display_name: displayName,
                    account_type: accountType,
                    verified: Boolean(channelInfo?.verified),
                    profile_url: baseUrl,
                    deep_link: `tg://resolve?domain=${input.username}`,
                    bio: fields.description || channelInfo?.description || null,
                    title_tag: (mainHtml.match(/<title>([^<]*)<\/title>/i) || [])[1] || null,
                    action_label: fields.action,
                    input_resolution: {
                        requested: raw,
                        type: input.source,
                        resolved_username: input.username
                    }
                },
                avatar: {
                    url: avatarUrl,
                    og_image: meta['og:image'] || null,
                    preview_image: channelInfo ? pickAttr(previewHtml, 'tgme_page_photo_image', 'src') : null,
                    alternate_urls: avatarUrl
                        ? [
                              `https://t.me/i/userpic/160/${input.username}.jpg`,
                              `https://t.me/i/userpic/320/${input.username}.jpg`
                          ]
                        : [],
                    host: (() => {
                        try {
                            return avatarUrl ? new URL(avatarUrl).hostname : null;
                        } catch {
                            return null;
                        }
                    })(),
                    note: 'alternate_urls adalah pola URL avatar Telegram; ketersediaannya bisa berbeda.'
                },
                stats: {
                    subscribers: subscriberCount,
                    subscribers_raw:
                        extraSubscribers?.trim() ||
                        extraMembers?.trim() ||
                        channelInfo?.counters?.subscribers?.raw ||
                        null,
                    members: parseCompactNumber(extraMembers),
                    members_raw: extraMembers?.trim() || null,
                    online: parseCompactNumber(extraOnline),
                    online_raw: extraOnline?.trim() || null,
                    channel_counters: channelInfo?.counters || null,
                    posts_returned: posts.length,
                    total_views_in_sample: totalViews,
                    total_reactions_in_sample: totalReactions,
                    posts_with_media: posts.filter((post) => post.media.has_media).length,
                    posts_with_reactions: posts.filter((post) => post.reaction_total > 0).length,
                    posts_forwarded: posts.filter((post) => Boolean(post.forwarded_from)).length,
                    posts_with_reply: posts.filter((post) => Boolean(post.reply)).length
                },
                contact: {
                    telegram_url: baseUrl,
                    deep_link: `tg://resolve?domain=${input.username}`,
                    note: 'Hanya kontak publik. Nomor telepon tidak dipublikasikan untuk username.'
                },
                channel_info: channelInfo,
                posts,
                derived: {
                    username_length: input.username.length,
                    page_bytes: mainHtml.length,
                    preview_bytes: previewHtml.length,
                    meta_key_count: Object.keys(meta).length,
                    twitter_meta_keys: Object.keys(meta).filter((key) => key.startsWith('twitter:')),
                    avg_views_per_post: posts.length > 0 ? Math.round(totalViews / posts.length) : null,
                    avg_reactions_per_post: posts.length > 0 ? Math.round(totalReactions / posts.length) : null,
                    top_reactions: topReactions,
                    note: 'Semua nilai di blok ini dihitung, bukan field mentah Telegram.'
                },
                technical: {
                    account_type_detection: {
                        embed_says_user: embedIsUser,
                        has_description: hasDescription,
                        extra_text: fields.extra,
                        result: accountType
                    },
                    endpoints: statuses,
                    http: httpInfo,
                    unavailable_public_endpoints: [
                        'phone number (tidak dipublikasikan untuk username)',
                        'online status user (hanya tersedia di dalam akun Telegram)',
                        'pesan user biasa (chat pribadi tidak publik)'
                    ],
                    note: 'Data diambil dari halaman publik t.me tanpa login.'
                },
                raw: {
                    og_meta: meta,
                    page_fields: fields,
                    embed_widget: compact ? null : embedHtml,
                    channel_preview: compact ? null : previewHtml || null
                },
                accuracy: {
                    sources,
                    source_count: sources.length,
                    cross_check: {
                        requested_username: input.username,
                        og_title: meta['og:title'] || null,
                        page_title: fields.title,
                        preview_title: channelInfo?.title || null,
                        title_match: Boolean(
                            fields.title && meta['og:title'] && fields.title === meta['og:title']
                        )
                    },
                    note: 'Nama diverifikasi dari og:title, tgme_page_title, dan judul preview channel.'
                },
                source: baseUrl
            }
        });
    } catch (error: any) {
        const timeout =
            axios.isAxiosError(error) &&
            (error.code === 'ECONNABORTED' || String(error.message).includes('timeout'));

        return res.status(timeout ? 504 : 500).json({
            status: false,
            message: timeout
                ? 'Telegram terlalu lama merespons. Coba lagi.'
                : 'Gagal mengambil profil Telegram.',
            detail: 'internal_error'
        });
    }
}
