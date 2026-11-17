import { Request, Response } from 'express';
import axios from 'axios';

/*
 * Scrape profil Roblox publik via username ATAU userId.
 *
 * Sumber: endpoint API publik Roblox (users / friends / thumbnails /
 * groups / games / presence). Tidak butuh login atau cookie.
 *
 * Beberapa endpoint (badges, collectibles, friend list) butuh auth &
 * sengaja tidak dipakai supaya endpoint ini tetap jalan tanpa kredensial.
 */

const UA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

const API = {
    users: 'https://users.roblox.com/v1',
    friends: 'https://friends.roblox.com/v1',
    thumbnails: 'https://thumbnails.roblox.com/v1',
    groups: 'https://groups.roblox.com/v1',
    games: 'https://games.roblox.com/v2',
    presence: 'https://presence.roblox.com/v1'
};

const PRESENCE_LABELS: Record<number, string> = {
    0: 'Offline',
    1: 'Online',
    2: 'In Game',
    3: 'In Studio',
    4: 'Invisible'
};

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

function uniqueList(values: string[]): string[] {
    return Array.from(new Set(values.map((v) => v.trim()).filter(Boolean)));
}

function derivedImageUrls(headshot: string | null): Record<string, string | null> {
    if (!headshot) {
        return {
            '48x48': null,
            '100x100': null,
            '150x150': null,
            '250x250': null,
            '420x420': null
        };
    }
    const sizes = ['48x48', '100x100', '150x150', '250x250', '420x420'];
    return Object.fromEntries(
        sizes.map((size) => [size, headshot.replace(/\/\d+x\d+\//, `/${size}/`)])
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
        'Accept-Language': 'en-US,en;q=0.9'
    };

    try {
        // ---- Resolve username -> userId (kalau belum ada id) ----
        let userId = input.id || null;
        let searchData: Record<string, any> | null = null;
        let searchEntries: RobloxSearchEntry[] = [];
        let exactMatch: boolean | null = null;

        if (!userId && input.username) {
            const search = await axios.get<Record<string, any>>(
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
        const [userRes, friendsRes, followersRes, followingsRes, avatarRes, bustRes, groupsRes, gamesRes, presenceRes] =
            await Promise.allSettled([
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
                    { timeout: 20000, headers: { ...jsonHeaders, 'Content-Type': 'application/json' } }
                )
            ]);

        const user = dataOf<RobloxUser>(userRes);
        if (!user || !user.id) {
            return res.status(502).json({
                status: false,
                message: 'Gagal mengambil data user Roblox.',
                detail: `user endpoint: ${statusOf(userRes)}`
            });
        }

        const resolvedId = user.id;
        const resolvedUsername = user.name || input.username || String(resolvedId);
        const profileUrl = `https://www.roblox.com/id/users/${resolvedId}/profile`;

        const friendCount = toNumber(dataOf<{ count: number }>(friendsRes)?.count);
        const followerCount = toNumber(dataOf<{ count: number }>(followersRes)?.count);
        const followingCount = toNumber(dataOf<{ count: number }>(followingsRes)?.count);

        const avatarEntry = dataOf<Record<string, any>>(avatarRes)?.data?.[0] || null;
        const bustEntry = dataOf<Record<string, any>>(bustRes)?.data?.[0] || null;
        const headshotUrl = avatarEntry?.imageUrl || null;

        const groupsFull = dataOf<Record<string, any>>(groupsRes)?.data || [];
        const gamesFull = dataOf<Record<string, any>>(gamesRes)?.data || [];
        const groups = compact ? groupsFull.slice(0, 20) : groupsFull;
        const games = compact ? gamesFull.slice(0, 10) : gamesFull;

        const presenceEntry = dataOf<Record<string, any>>(presenceRes)?.userPresences?.[0] || null;
        const presenceType = toNumber(presenceEntry?.userPresenceType);

        const createdMs = user.created ? Date.parse(user.created) : NaN;
        const ageDays = Number.isFinite(createdMs)
            ? Math.floor(Math.max(0, Date.now() - createdMs) / 86_400_000)
            : null;

        const placeVisits = gamesFull.reduce(
            (sum: number, game: Record<string, any>) => sum + toNumber(game?.placeVisits),
            0
        );
        const topGames = [...gamesFull]
            .sort((a: Record<string, any>, b: Record<string, any>) =>
                toNumber(b?.placeVisits) - toNumber(a?.placeVisits)
            )
            .slice(0, 5)
            .map((game: Record<string, any>) => ({
                id: game?.id ?? null,
                name: game?.name ?? null,
                place_id: game?.rootPlace?.id ?? null,
                created: game?.created ?? null,
                updated: game?.updated ?? null,
                place_visits: toNumber(game?.placeVisits)
            }));

        const rankCounts: Record<string, number> = {};
        for (const entry of groupsFull) {
            const rank = String(entry?.role?.name || 'Unknown');
            rankCounts[rank] = (rankCounts[rank] || 0) + 1;
        }

        const sources: string[] = [];
        if (userRes.status === 'fulfilled') sources.push('users');
        if (friendsRes.status === 'fulfilled') sources.push('friends');
        if (followersRes.status === 'fulfilled') sources.push('followers');
        if (followingsRes.status === 'fulfilled') sources.push('followings');
        if (avatarRes.status === 'fulfilled') sources.push('avatar');
        if (bustRes.status === 'fulfilled') sources.push('bust');
        if (groupsRes.status === 'fulfilled') sources.push('groups');
        if (gamesRes.status === 'fulfilled') sources.push('games');
        if (presenceRes.status === 'fulfilled') sources.push('presence');

        const nameMatches =
            input.username && user.name
                ? String(user.name).toLowerCase() === input.username.toLowerCase()
                : null;

        return res.json({
            status: true,
            partial: sources.length < 9,
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
                    headshot_state: avatarEntry?.state || null,
                    bust_state: bustEntry?.state || null,
                    version: avatarEntry?.version || bustEntry?.version || null,
                    derived_sizes: derivedImageUrls(headshotUrl),
                    note: 'derived_sizes adalah URL headshot yang sama dengan ukuran diubah; bukan endpoint terpisah.'
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
                    top_by_visits: topGames,
                    items: games.map((game: Record<string, any>) => ({
                        id: game?.id ?? null,
                        name: game?.name ?? null,
                        description: game?.description ?? null,
                        creator: game?.creator || null,
                        root_place: game?.rootPlace || null,
                        created: game?.created ?? null,
                        updated: game?.updated ?? null,
                        place_visits: toNumber(game?.placeVisits)
                    }))
                },
                derived: {
                    account_age: {
                        days: ageDays,
                        years: ageDays !== null ? Number((ageDays / 365.25).toFixed(2)) : null
                    },
                    followers_per_friend:
                        friendCount > 0
                            ? Number((followerCount / friendCount).toFixed(2))
                            : null,
                    avg_place_visits_per_experience:
                        gamesFull.length > 0
                            ? Number((placeVisits / gamesFull.length).toFixed(2))
                            : null,
                    note: 'Semua nilai di blok ini dihitung, bukan field mentah Roblox.'
                },
                technical: {
                    resolved_user_id: resolvedId,
                    input_source: input.source,
                    compact,
                    endpoints: {
                        users: statusOf(userRes),
                        friends_count: statusOf(friendsRes),
                        followers_count: statusOf(followersRes),
                        followings_count: statusOf(followingsRes),
                        avatar_headshot: statusOf(avatarRes),
                        avatar_bust: statusOf(bustRes),
                        groups: statusOf(groupsRes),
                        games: statusOf(gamesRes),
                        presence: statusOf(presenceRes)
                    },
                    unavailable_public_endpoints: [
                        'badges (401 Unauthorized)',
                        'collectibles (403 Forbidden)',
                        'friends list (403 Forbidden)',
                        'name-history (404)'
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
                    groups: compact ? groupsFull.slice(0, 20) : groupsFull,
                    games: compact ? gamesFull.slice(0, 10) : gamesFull,
                    presence: dataOf(presenceRes)
                },
                accuracy: {
                    sources,
                    source_count: sources.length,
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
