import { Request, Response } from 'express';
import axios from 'axios';
import { parsePublicHttpUrl } from '../../src/security/url';

export default async function shortUrlHandler(req: Request, res: Response) {
    const url = String(req.query.url || req.body.url || '').trim();
    const alias = String(req.query.alias || req.body.alias || '').trim();

    if (!url) {
        return res.status(400).json({
            status: false,
            message: "Parameter 'url' diperlukan."
        });
    }

    const parsed = parsePublicHttpUrl(url);
    if (!parsed) {
        return res.status(400).json({
            status: false,
            message: 'URL harus http/https publik dan bukan alamat internal'
        });
    }

    if (!/^[A-Za-z0-9_-]{0,64}$/.test(alias)) {
        return res.status(400).json({
            status: false,
            message: 'Alias hanya boleh huruf, angka, underscore, dan dash (maks 64 karakter)'
        });
    }

    const apiUrl = `https://tinyurl.com/api-create.php?url=${encodeURIComponent(parsed.toString())}&alias=${encodeURIComponent(alias)}`;
    const response = await axios.get(apiUrl);

    if (response.data === 'Error') {
        return res.status(400).json({
            status: false,
            message: 'Custom Alias ini sudah dipakai orang lain. Coba nama lain.'
        });
    }

    return res.json({
        status: true,
        result: response.data
    });
}