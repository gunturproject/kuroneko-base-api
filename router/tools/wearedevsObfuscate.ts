import { Request, Response } from 'express';
import fs from 'fs';
import path from 'path';

/*
 * Thin proxy for the LuaU obfuscator used by https://wearedevs.net/obfuscator.
 * The site calls POST /api/obfuscate with { script } and expects { obfuscated }.
 *
 * Vercel caps a Function's request AND response body at 4.5 MB, so this route
 * also accepts a `url` to a script hosted on Catbox/Litterbox. The script is
 * fetched inside the Function (not through the Vercel proxy) and the result is
 * streamed back in chunks, which avoids both 4.5 MB body limits.
 */

const UPSTREAM_URL = 'https://wearedevs.net/api/obfuscate';
const MAX_SCRIPT_BYTES = 30 * 1024 * 1024;
const STREAM_CHUNK_BYTES = 256 * 1024;
const SCRIPT_HOSTS = new Set(['files.catbox.moe', 'litterbox.catbox.moe']);
const BROWSER_UA =
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

type UpstreamPayload = {
    success?: boolean;
    obfuscated?: string;
    error?: string;
    reason?: string;
};

type ScriptResult =
    | { script: string; error?: never; status?: never }
    | { script?: never; error: string; status: number };

const getCreator = (): string => {
    try {
        const configPath = path.join(process.cwd(), 'src', 'config.json');
        const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        return config?.settings?.creator || 'Danzz';
    } catch {
        return 'Danzz';
    }
};

const readScriptFromUrl = async (raw: string): Promise<ScriptResult> => {
    let target: URL;
    try {
        target = new URL(raw);
    } catch {
        return { error: 'URL script tidak valid.', status: 400 };
    }

    if (target.protocol !== 'https:' || !SCRIPT_HOSTS.has(target.hostname)) {
        return {
            error: 'URL harus HTTPS di files.catbox.moe atau litterbox.catbox.moe.',
            status: 400
        };
    }

    try {
        const response = await fetch(target.toString(), {
            headers: { 'User-Agent': BROWSER_UA, Accept: '*/*' },
            signal: AbortSignal.timeout(60000)
        });

        if (!response.ok) {
            return {
                error: `Gagal mengambil script dari host (HTTP ${response.status}).`,
                status: 502
            };
        }

        const declared = Number(response.headers.get('content-length') || 0);
        if (declared > MAX_SCRIPT_BYTES) {
            return { error: 'Script terlalu besar (maks 30 MB).', status: 413 };
        }

        if (!response.body) {
            return { error: 'Host tidak mengembalikan isi script.', status: 502 };
        }

        const reader = response.body.getReader();
        const chunks: Buffer[] = [];
        let total = 0;

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            total += value.byteLength;
            if (total > MAX_SCRIPT_BYTES) {
                await reader.cancel();
                return { error: 'Script terlalu besar (maks 30 MB).', status: 413 };
            }

            chunks.push(Buffer.from(value));
        }

        return { script: Buffer.concat(chunks).toString('utf8') };
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        const timeout = message.includes('timeout') || message.includes('aborted');

        return {
            error: timeout
                ? 'Host script terlalu lama merespons. Coba lagi.'
                : 'Gagal mengambil script dari URL.',
            status: timeout ? 504 : 502
        };
    }
};

const streamJson = (res: Response, payload: unknown) => {
    const body = Buffer.from(JSON.stringify(payload), 'utf8');

    res.status(200);
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Accel-Buffering', 'no');

    for (let i = 0; i < body.length; i += STREAM_CHUNK_BYTES) {
        res.write(body.subarray(i, i + STREAM_CHUNK_BYTES));
    }

    res.end();
};

export default async function wearedevsObfuscateHandler(req: Request, res: Response) {
    let script = typeof req.body?.script === 'string' ? req.body.script : '';
    const scriptUrl =
        typeof req.body?.url === 'string'
            ? req.body.url
            : typeof req.query.url === 'string'
                ? req.query.url
                : '';

    if (!script && !scriptUrl) {
        return res.status(400).json({
            status: false,
            message: "Parameter 'script' atau 'url' diperlukan."
        });
    }

    if (scriptUrl) {
        const result = await readScriptFromUrl(scriptUrl);
        if (result.error) {
            return res.status(result.status).json({
                status: false,
                message: result.error
            });
        }
        script = result.script;
    }

    if (!script.trim()) {
        return res.status(400).json({
            status: false,
            message: 'Script kosong.'
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
            signal: AbortSignal.timeout(180000)
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

        return streamJson(res, {
            creator: getCreator(),
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
