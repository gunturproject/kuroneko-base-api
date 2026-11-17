import { Request, Response } from 'express';

/*
 * Thin proxy for the LuaU obfuscator used by https://wearedevs.net/obfuscator.
 * The site calls POST /api/obfuscate with { script } and expects { obfuscated }
 * back, so we forward the script directly instead of scraping rendered HTML.
 */

const UPSTREAM_URL = 'https://wearedevs.net/api/obfuscate';
const MAX_SCRIPT_BYTES = 30 * 1024 * 1024;
const BROWSER_UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

type UpstreamPayload = {
    success?: boolean;
    obfuscated?: string;
    error?: string;
    reason?: string;
};

export default async function wearedevsObfuscateHandler(req: Request, res: Response) {
    const script =
        typeof req.body?.script === 'string'
            ? req.body.script
            : typeof req.query.script === 'string'
                ? req.query.script
                : '';

    if (!script.trim()) {
        return res.status(400).json({
            status: false,
            message: "Parameter 'script' diperlukan."
        });
    }

    if (Buffer.byteLength(script, 'utf8') > MAX_SCRIPT_BYTES) {
        return res.status(413).json({
            status: false,
            message: 'Script terlalu besar (maks 30 MB).'
        });
    }

    try {
        const upstream = await fetch(UPSTREAM_URL, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'application/json',
                Origin: 'https://wearedevs.net',
                Referer: 'https://wearedevs.net/obfuscator',
                'User-Agent': BROWSER_UA
            },
            body: JSON.stringify({ script }),
            signal: AbortSignal.timeout(60000)
        });

        const text = await upstream.text();
        let payload: UpstreamPayload | null = null;

        try {
            payload = JSON.parse(text) as UpstreamPayload;
        } catch {
            payload = null;
        }

        const upstreamError = payload?.error || payload?.reason;
        const hasObfuscated = typeof payload?.obfuscated === 'string' && !!payload.obfuscated;
        const failed = !upstream.ok || payload?.success === false || !hasObfuscated;

        if (failed) {
            if (upstream.status === 429) {
                return res.status(429).json({
                    status: false,
                    message: 'WeAreDevs sedang kena rate limit. Tunggu sebentar lalu coba lagi.'
                });
            }

            const userMistake = !!payload && (upstream.status === 400 || payload.success === false);
            const message = upstreamError
                ? String(upstreamError)
                : userMistake
                    ? 'Script gagal di-obfuscasi. Cek kembali kode Lua/Luau-mu.'
                    : `Gagal menghubungi WeAreDevs (HTTP ${upstream.status}).`;

            return res.status(userMistake ? 400 : 502).json({
                status: false,
                message,
                ...(payload ? {} : { detail: text.slice(0, 200) })
            });
        }

        return res.json({
            status: true,
            obfuscated: payload!.obfuscated,
            provider: 'WeAreDevs'
        });
    } catch (error) {
        const message = error instanceof Error ? error.message : '';

        if (message.includes('timeout') || message.includes('aborted')) {
            return res.status(504).json({
                status: false,
                message: 'WeAreDevs terlalu lama merespons. Coba lagi.'
            });
        }

        return res.status(502).json({
            status: false,
            message: 'Gagal meng-obfuscasi script.',
            detail: message || String(error)
        });
    }
}
