import { Request, Response } from 'express';
import axios from 'axios';
import FormData from 'form-data';
import sharp from 'sharp';

/*
 * Fetch a photo from Catbox, upscale + sharpen it on the server with
 * Lanczos3 resampling, then upload the result back to Catbox and return the
 * new shareable URL. Exposed as a normal KuroNeko endpoint in /docs.
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
        const response = await axios.get<ArrayBuffer>(target.toString(), {
            responseType: 'arraybuffer',
            timeout: 30000,
            maxContentLength: MAX_SOURCE_BYTES,
            maxBodyLength: MAX_SOURCE_BYTES,
            headers: { 'User-Agent': 'KuroNeko-Image-Upscaler/1.0' }
        });

        const source = Buffer.from(response.data);
        if (!source.length) {
            return res.status(404).json({
                status: false,
                message: 'Gambar tidak ditemukan di Catbox.'
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
        let clamped = false;

        if (width * height > MAX_PIXELS) {
            const factor = Math.sqrt(MAX_PIXELS / (width * height));
            width = Math.round(width * factor);
            height = Math.round(height * factor);
            clamped = true;
        }

        if (Math.max(width, height) > MAX_EDGE) {
            const factor = MAX_EDGE / Math.max(width, height);
            width = Math.round(width * factor);
            height = Math.round(height * factor);
            clamped = true;
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

        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', output, {
            filename: `kuroneko-upscale-${Date.now()}.${EXT[format]}`,
            contentType: mime
        });

        const uploaded = await axios.post<string>('https://catbox.moe/user/api.php', form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 60000,
            responseType: 'text'
        });

        const result = String(uploaded.data ?? '').trim();
        if (!/^https:\/\/(files|litterbox)\.catbox\.moe\/\S+$/.test(result)) {
            return res.status(502).json({
                status: false,
                message: 'Catbox mengembalikan respons yang tidak dikenali.'
            });
        }

        return res.json({
            status: true,
            result,
            width,
            height,
            format: EXT[format],
            bytes: output.length,
            ...(clamped ? { note: 'Resolusi dibatasi supaya proses tetap stabil.' } : {})
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : '';

        if (message.includes('maxContentLength') || message.includes('maxBodyLength')) {
            return res.status(413).json({
                status: false,
                message: 'Gambar sumber terlalu besar (maks 12 MB).'
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
            message: 'Gagal meng-upscale atau meng-upload gambar ke Catbox.',
            detail: message || String(error)
        });
    }
}
