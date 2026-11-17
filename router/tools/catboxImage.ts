import { Request, Response } from 'express';
import axios from 'axios';

/*
 * Fetch a Catbox image through our own origin so the browser can draw it into
 * a canvas without tainting it. Catbox does not send CORS headers, so a direct
 * cross-origin fetch would produce an opaque response.
 *
 * Vercel functions have a ~4.5MB response limit, therefore this proxy rejects
 * files larger than 3.5MB with a friendly message instead of a 502.
 */

const ALLOWED_HOSTS = new Set(['files.catbox.moe', 'litterbox.catbox.moe']);
const ALLOWED_MIMES = new Set([
    'image/png',
    'image/jpeg',
    'image/webp',
    'image/gif',
    'image/bmp'
]);
const MAX_BYTES = Math.floor(3.5 * 1024 * 1024);

export default async function catboxImageHandler(req: Request, res: Response) {
    const raw = String(req.query.url ?? '').trim();

    if (!raw) {
        return res.status(400).json({
            status: false,
            message: "Parameter 'url' diperlukan."
        });
    }

    let target: URL;
    try {
        target = new URL(raw);
    } catch {
        return res.status(400).json({
            status: false,
            message: 'URL tidak valid.'
        });
    }

    if (target.protocol !== 'https:' || !ALLOWED_HOSTS.has(target.hostname)) {
        return res.status(400).json({
            status: false,
            message: 'Link harus berupa URL gambar Catbox (files.catbox.moe).'
        });
    }

    if (!/^\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/.test(target.pathname)) {
        return res.status(400).json({
            status: false,
            message: 'Path link Catbox tidak dikenali.'
        });
    }

    try {
        const response = await axios.get<ArrayBuffer>(target.toString(), {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: MAX_BYTES,
            maxBodyLength: MAX_BYTES,
            headers: {
                Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
                'User-Agent': 'KuroNeko-Image-Upscaler/1.0'
            }
        });

        const buffer = Buffer.from(response.data);

        if (!buffer.length) {
            return res.status(502).json({
                status: false,
                message: 'Catbox mengembalikan file kosong.'
            });
        }

        if (buffer.length > MAX_BYTES) {
            return res.status(413).json({
                status: false,
                message: 'Gambar sumber terlalu besar (maks 3,5 MB).'
            });
        }

        const contentType = String(response.headers['content-type'] || '')
            .split(';')[0]
            .trim()
            .toLowerCase();

        if (!ALLOWED_MIMES.has(contentType)) {
            return res.status(415).json({
                status: false,
                message: 'Link itu bukan gambar yang didukung (PNG/JPG/WEBP/GIF/BMP).'
            });
        }

        res.setHeader('Content-Type', contentType);
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');

        return res.send(buffer);
    } catch (error) {
        const message = error instanceof Error ? error.message : '';

        if (message.includes('maxContentLength') || message.includes('maxBodyLength')) {
            return res.status(413).json({
                status: false,
                message: 'Gambar sumber terlalu besar (maks 3,5 MB).'
            });
        }

        if (axios.isAxiosError(error)) {
            if (error.response?.status === 404) {
                return res.status(404).json({
                    status: false,
                    message: 'Gambar tidak ditemukan di Catbox. Cek link-nya.'
                });
            }

            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                return res.status(504).json({
                    status: false,
                    message: 'Catbox terlalu lama merespons. Coba lagi.'
                });
            }
        }

        return res.status(502).json({
            status: false,
            message: 'Gagal mengambil gambar dari Catbox.'
        });
    }
}
