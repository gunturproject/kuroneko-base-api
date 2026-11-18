import { Request, Response } from 'express';
import sharp from 'sharp';

/*
 * Fetch a photo from Catbox, upscale + sharpen it on the server with Lanczos3
 * resampling, then stream the resulting image straight back in the response.
 * No re-upload: Catbox blocks uploads from datacenter IPs (Vercel), so the
 * endpoint returns the image bytes directly with descriptive metadata headers.
 */

const ALLOWED_HOSTS = new Set(['files.catbox.moe', 'litterbox.catbox.moe']);
const MAX_SOURCE_BYTES = 12 * 1024 * 1024;
const MAX_PIXELS = 34000000;
const MAX_EDGE = 8192;

const MIME: Record<string, string> = {
    webp: 'image/webp',
    jpeg: 'image/jpeg',
    jpg: 'image/jpeg',
    png: 'image/png'
};

const EXT: Record<string, string> = {
    webp: 'webp',
    jpeg: 'jpg',
    jpg: 'jpg',
    png: 'png'
};

export default async function catboxUpscaleHandler(req: Request, res: Response) {
    const raw = String(req.query.url ?? req.body?.url ?? '').trim();

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

    const scale = Number(req.query.scale ?? req.body?.scale ?? 2);
    if (!Number.isFinite(scale) || scale < 1 || scale > 8) {
        return res.status(400).json({
            status: false,
            message: 'Parameter scale harus antara 1 sampai 8.'
        });
    }

    const format = String(req.query.format ?? req.body?.format ?? 'webp').toLowerCase();
    const mime = MIME[format];
    if (!mime) {
        return res.status(400).json({
            status: false,
            message: 'Format harus webp, jpeg, atau png.'
        });
    }

    const detail = Number(req.query.detail ?? req.body?.detail ?? 0.6);
    const strength = Number.isFinite(detail)
        ? Math.max(0, Math.min(1, detail))
        : 0.6;

    try {
        const response = await fetch(target.toString(), {
            signal: AbortSignal.timeout(30000),
            redirect: 'error',
            headers: { 'User-Agent': 'KuroNeko-Image-Upscaler/1.0' }
        });

        if (!response.ok) {
            if (response.status === 404) {
                return res.status(404).json({
                    status: false,
                    message: 'Gambar tidak ditemukan di Catbox. Cek link-nya.'
                });
            }
            return res.status(502).json({
                status: false,
                message: `Gagal mengambil gambar dari Catbox (HTTP ${response.status}).`
            });
        }

        const source = Buffer.from(await response.arrayBuffer());
        if (!source.length) {
            return res.status(404).json({
                status: false,
                message: 'Gambar tidak ditemukan di Catbox.'
            });
        }

        if (source.length > MAX_SOURCE_BYTES) {
            return res.status(413).json({
                status: false,
                message: 'Gambar sumber terlalu besar (maks 12 MB).'
            });
        }

        const metadata = await sharp(source, { limitInputPixels: 268402689 }).metadata();
        if (!metadata.width || !metadata.height) {
            return res.status(415).json({
                status: false,
                message: 'File itu bukan gambar yang bisa diproses.'
            });
        }

        let width = Math.round(metadata.width * scale);
        let height = Math.round(metadata.height * scale);

        if (width * height > MAX_PIXELS) {
            const factor = Math.sqrt(MAX_PIXELS / (width * height));
            width = Math.round(width * factor);
            height = Math.round(height * factor);
        }

        if (Math.max(width, height) > MAX_EDGE) {
            const factor = MAX_EDGE / Math.max(width, height);
            width = Math.round(width * factor);
            height = Math.round(height * factor);
        }

        const pipeline = sharp(source, { limitInputPixels: 268402689 })
            .resize({ width, height, kernel: 'lanczos3' })
            .modulate({ saturation: 1 + strength * 0.1 });

        if (strength > 0) {
            pipeline.sharpen({ sigma: 0.5 + strength * 1.5 });
        }

        let output: Buffer;
        if (format === 'png') {
            output = await pipeline.png({ compressionLevel: 9 }).toBuffer();
        } else if (format === 'jpeg' || format === 'jpg') {
            output = await pipeline.jpeg({ quality: 92, mozjpeg: true }).toBuffer();
        } else {
            output = await pipeline.webp({ quality: 90 }).toBuffer();
        }

        res.setHeader('Content-Type', mime);
        res.setHeader('Content-Length', String(output.length));
        res.setHeader('Content-Disposition', `inline; filename="kuroneko-upscale-${Date.now()}.${EXT[format]}"`);
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.setHeader('X-Content-Type-Options', 'nosniff');
        res.setHeader('X-Original-Width', String(metadata.width));
        res.setHeader('X-Original-Height', String(metadata.height));
        res.setHeader('X-Output-Width', String(width));
        res.setHeader('X-Output-Height', String(height));
        res.setHeader('X-Output-Format', EXT[format]);

        return res.send(output);
    } catch (error) {
        const message = error instanceof Error ? error.message : '';

        if (message.includes('timeout') || message.includes('aborted')) {
            return res.status(504).json({
                status: false,
                message: 'Catbox terlalu lama merespons. Coba lagi.'
            });
        }

        return res.status(502).json({
            status: false,
            message: 'Gagal meng-upscale gambar.',
            detail: message || String(error)
        });
    }
}
