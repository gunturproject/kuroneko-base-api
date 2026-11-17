import { Request, Response } from 'express';
import axios from 'axios';

/*
 * Scrape profil Roblox publik via username ATAU userId.
 *
 * Sumber: endpoint API publik Roblox (users / friends / thumbnails /
 * groups / games / presence / avatar). Tidak butuh login atau cookie.
 *
 * Beberapa endpoint (badges, collectibles, friends list, name history)
 * butuh auth & sengaja tidak dipakai supaya endpoint tetap jalan tanpa
 * kredensial. Lihat technical.unavailable_public_endpoints.
 */

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const API = {
    users: 'https://users.roblox.com/v1',
    friends: 'https://friends.roblox.com/v1',
    thumbnails: 'https://thumbnails.roblox.com/v1',
    groups: 'https://groups.roblox.com/v1',
    games: 'https://games.roblox.com/v2',
    gamesV1: 'https://games.roblox.com/v1',
    presence: 'https://presence.roblox.com/v1',
    avatar: 'https://avatar.roblox.com/v1'
};

const PRESENCE_LABELS: Record<number, string> = {
    0: 'Offline',
    1: 'Online',
    2: 'In Game',
    3: 'In Studio',
    4: 'Invisible'
};

const HEADSHOT_SIZES = ['48x48', '100x100', '150x150', '420x420'] as const;

interface RobloxUser {
    id?: number;
    name?: string;
    displayName?: string;
    description?: string | null;
    created?: string;
    isBanned?: boolean;
    externalAppDisplayName?: string | null;
    hasVerifiedBadge?: boolean;
    previousUsernames?: string[];
}

interface RobloxSearchEntry {
    id?: number;
    name?: string;
    displayName?: string;
    hasVerifiedBadge?: boolean;
    previousUsernames?: string[];
}

interface RobloxInput {
    id?: number;
    username?: string;
    source: string;
}

