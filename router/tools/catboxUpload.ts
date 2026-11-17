import { Request, Response } from 'express';
import axios from 'axios';
import FormData from 'form-data';

/*
 * Receive the upscaled image from the browser and forward it to Catbox.
 * Catbox has no CORS headers, so this can only be done server-side.
 *
 * Vercel functions cap request bodies at ~4.5MB; we stop at 4MB to leave room
 * for multipart overhead. The browser side adapts quality to fit this limit.
 */

const MAX_BYTES = Math.floor(4 * 1024 * 1024);
const MIME_EXT: Record<string, string> = {
    'image/png': 'png',
    'image/jpeg': 'jpg',
    'image/webp': 'webp',
    'image/gif': 'gif',
    'image/bmp': 'bmp'
};

const hasValidSignature = (buffer: Buffer, mime: string): boolean => {
    if (buffer.length < 12) return false;

    switch (mime) {
        case 'image/png':
            return buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
        case 'image/jpeg':
            return buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff;
        case 'image/webp':
            return buffer.toString('ascii', 0, 4) === 'RIFF' && buffer.toString('ascii', 8, 12) === 'WEBP';
        case 'image/gif':
            return buffer.toString('ascii', 0, 4) === 'GIF8';
        case 'image/bmp':
            return buffer.toString('ascii', 0, 2) === 'BM';
        default:
            return false;
    }
};

export default async function catboxUploadHandler(req: Request, res: Response) {
    const mime = String(req.headers['content-type'] || '')
        .split(';')[0]
        .trim()
        .toLowerCase();
    const ext = MIME_EXT[mime];

    if (!ext) {
        return res.status(415).json({
            status: false,
            message: 'Format tidak didukung. Gunakan PNG, JPG, WEBP, GIF, atau BMP.'
        });
    }

    const chunks: Buffer[] = [];
    let size = 0;

    try {
        for await (const chunk of req) {
            const part = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
            size += part.length;

            if (size > MAX_BYTES) {
                return res.status(413).json({
                    status: false,
                    message: 'Hasil upscale terlalu besar untuk di-upload (maks 4 MB). Turunkan kualitas atau pitch targetnya.'
                });
            }

            chunks.push(part);
        }
    } catch {
        return res.status(400).json({
            status: false,
            message: 'Gagal membaca data gambar.'
        });
    }

    const buffer = Buffer.concat(chunks);

    if (!buffer.length) {
        return res.status(400).json({
            status: false,
            message: 'Tidak ada gambar yang dikirim.'
        });
    }

    if (!hasValidSignature(buffer, mime)) {
        return res.status(415).json({
            status: false,
            message: 'Isi file tidak sesuai dengan tipe gambar yang dinyatakan.'
        });
    }

    try {
        const form = new FormData();
        form.append('reqtype', 'fileupload');
        form.append('fileToUpload', buffer, {
            filename: `kuroneko-upscale-${Date.now()}.${ext}`,
            contentType: mime
        });

        const response = await axios.post<string>('https://catbox.moe/user/api.php', form, {
            headers: form.getHeaders(),
            maxBodyLength: Infinity,
            maxContentLength: Infinity,
            timeout: 60000,
            responseType: 'text'
        });

        const result = String(response.data ?? '').trim();

        if (!/^https:\/\/(files|litterbox)\.catbox\.moe\/\S+$/.test(result)) {
            return res.status(502).json({
                status: false,
                message: 'Catbox mengembalikan respons yang tidak dikenali.'
            });
        }

        return res.json({
            status: true,
            result,
            bytes: buffer.length
        });
    } catch (error) {
        if (axios.isAxiosError(error)) {
            if (error.code === 'ECONNABORTED' || error.code === 'ETIMEDOUT') {
                return res.status(504).json({
                    status: false,
                    message: 'Catbox terlalu lama merespons. Coba lagi.'
                });
            }
        }

        return res.status(502).json({
            status: false,
            message: 'Gagal meng-upload hasil ke Catbox.'
        });
    }
}
