import { Request, Response } from 'express';
import axios from 'axios';

const TIKWM_API = 'https://www.tikwm.com/api/';
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

interface TikwmAuthor {
    id?: string;
    unique_id?: string;
    nickname?: string;
    avatar?: string;
}

interface TikwmData {
    id: string;
    title: string;
    region?: string;
    duration: number;
    cover?: string;
    origin_cover?: string;
    play?: string;
    wmplay?: string;
    hdplay?: string;
    size?: number;
    wm_size?: number;
    hd_size?: number;
    music?: string;
    play_count?: number;
    digg_count?: number;
    comment_count?: number;
    share_count?: number;
    collect_count?: number;
    create_time?: number;
    author?: TikwmAuthor;
}

interface TikwmResponse {
    code: number;
    msg: string;
    processed_time?: number;
    data?: TikwmData;
}

function normalizeTiktokUrl(raw: string): string {
    let value = raw.trim();
    if (!/^https?:\/\//i.test(value)) value = `https://${value}`;

    let parsed: URL;
    try {
        parsed = new URL(value);
    } catch {
        throw new Error('Format URL tidak valid');
    }

    if (!/(^|\.)tiktok\.com$/i.test(parsed.hostname)) {
        throw new Error('URL harus berasal dari TikTok (tiktok.com)');
    }

    return parsed.toString();
}

function isHdRequested(value: unknown): boolean {
    return value === '1' || value === 'true' || value === true;
}

export default async function tiktokHandler(req: Request, res: Response) {
    const rawUrl = (req.query.url || req.body?.url) as string | undefined;

    if (!rawUrl) {
        return res.status(400).json({ status: false, message: "Parameter 'url' diperlukan" });
    }

    let url: string;
    try {
        url = normalizeTiktokUrl(rawUrl);
    } catch (error: any) {
        return res.status(400).json({ status: false, message: error?.message || 'URL tidak valid' });
    }

    try {
        const hd = isHdRequested(req.query.hd);

        const { data } = await axios.get<TikwmResponse>(TIKWM_API, {
            params: hd ? { url, hd: 1 } : { url },
            timeout: 30000,
            headers: {
                'User-Agent': USER_AGENT,
                'Accept': 'application/json'
            }
        });

        if (data.code !== 0 || !data.data) {
            throw new Error(data.msg || 'Gagal mengambil data video TikTok');
        }

        const video = data.data;
        const noWatermark = video.play || video.hdplay;

        if (!noWatermark) {
            throw new Error('Link download tanpa watermark tidak ditemukan');
        }

        return res.json({
            status: true,
            data: {
                id: video.id,
                title: video.title,
                author: video.author ? {
                    username: video.author.unique_id || null,
                    nickname: video.author.nickname || null,
                    avatar: video.author.avatar || null
                } : null,
                duration: video.duration,
                cover: video.cover || null,
                no_watermark: noWatermark,
                hd_no_watermark: video.hdplay || null,
                with_watermark: video.wmplay || null,
                music: video.music || null,
                size: video.size || null,
                stats: {
                    play: video.play_count || 0,
                    like: video.digg_count || 0,
                    comment: video.comment_count || 0,
                    share: video.share_count || 0,
                    collect: video.collect_count || 0
                },
                created_at: video.create_time ? new Date(video.create_time * 1000).toISOString() : null,
                source: url
            }
        });
    } catch (error: any) {
        const message = axios.isAxiosError(error)
            ? 'Gagal terhubung ke layanan scraper TikTok'
            : (error?.message || 'Gagal memproses video TikTok');

        return res.status(500).json({ status: false, message });
    }
}