function normalizeRobloxInput(raw: string): RobloxInput {
    let value = raw.trim();

    if (/^https?:\/\//i.test(value)) {
        let parsed: URL;
        try {
            parsed = new URL(value);
        } catch {
            throw new Error('Format URL tidak valid');
        }
        if (!/(^|\.)roblox\.com$/i.test(parsed.hostname)) {
            throw new Error('URL harus berasal dari Roblox (roblox.com)');
        }
        const idMatch = parsed.pathname.match(/\/users\/(\d+)/i);
        if (idMatch) return { id: Number(idMatch[1]), source: 'url_user_id' };
        const nameMatch = parsed.pathname.match(/\/users\/([A-Za-z0-9_]{3,20})/i);
        if (nameMatch) return { username: nameMatch[1], source: 'url_username' };
        throw new Error('Username / userId tidak ditemukan di URL tersebut');
    }

    value = value.replace(/^@+/, '').replace(/^.*\/users\//i, '').replace(/\/.*$/, '').trim();

    if (/^\d+$/.test(value)) return { id: Number(value), source: 'numeric_input' };

    if (!/^[A-Za-z0-9_]{3,20}$/.test(value)) {
        throw new Error('Username Roblox tidak valid (3-20 karakter: huruf, angka, underscore)');
    }

    return { username: value, source: 'username_input' };
}

function labelPresence(type: unknown): string | null {
    const n = Number(type);
    return Number.isFinite(n) ? PRESENCE_LABELS[n] || `Unknown (${n})` : null;
}

function toNumber(value: unknown): number {
    const n = Number(value ?? 0);
    return Number.isFinite(n) ? n : 0;
}

function round(value: number, digits = 2): number {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
}

function uniqueList(values: string[]): string[] {
    return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function derivedImageUrls(headshot: string | null): Record<string, string | null> {
    if (!headshot) {
        return Object.fromEntries(HEADSHOT_SIZES.map((size) => [size, null]));
    }
    return Object.fromEntries(
        HEADSHOT_SIZES.map((size) => [size, headshot.replace(/\/\d+x\d+\//, `/${size}/`)])
    );
}

function statusOf(result: PromiseSettledResult<unknown>): string {
    if (result.status === 'fulfilled') return 'ok';
    const message =
        axios.isAxiosError(result.reason) && result.reason.response
            ? `HTTP ${result.reason.response.status}`
            : 'error';
    return message;
}

function dataOf<T = any>(result: PromiseSettledResult<unknown>): T | null {
    if (result.status !== 'fulfilled') return null;
    const value = result.value as any;
    return (value?.data as T) ?? null;
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
    const rawLength = headers['content-length'];
    return {
        ok: Boolean(v?.status >= 200 && v?.status < 300),
        status: v?.status ?? null,
        status_text: v?.statusText || null,
        url: v?.config?.url || null,
        content_type: headers['content-type'] || null,
        content_length: rawLength !== undefined ? toNumber(rawLength) : null,
        body_bytes: v?.data ? JSON.stringify(v.data).length : null
    };
}

async function getWithRetry<T>(
    url: string,
    config: Record<string, any>,
    attempts = 3
): Promise<{ data: T }> {
    for (let attempt = 0; attempt < attempts; attempt++) {
        try {
            return await axios.get<T>(url, config);
        } catch (error) {
            const retryable =
                axios.isAxiosError(error) &&
                (error.response?.status === 429 || toNumber(error.response?.status) >= 500);
            if (!retryable || attempt === attempts - 1) throw error;
            await new Promise((resolve) => setTimeout(resolve, 400 * (attempt + 1)));
        }
    }
    throw new Error('Retry tidak berhasil');
}

function assetTypeCounts(assets: unknown[]): Record<string, number> {
    const counts: Record<string, number> = {};
    for (const asset of assets) {
        const name = String((asset as Record<string, any>)?.assetType?.name || 'Unknown');
        counts[name] = (counts[name] || 0) + 1;
    }
    return counts;
}

export default async function robloxProfileHandler(req: Request, res: Response) {
    const raw = String(
        req.query.username ?? req.query.user ?? req.query.url ?? req.body?.username ?? ''
    ).trim();

    if (!raw) {
        return res.status(400).json({
            status: false,
            message:
                "Parameter 'username' diperlukan (contoh: jandel atau https://www.roblox.com/id/users/10916243/profile)"
        });
    }

    let input: RobloxInput;
    try {
        input = normalizeRobloxInput(raw);
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

    const jsonHeaders = {
        'User-Agent': UA,
        Accept: 'application/json, text/plain, */*',
        'Accept-Language': 'en-US,en;q=0.9',
        Referer: 'https://www.roblox.com/'
    };

    try {
        // ---- Resolve username -> userId (kalau belum ada id) ----
        let userId = input.id || null;
        let searchData: Record<string, any> | null = null;
        let searchEntries: RobloxSearchEntry[] = [];
        let exactMatch: boolean | null = null;

        if (!userId && input.username) {
            const search = await getWithRetry<Record<string, any>>(
                `${API.users}/users/search`,
                {
                    params: { keyword: input.username, limit: 10 },
                    timeout: 20000,
                    headers: jsonHeaders
                }
            );
            searchData = search.data || null;
            searchEntries = Array.isArray(search.data?.data) ? search.data.data : [];

            const exact = searchEntries.find(
                (entry) => String(entry.name || '').toLowerCase() === input.username!.toLowerCase()
            );
            const fallback =
                exact ||
                searchEntries.find(
                    (entry) =>
                        String(entry.displayName || '').toLowerCase() ===
                        input.username!.toLowerCase()
                ) ||
                searchEntries[0];

            if (fallback?.id) {
                userId = Number(fallback.id);
                exactMatch = Boolean(
                    String(exact?.name || fallback.name || '').toLowerCase() ===
                        input.username.toLowerCase()
                );
            }
        }

        if (!userId) {
            return res.status(404).json({
                status: false,
                message: `User Roblox '${input.username || raw}' tidak ditemukan.`,
                suggestions: searchEntries.map((entry) => ({
                    id: entry.id || null,
                    username: entry.name || null,
                    display_name: entry.displayName || null,
                    verified: Boolean(entry.hasVerifiedBadge)
                }))
            });
        }

        // ---- Fetch semua data publik secara paralel ----
        const thumbRequest = (size: string) =>
            axios.get<Record<string, any>>(`${API.thumbnails}/users/avatar-headshot`, {
                params: { userIds: userId, size, format: 'Png', isCircular: false },
                timeout: 20000,
                headers: jsonHeaders
            });

        const [
            userRes,
            friendsRes,
            followersRes,
            followingsRes,
            avatarRes,
            bustRes,
            groupsRes,
            gamesRes,
            presenceRes,
            wearingRes,
            outfitsRes,
            thumb48Res,
            thumb100Res,
            thumb150Res
        ] = await Promise.allSettled([
            axios.get<RobloxUser>(`${API.users}/users/${userId}`, {
                timeout: 20000,
                headers: jsonHeaders
            }),
            axios.get<{ count: number }>(`${API.friends}/users/${userId}/friends/count`, {
                timeout: 20000,
                headers: jsonHeaders
            }),
            axios.get<{ count: number }>(`${API.friends}/users/${userId}/followers/count`, {
                timeout: 20000,
                headers: jsonHeaders
            }),
            axios.get<{ count: number }>(`${API.friends}/users/${userId}/followings/count`, {
                timeout: 20000,
                headers: jsonHeaders
            }),
            axios.get<Record<string, any>>(`${API.thumbnails}/users/avatar-headshot`, {
                params: { userIds: userId, size: '420x420', format: 'Png', isCircular: false },
                timeout: 20000,
                headers: jsonHeaders
            }),
            axios.get<Record<string, any>>(`${API.thumbnails}/users/avatar-bust`, {
                params: { userIds: userId, size: '150x150', format: 'Png', isCircular: false },
                timeout: 20000,
                headers: jsonHeaders
            }),
            axios.get<Record<string, any>>(`${API.groups}/users/${userId}/groups/roles`, {
                timeout: 30000,
                headers: jsonHeaders
            }),
            axios.get<Record<string, any>>(`${API.games}/users/${userId}/games`, {
                params: { limit: 50, sortOrder: 'Desc', isFavorite: false },
                timeout: 30000,
                headers: jsonHeaders
            }),
            axios.post<Record<string, any>>(
                `${API.presence}/presence/users`,
                { userIds: [userId] },
                {
                    timeout: 20000,
                    headers: { ...jsonHeaders, 'Content-Type': 'application/json' }
                }
            ),
            axios.get<Record<string, any>>(`${API.avatar}/users/${userId}/avatar`, {
                timeout: 20000,
                headers: jsonHeaders
            }),
            axios.get<Record<string, any>>(`${API.avatar}/users/${userId}/outfits`, {
                params: { page: 1, itemsPerPage: 50 },
                timeout: 20000,
                headers: jsonHeaders
            }),
            thumbRequest('48x48'),
            thumbRequest('100x100'),
            thumbRequest('150x150')
        ]);

        const user = dataOf<RobloxUser>(userRes);
        if (!user || !user.id) {
            return res.status(502).json({
                status: false,
                message: 'Gagal mengambil data user Roblox.',
                detail: `user endpoint: ${statusOf(userRes)}`
            });
        }

        // ---- Game detail + votes (butuh universeId dari games) ----
        const gamesFull = dataOf<Record<string, any>>(gamesRes)?.data || [];
        const universeIds = gamesFull
            .map((game: Record<string, any>) => toNumber(game?.id))
            .filter((id: number) => id > 0);
        const universeParam = universeIds.join(',');

        let detailRes: PromiseSettledResult<unknown> | null = null;
        let votesRes: PromiseSettledResult<unknown> | null = null;

        if (universeParam) {
            [detailRes, votesRes] = await Promise.allSettled([
                axios.get<Record<string, any>>(`${API.gamesV1}/games`, {
                    params: { universeIds: universeParam },
                    timeout: 30000,
                    headers: jsonHeaders
                }),
                axios.get<Record<string, any>>(`${API.gamesV1}/games/votes`, {
                    params: { universeIds: universeParam },
                    timeout: 30000,
                    headers: jsonHeaders
                })
            ]);
        }

        const resolvedId = user.id;
        const resolvedUsername = user.name || input.username || String(resolvedId);
        const profileUrl = `https://www.roblox.com/id/users/${resolvedId}/profile`;

        const friendCount = toNumber(dataOf<{ count: number }>(friendsRes)?.count);
        const followerCount = toNumber(dataOf<{ count: number }>(followersRes)?.count);
        const followingCount = toNumber(dataOf<{ count: number }>(followingsRes)?.count);

        const headshotUrl = dataOf<Record<string, any>>(avatarRes)?.data?.[0]?.imageUrl || null;
        const bustEntry = dataOf<Record<string, any>>(bustRes)?.data?.[0] || null;

        const realSizes: Record<string, string | null> = {
            '420x420': headshotUrl
        };
        const thumbResults: Record<string, PromiseSettledResult<unknown>> = {
            '48x48': thumb48Res,
            '100x100': thumb100Res,
            '150x150': thumb150Res
        };
        for (const [size, result] of Object.entries(thumbResults)) {
            realSizes[size] = dataOf<Record<string, any>>(result)?.data?.[0]?.imageUrl || null;
        }
        const sizeFallbacks = derivedImageUrls(headshotUrl);
        for (const size of HEADSHOT_SIZES) {
            if (!realSizes[size]) realSizes[size] = sizeFallbacks[size];
        }

        // ---- Avatar wearing & outfits ----
        const wearingFull = dataOf<Record<string, any>>(wearingRes);
        const wearingAssets: Record<string, any>[] = Array.isArray(wearingFull?.assets)
            ? wearingFull.assets
            : [];
        const outfitsFull = dataOf<Record<string, any>>(outfitsRes);
        const outfits: Record<string, any>[] = Array.isArray(outfitsFull?.data)
            ? outfitsFull.data
            : [];

        // ---- Game detail + votes digabung per experience ----
        const detailPayload = detailRes ? dataOf<Record<string, any>>(detailRes) : null;
        const votesPayload = votesRes ? dataOf<Record<string, any>>(votesRes) : null;
        const detailList: Record<string, any>[] = Array.isArray(detailPayload?.data)
            ? detailPayload!.data
            : [];
        const votesList: Record<string, any>[] = Array.isArray(votesPayload?.data)
            ? votesPayload!.data
            : [];
        const detailMap = new Map(detailList.map((item) => [toNumber(item?.id), item]));
        const votesMap = new Map(votesList.map((item) => [toNumber(item?.id), item]));

        const experiencesMerged = gamesFull.map((game: Record<string, any>) => {
            const id = toNumber(game?.id);
            const detail = detailMap.get(id) || {};
            const vote = votesMap.get(id) || {};
            const up = toNumber(vote?.upVotes);
            const down = toNumber(vote?.downVotes);
            const totalVotes = up + down;
            return {
                id: id || null,
                name: game?.name ?? detail?.name ?? null,
                description: game?.description ?? detail?.description ?? null,
                creator: detail?.creator || game?.creator || null,
                root_place: game?.rootPlace || null,
                root_place_id: toNumber(detail?.rootPlaceId) || toNumber(game?.rootPlace?.id) || null,
                created: game?.created ?? detail?.created ?? null,
                updated: game?.updated ?? detail?.updated ?? null,
                place_visits: toNumber(detail?.visits) || toNumber(game?.placeVisits),
                currently_playing: toNumber(detail?.playing),
                max_players: toNumber(detail?.maxPlayers),
                genre: detail?.genre || detail?.untranslated_genre_l1 || null,
                universe_avatar_type: detail?.universeAvatarType || null,
                favorited_count: toNumber(detail?.favoritedCount),
                canonical_url_path: detail?.canonicalUrlPath || null,
                copying_allowed: Boolean(detail?.copyingAllowed),
                price: detail?.price ?? null,
                votes: {
                    up: up,
                    down: down,
                    total: totalVotes,
                    approval_percent: totalVotes > 0 ? round((up / totalVotes) * 100, 2) : null,
                    note: 'approval_percent dihitung (up / (up+down)), bukan rating resmi Roblox.'
                }
            };
        });

        const totalUpvotes = experiencesMerged.reduce(
            (sum: number, game: Record<string, any>) => sum + toNumber(game?.votes?.up),
            0
        );
        const totalDownvotes = experiencesMerged.reduce(
            (sum: number, game: Record<string, any>) => sum + toNumber(game?.votes?.down),
            0
        );
        const totalFavorites = experiencesMerged.reduce(
            (sum: number, game: Record<string, any>) => sum + toNumber(game?.favorited_count),
            0
        );
        const totalPlaying = experiencesMerged.reduce(
            (sum: number, game: Record<string, any>) => sum + toNumber(game?.currently_playing),
            0
        );
        const placeVisits = experiencesMerged.reduce(
            (sum: number, game: Record<string, any>) => sum + toNumber(game?.place_visits),
            0
        );

        const topGames = [...experiencesMerged]
            .sort(
                (a: Record<string, any>, b: Record<string, any>) =>
                    toNumber(b?.place_visits) - toNumber(a?.place_visits)
            )
            .slice(0, 5);

        // ---- Groups ----
        const groupsFull = dataOf<Record<string, any>>(groupsRes)?.data || [];
        const groups = compact ? groupsFull.slice(0, 20) : groupsFull;
        const rankCounts: Record<string, number> = {};
        let largestGroup: Record<string, any> | null = null;
        for (const entry of groupsFull) {
            const rank = String(entry?.role?.name || 'Unknown');
            rankCounts[rank] = (rankCounts[rank] || 0) + 1;
            const memberCount = toNumber(entry?.group?.memberCount);
            if (!largestGroup || memberCount > toNumber(largestGroup?.group?.memberCount)) {
                largestGroup = entry;
            }
        }

        const presenceEntry = dataOf<Record<string, any>>(presenceRes)?.userPresences?.[0] || null;
        const presenceType = toNumber(presenceEntry?.userPresenceType);

        const createdMs = user.created ? Date.parse(user.created) : NaN;
        const ageDays = Number.isFinite(createdMs)
            ? Math.floor(Math.max(0, Date.now() - createdMs) / 86_400_000)
            : null;

        const endpointResults: Record<string, PromiseSettledResult<unknown>> = {
            users: userRes,
            friends_count: friendsRes,
            followers_count: followersRes,
            followings_count: followingsRes,
            avatar_headshot: avatarRes,
            avatar_bust: bustRes,
            avatar_wearing: wearingRes,
            avatar_outfits: outfitsRes,
            headshot_48: thumb48Res,
            headshot_100: thumb100Res,
            headshot_150: thumb150Res,
            groups: groupsRes,
            games: gamesRes,
            presence: presenceRes
        };
        if (detailRes) endpointResults.game_details = detailRes;
        if (votesRes) endpointResults.game_votes = votesRes;

        const sources = Object.keys(endpointResults).filter(
            (key) => endpointResults[key].status === 'fulfilled'
        );
        const statuses: Record<string, string> = {};
        const httpInfo: Record<string, any> = {};
        for (const [key, result] of Object.entries(endpointResults)) {
            statuses[key] = statusOf(result);
            httpInfo[key] = compact
                ? { ok: result.status === 'fulfilled', status: statusOf(result) }
                : httpOf(result);
        }

        const nameMatches =
            input.username && user.name
                ? String(user.name).toLowerCase() === input.username.toLowerCase()
                : null;

        return res.json({
            status: true,
            partial: sources.length < Object.keys(endpointResults).length,
            data: {
                profile: {
                    id: resolvedId,
                    username: resolvedUsername,
                    display_name: user.displayName || null,
                    profile_url: profileUrl,
                    description: user.description || null,
                    verified: Boolean(user.hasVerifiedBadge),
                    banned: Boolean(user.isBanned),
                    external_app_display_name: user.externalAppDisplayName || null,
                    previous_usernames: uniqueList(
                        (user.previousUsernames || []).map((name) => String(name))
                    ),
                    created_at: user.created || null,
                    created_at_unix: Number.isFinite(createdMs) ? createdMs : null,
                    input_resolution: {
                        requested: raw,
                        type: input.source,
                        exact_username_match: exactMatch,
                        search_result_name_matches_user: nameMatches
                    }
                },
                stats: {
                    friends: friendCount,
                    followers: followerCount,
                    followings: followingCount,
                    groups: groupsFull.length,
                    experiences_returned: gamesFull.length,
                    total_place_visits: placeVisits,
                    total_favorited: totalFavorites,
                    total_upvotes: totalUpvotes,
                    total_downvotes: totalDownvotes,
                    currently_playing: totalPlaying,
                    avatar_assets_worn: wearingAssets.length,
                    outfits: outfits.length,
                    formatted: {
                        followers:
                            followerCount >= 1_000_000
                                ? `${(followerCount / 1_000_000).toFixed(1)}M`
                                : followerCount >= 1_000
                                    ? `${(followerCount / 1_000).toFixed(1)}K`
                                    : String(followerCount)
                    }
                },
                avatar: {
                    headshot: headshotUrl,
                    bust: bustEntry?.imageUrl || null,
                    headshot_state: dataOf<Record<string, any>>(avatarRes)?.data?.[0]?.state || null,
                    bust_state: bustEntry?.state || null,
                    version:
                        dataOf<Record<string, any>>(avatarRes)?.data?.[0]?.version ||
                        bustEntry?.version ||
                        null,
                    sizes_real: realSizes,
                    sizes_derived: derivedImageUrls(headshotUrl),
                    wearing: {
                        player_avatar_type: wearingFull?.playerAvatarType || null,
                        scales: wearingFull?.scales || null,
                        body_colors: wearingFull?.bodyColors || null,
                        asset_count: wearingAssets.length,
                        asset_type_counts: assetTypeCounts(wearingAssets),
                        assets: compact
                            ? wearingAssets.slice(0, 25)
                            : wearingAssets.map((asset) => ({
                                  id: asset?.id ?? null,
                                  name: asset?.name ?? null,
                                  asset_type_id: asset?.assetType?.id ?? null,
                                  asset_type: asset?.assetType?.name ?? null,
                                  current_version_id: asset?.currentVersionId ?? null
                              }))
                    },
                    outfits: {
                        count: toNumber(outfitsFull?.total ?? outfitsFull?.filteredCount ?? outfits.length),
                        returned: outfits.length,
                        items: compact
                            ? outfits.slice(0, 10)
                            : outfits.map((outfit) => ({
                                  id: outfit?.id ?? null,
                                  name: outfit?.name ?? null,
                                  created: outfit?.created ?? null,
                                  updated: outfit?.updated ?? null,
                                  is_editable: Boolean(outfit?.isEditable)
                              }))
                    },
                    note: 'sizes_real berasal dari request thumbnail terpisah per ukuran; sizes_derived adalah fallback dari URL 420x420.'
                },
                presence: {
                    type: presenceType,
                    status: labelPresence(presenceType),
                    is_online: presenceType === 1 || presenceType === 2,
                    last_location: presenceEntry?.lastLocation || null,
                    place_id: presenceEntry?.placeId || null,
                    root_place_id: presenceEntry?.rootPlaceId || null,
                    game_id: presenceEntry?.gameId || null,
                    universe_id: presenceEntry?.universeId || null
                },
                groups: {
                    count: groupsFull.length,
                    returned: groups.length,
                    rank_counts: rankCounts,
                    largest_group: largestGroup
                        ? {
                              id: largestGroup?.group?.id ?? null,
                              name: largestGroup?.group?.name ?? null,
                              member_count: toNumber(largestGroup?.group?.memberCount),
                              role: largestGroup?.role?.name ?? null,
                              rank: toNumber(largestGroup?.role?.rank)
                          }
                        : null,
                    items: groups.map((entry: Record<string, any>) => ({
                        id: entry?.group?.id ?? null,
                        name: entry?.group?.name ?? null,
                        description: entry?.group?.description ?? null,
                        member_count: toNumber(entry?.group?.memberCount),
                        public_entry_allowed: Boolean(entry?.group?.publicEntryAllowed),
                        builders_club_only: Boolean(entry?.group?.isBuildersClubOnly),
                        verified: Boolean(entry?.group?.hasVerifiedBadge),
                        owner: entry?.group?.owner
                            ? {
                                  id: entry.group.owner.userId ?? null,
                                  username: entry.group.owner.username ?? null,
                                  display_name: entry.group.owner.displayName ?? null
                              }
                          : null,
                        shout: entry?.group?.shout || null,
                        role: {
                            id: entry?.role?.id ?? null,
                            name: entry?.role?.name ?? null,
                            rank: toNumber(entry?.role?.rank),
                            is_base: Boolean(entry?.role?.isBase),
                            color: entry?.role?.color ?? null
                        }
                    }))
                },
                experiences: {
                    count_returned: gamesFull.length,
                    total_place_visits: placeVisits,
                    total_favorited: totalFavorites,
                    total_upvotes: totalUpvotes,
                    total_downvotes: totalDownvotes,
                    top_by_visits: topGames,
                    items: compact
                        ? experiencesMerged.slice(0, 10)
                        : experiencesMerged
                },
                derived: {
                    account_age: {
                        days: ageDays,
                        years: ageDays !== null ? round(ageDays / 365.25) : null
                    },
                    followers_per_friend:
                        friendCount > 0 ? round(followerCount / friendCount) : null,
                    avg_place_visits_per_experience:
                        gamesFull.length > 0 ? round(placeVisits / gamesFull.length) : null,
                    overall_vote_approval_percent:
                        totalUpvotes + totalDownvotes > 0
                            ? round((totalUpvotes / (totalUpvotes + totalDownvotes)) * 100)
                            : null,
                    avatar_asset_types: assetTypeCounts(wearingAssets),
                    group_rank_top: Object.entries(rankCounts)
                        .sort((a, b) => b[1] - a[1])
                        .slice(0, 10)
                        .map(([rank, count]) => ({ rank, count })),
                    note: 'Semua nilai di blok ini dihitung, bukan field mentah Roblox.'
                },
                technical: {
                    resolved_user_id: resolvedId,
                    input_source: input.source,
                    compact,
                    endpoints: statuses,
                    http: httpInfo,
                    unavailable_public_endpoints: [
                        'badges (401 - butuh authentication token)',
                        'collectibles (403 - inventory privat)',
                        'friends list (403 - butuh session Roblox)',
                        'name-history (404 - endpoint tidak tersedia publik)'
                    ],
                    note: 'Endpoint di atas butuh auth/session Roblox, jadi sengaja tidak dipakai.'
                },
                raw: {
                    user,
                    search: compact ? null : searchData,
                    search_suggestions: searchEntries.map((entry) => ({
                        id: entry.id || null,
                        username: entry.name || null,
                        display_name: entry.displayName || null,
                        verified: Boolean(entry.hasVerifiedBadge),
                        previous_usernames: entry.previousUsernames || []
                    })),
                    friends_count: dataOf(friendsRes),
                    followers_count: dataOf(followersRes),
                    followings_count: dataOf(followingsRes),
                    avatar_headshot: dataOf(avatarRes),
                    avatar_bust: dataOf(bustRes),
                    avatar_wearing: compact ? null : wearingFull,
                    avatar_outfits: compact ? null : outfitsFull,
                    groups: compact ? groupsFull.slice(0, 20) : groupsFull,
                    games: compact ? gamesFull.slice(0, 10) : gamesFull,
                    game_details: compact
                        ? detailList.slice(0, 10)
                        : detailRes
                          ? detailList
                          : null,
                    game_votes: compact ? votesList.slice(0, 10) : votesRes ? votesList : null,
                    presence: dataOf(presenceRes)
                },
                accuracy: {
                    sources,
                    source_count: sources.length,
                    total_sources: Object.keys(endpointResults).length,
                    cross_check: {
                        requested_username: input.username || null,
                        resolved_username: resolvedUsername,
                        resolved_id: resolvedId,
                        exact_match: nameMatches,
                        search_exact_match: exactMatch
                    },
                    note: 'Username di-resolve lewat users/search divalidasi ulang ke endpoint users by id.'
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
                ? 'Roblox terlalu lama merespons. Coba lagi.'
                : 'Gagal mengambil profil Roblox.',
            detail: error?.message || String(error)
        });
    }
}
