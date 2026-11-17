/* KuroNeko Catbox Upscaler — no dependencies, runs fully in the browser. */
(function () {
    'use strict';

    const $ = (id) => document.getElementById(id);

    const el = {
        urlInput: $('url-input'),
        btnPaste: $('btn-paste'),
        btnFetch: $('btn-fetch'),
        targetSelect: $('target-select'),
        formatSelect: $('format-select'),
        detailSelect: $('detail-select'),
        sharpenInput: $('sharpen-input'),
        previewEmpty: $('preview-empty'),
        previewGrid: $('preview-grid'),
        panelBefore: $('panel-before'),
        panelAfter: $('panel-after'),
        imgBefore: $('img-before'),
        imgAfter: $('img-after'),
        metaSource: $('meta-source'),
        metaResult: $('meta-result'),
        progressWrap: $('progress-wrap'),
        progressLabel: $('progress-label'),
        progressPct: $('progress-pct'),
        progressFill: $('progress-fill'),
        statusLine: $('status-line'),
        statusText: $('status-text'),
        errorBox: $('error-box'),
        errorText: $('error-text'),
        btnUpscale: $('btn-upscale'),
        btnUpload: $('btn-upload'),
        btnDownload: $('btn-download'),
        btnReset: $('btn-reset'),
        resultPanel: $('result-panel'),
        resultLink: $('result-link'),
        btnCopy: $('btn-copy'),
        btnOpen: $('btn-open'),
        steps: Array.prototype.slice.call(document.querySelectorAll('.up-step'))
    };

    const MAX_OUTPUT_BYTES = 4 * 1024 * 1024 - 64 * 1024;
    const MAX_PIXELS = 34000000;
    const EDGE_TARGET = { '4k': 3840, '8k': 7680 };

    const state = {
        sourceUrl: null,
        sourceBlob: null,
        sourceImage: null,
        upscaledUrl: null,
        upscaledBlob: null,
        resultUrl: null,
        busy: false
    };

    const nextFrame = () => new Promise((resolve) => requestAnimationFrame(() => resolve()));

    function formatBytes(bytes) {
        if (!bytes && bytes !== 0) return '—';
        if (bytes < 1024) return bytes + ' B';
        if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(0) + ' KB';
        return (bytes / (1024 * 1024)).toFixed(2) + ' MB';
    }

    function parseCatboxUrl(raw) {
        let url;
        try {
            url = new URL(String(raw || '').trim());
        } catch (_) {
            return null;
        }
        const hosts = ['files.catbox.moe', 'litterbox.catbox.moe'];
        if (url.protocol !== 'https:' || hosts.indexOf(url.hostname) === -1) return null;
        if (!/^\/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9]+)?$/.test(url.pathname)) return null;
        return url.toString();
    }

    function setStatus(text, kind) {
        el.statusLine.className = 'up-status status-' + (kind || 'waiting');
        el.statusText.textContent = text;
    }

    function showProgress(label, fraction) {
        const pct = Math.max(0, Math.min(100, Math.round(fraction * 100)));
        el.progressLabel.textContent = label;
        el.progressPct.textContent = pct + '%';
        el.progressFill.style.width = pct + '%';
        el.progressWrap.classList.remove('hidden');
    }

    function hideProgress() {
        el.progressWrap.classList.add('hidden');
        el.progressFill.style.width = '0%';
    }

    function showError(message, kind) {
        el.errorText.textContent = message;
        el.errorBox.className = 'ogui-alert up-alert ' + (kind === 'warn' ? 'warn' : 'danger');
        el.errorBox.classList.remove('hidden');
    }

    function hideError() {
        el.errorBox.classList.add('hidden');
        el.errorBox.classList.remove('warn', 'danger');
        el.errorText.textContent = '';
    }

    function setStep(active) {
        el.steps.forEach(function (step, index) {
            step.classList.toggle('active', index < active);
        });
    }

    function setBusy(busy) {
        state.busy = busy;
        [
            el.urlInput, el.btnPaste, el.btnFetch, el.targetSelect,
            el.formatSelect, el.detailSelect, el.sharpenInput, el.btnReset
        ].forEach(function (node) {
            if (node) node.disabled = busy;
        });
        el.btnUpscale.disabled = busy || !state.sourceImage;
        el.btnUpload.disabled = busy || !state.upscaledBlob;
        el.btnDownload.disabled = busy || !state.upscaledBlob;
    }

    function resetOutput() {
        if (state.upscaledUrl) URL.revokeObjectURL(state.upscaledUrl);
        state.upscaledUrl = null;
        state.upscaledBlob = null;
        state.resultUrl = null;
        el.imgAfter.removeAttribute('src');
        el.metaResult.textContent = '—';
        el.panelAfter.classList.add('hidden');
        el.resultPanel.classList.add('hidden');
        el.resultLink.value = '';
        el.btnOpen.href = '#';
        setBusy(false);
    }

    function resetAll() {
        if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
        state.sourceUrl = null;
        state.sourceBlob = null;
        state.sourceImage = null;
        el.urlInput.value = '';
        el.imgBefore.removeAttribute('src');
        el.metaSource.textContent = '—';
        el.previewGrid.classList.add('hidden');
        el.previewEmpty.classList.remove('hidden');
        el.previewEmpty.classList.add('show');
        resetOutput();
        hideError();
        hideProgress();
        setStatus('Menunggu link Catbox…', 'waiting');
        setStep(0);
    }

    function loadImage(url) {
        return new Promise(function (resolve, reject) {
            const image = new Image();
            image.onload = function () { resolve(image); };
            image.onerror = function () { reject(new Error('Gambar tidak bisa dibaca browser.')); };
            image.src = url;
        });
    }

    async function fetchImage() {
        if (state.busy) return;
        const target = parseCatboxUrl(el.urlInput.value);
        if (!target) {
            showError('Link harus berupa URL gambar Catbox, misalnya https://files.catbox.moe/xxxxx.jpg');
            setStatus('Link tidak valid.', 'error');
            return;
        }

        hideError();
        resetOutput();
        setBusy(true);
        setStatus('Mengambil gambar dari Catbox…', 'running');
        showProgress('Mengambil gambar', 0.08);

        try {
            const response = await fetch('/api/tools/catbox-image?url=' + encodeURIComponent(target), {
                cache: 'force-cache'
            });
            if (!response.ok) {
                const payload = await response.json().catch(function () { return {}; });
                throw new Error(payload.message || 'Gagal mengambil gambar dari Catbox.');
            }

            const blob = await response.blob();
            if (!blob.type || blob.type.indexOf('image/') !== 0) {
                throw new Error('Catbox mengembalikan file bukan gambar.');
            }

            const objectUrl = URL.createObjectURL(blob);
            const image = await loadImage(objectUrl);

            if (state.sourceUrl) URL.revokeObjectURL(state.sourceUrl);
            state.sourceUrl = objectUrl;
            state.sourceBlob = blob;
            state.sourceImage = image;

            el.imgBefore.src = objectUrl;
            el.previewEmpty.classList.add('hidden');
            el.previewEmpty.classList.remove('show');
            el.previewGrid.classList.remove('hidden');
            el.metaSource.textContent = image.naturalWidth + '×' + image.naturalHeight + ' · ' + formatBytes(blob.size);

            setStep(2);
            setStatus('Gambar didapat. Siap di-upscale.', 'success');
        } catch (error) {
            showError(error && error.message ? error.message : 'Gagal mengambil gambar.');
            setStatus('Gagal mengambil gambar.', 'error');
        } finally {
            hideProgress();
            setBusy(false);
        }
    }

    function computeTarget(width, height, key) {
        let outW;
        let outH;
        let note = '';

        if (key === '2' || key === '4') {
            const scale = Number(key);
            outW = Math.round(width * scale);
            outH = Math.round(height * scale);
        } else {
            const edge = EDGE_TARGET[key] || 3840;
            const longest = Math.max(width, height);
            const scale = edge / longest;
            if (scale < 1) {
                outW = width;
                outH = height;
                note = 'Sumber sudah lebih besar dari target, ukuran asli dipakai.';
            } else {
                outW = Math.round(width * scale);
                outH = Math.round(height * scale);
            }
        }

        if (outW * outH > MAX_PIXELS) {
            const factor = Math.sqrt(MAX_PIXELS / (outW * outH));
            outW = Math.round(outW * factor);
            outH = Math.round(outH * factor);
            note = 'Dibatasi ' + (MAX_PIXELS / 1000000).toFixed(0) + ' MP supaya browser tetap stabil.';
        }

        return {
            width: Math.max(1, outW),
            height: Math.max(1, outH),
            note: note
        };
    }

    async function enhanceDetail(canvas, strength, onProgress) {
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        const width = canvas.width;
        const height = canvas.height;
        const tile = 384;
        const overlap = 2;
        const carryBytes = width * overlap * 4;
        let top = 0;
        let carry = null;

        while (top < height) {
            const readTop = Math.max(0, top - overlap);
            const readBottom = Math.min(height, top + tile + overlap);
            const readHeight = readBottom - readTop;

            const frame = ctx.getImageData(0, readTop, width, readHeight);
            const src = frame.data;

            // The last rows of this read are still untouched by putImageData,
            // so keep them as clean neighbours for the next tile.
            const nextCarry = new Uint8ClampedArray(src.subarray(src.length - carryBytes));
            // Restore the original rows above this tile instead of reusing
            // already sharpened pixels — this prevents faint horizontal seams.
            if (carry) src.set(carry, 0);

            const horizontal = new Uint8ClampedArray(src.length);
            const out = new Uint8ClampedArray(src.length);

            for (let y = 0; y < readHeight; y++) {
                const row = y * width * 4;
                for (let x = 0; x < width; x++) {
                    const i = row + x * 4;
                    const left = row + (x > 0 ? x - 1 : x) * 4;
                    const right = row + (x < width - 1 ? x + 1 : x) * 4;
                    horizontal[i] = (src[left] + src[i] + src[right]) / 3;
                    horizontal[i + 1] = (src[left + 1] + src[i + 1] + src[right + 1]) / 3;
                    horizontal[i + 2] = (src[left + 2] + src[i + 2] + src[right + 2]) / 3;
                    horizontal[i + 3] = src[i + 3];
                }
            }

            for (let y = 0; y < readHeight; y++) {
                const row = y * width * 4;
                const up = (y > 0 ? y - 1 : y) * width * 4;
                const down = (y < readHeight - 1 ? y + 1 : y) * width * 4;
                for (let x = 0; x < width; x++) {
                    const i = row + x * 4;
                    const topIdx = up + x * 4;
                    const bottomIdx = down + x * 4;
                    const r = (horizontal[topIdx] + horizontal[i] + horizontal[bottomIdx]) / 3;
                    const g = (horizontal[topIdx + 1] + horizontal[i + 1] + horizontal[bottomIdx + 1]) / 3;
                    const b = (horizontal[topIdx + 2] + horizontal[i + 2] + horizontal[bottomIdx + 2]) / 3;
                    out[i] = src[i] + strength * (src[i] - r);
                    out[i + 1] = src[i + 1] + strength * (src[i + 1] - g);
                    out[i + 2] = src[i + 2] + strength * (src[i + 2] - b);
                    out[i + 3] = src[i + 3];
                }
            }

            const writeStart = top - readTop;
            const writeRows = Math.min(tile, height - top);
            const from = writeStart * width * 4;
            const to = (writeStart + writeRows) * width * 4;
            const piece = new ImageData(new Uint8ClampedArray(out.subarray(from, to)), width, writeRows);
            ctx.putImageData(piece, 0, top);
            carry = nextCarry;

            top += tile;
            onProgress(Math.min(1, top / height));
            await nextFrame();
        }
    }

    function canvasToBlob(canvas, mime, quality) {
        return new Promise(function (resolve, reject) {
            canvas.toBlob(function (blob) {
                if (blob) resolve(blob);
                else reject(new Error('Gagal mengekspor hasil upscale.'));
            }, mime, quality);
        });
    }

    async function exportWithLimit(canvas, format, onProgress) {
        const mime = 'image/' + format;
        const qualities = format === 'png'
            ? [undefined]
            : [0.92, 0.85, 0.76, 0.68, 0.6, 0.52, 0.44, 0.36];
        let last = null;

        for (let i = 0; i < qualities.length; i++) {
            const blob = await canvasToBlob(canvas, mime, qualities[i]);
            last = blob;
            onProgress((i + 1) / qualities.length);
            if (blob.size <= MAX_OUTPUT_BYTES) {
                return { blob: blob, note: i > 0 ? 'Kualitas disesuaikan supaya muat di batas upload.' : '' };
            }
            await nextFrame();
        }

        return { blob: last, note: '', tooBig: true };
    }

    async function exportFinal(canvas, format, onProgress) {
        let result = await exportWithLimit(canvas, format, function (p) { onProgress(p * 0.8); });
        if (result.tooBig && format !== 'webp') {
            const fallback = await exportWithLimit(canvas, 'webp', function (p) { onProgress(0.8 + p * 0.2); });
            if (!fallback.tooBig) {
                fallback.note = 'Format diganti WEBP otomatis supaya hasil tetap bisa di-upload.';
            }
            result = fallback;
        }
        return result;
    }

    async function upscale() {
        if (state.busy || !state.sourceImage) return;
        hideError();
        setBusy(true);

        const target = computeTarget(
            state.sourceImage.naturalWidth,
            state.sourceImage.naturalHeight,
            el.targetSelect.value
        );
        const format = el.formatSelect.value;
        const strength = Number(el.detailSelect.value);
        const sharpen = el.sharpenInput.checked;
        const notes = [];

        if (target.note) notes.push(target.note);
        setStatus('Membuat kanvas ' + target.width + '×' + target.height + '…', 'running');
        showProgress('Menyiapkan kanvas', 0.02);
        await nextFrame();

        try {
            const canvas = document.createElement('canvas');
            canvas.width = target.width;
            canvas.height = target.height;
            const ctx = canvas.getContext('2d');
            if (!ctx) throw new Error('Browser tidak mendukung canvas 2D.');

            ctx.imageSmoothingEnabled = true;
            ctx.imageSmoothingQuality = 'high';
            if (sharpen) ctx.filter = 'contrast(1.06) saturate(1.06)';
            ctx.drawImage(state.sourceImage, 0, 0, target.width, target.height);
            ctx.filter = 'none';
            await nextFrame();

            if (sharpen) {
                showProgress('Memperhalus detail', 0.2);
                await enhanceDetail(canvas, strength, function (p) {
                    showProgress('Memperhalus detail', 0.2 + p * 0.6);
                });
            }

            showProgress('Mengompres hasil', 0.82);
            const exported = await exportFinal(canvas, format, function (p) {
                showProgress('Mengompres hasil', 0.82 + p * 0.18);
            });

            if (state.upscaledUrl) URL.revokeObjectURL(state.upscaledUrl);
            state.upscaledBlob = exported.blob;
            state.upscaledUrl = URL.createObjectURL(exported.blob);
            el.imgAfter.src = state.upscaledUrl;
            el.metaResult.textContent = target.width + '×' + target.height + ' · ' + formatBytes(exported.blob.size);
            el.panelAfter.classList.remove('hidden');

            if (exported.note) notes.push(exported.note);
            if (exported.tooBig) {
                notes.push('Hasil masih terlalu besar buat di-upload (maks 4 MB). Silakan download.');
                showError(notes.join(' '), 'warn');
                setStatus('Upscale selesai, tapi hasil terlalu besar.', 'error');
            } else {
                setStatus('Upscale selesai. Siap di-upload ke Catbox.', 'success');
                setStep(3);
                if (notes.length) showError(notes.join(' '), 'warn');
            }
        } catch (error) {
            showError(error && error.message ? error.message : 'Upscale gagal. Coba target lebih rendah.');
            setStatus('Upscale gagal.', 'error');
        } finally {
            hideProgress();
            setBusy(false);
        }
    }

    async function upload() {
        if (state.busy || !state.upscaledBlob) return;
        hideError();
        setBusy(true);
        setStatus('Meng-upload hasil ke Catbox…', 'running');
        showProgress('Meng-upload ke Catbox', 0.15);

        try {
            const response = await fetch('/api/tools/catbox-upload', {
                method: 'POST',
                headers: { 'Content-Type': state.upscaledBlob.type },
                body: state.upscaledBlob
            });
            const data = await response.json().catch(function () { return {}; });
            if (!response.ok || !data.result) {
                throw new Error(data.message || 'Upload ke Catbox gagal.');
            }

            state.resultUrl = data.result;
            el.resultLink.value = data.result;
            el.btnOpen.href = data.result;
            el.resultPanel.classList.remove('hidden');
            setStep(4);
            setStatus('Selesai! Link baru sudah siap.', 'success');
        } catch (error) {
            showError(error && error.message ? error.message : 'Upload ke Catbox gagal.');
            setStatus('Upload gagal.', 'error');
        } finally {
            hideProgress();
            setBusy(false);
        }
    }

    async function copyLink() {
        const value = el.resultLink.value;
        if (!value) return;
        try {
            await navigator.clipboard.writeText(value);
        } catch (_) {
            el.resultLink.select();
            document.execCommand('copy');
        }
        el.btnCopy.textContent = 'Tersalin ✓';
        el.btnCopy.classList.add('active');
        setTimeout(function () {
            el.btnCopy.textContent = 'Salin';
            el.btnCopy.classList.remove('active');
        }, 1600);
    }

    function download() {
        if (!state.upscaledBlob) return;
        const types = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
        const ext = types[state.upscaledBlob.type] || 'img';
        const href = URL.createObjectURL(state.upscaledBlob);
        const anchor = document.createElement('a');
        anchor.href = href;
        anchor.download = 'kuroneko-upscale-' + Date.now() + '.' + ext;
        document.body.appendChild(anchor);
        anchor.click();
        document.body.removeChild(anchor);
        setTimeout(function () { URL.revokeObjectURL(href); }, 1000);
    }

    el.btnFetch.addEventListener('click', fetchImage);
    el.urlInput.addEventListener('keydown', function (event) {
        if (event.key === 'Enter') fetchImage();
    });
    el.btnPaste.addEventListener('click', async function () {
        try {
            const text = await navigator.clipboard.readText();
            el.urlInput.value = text.trim();
            hideError();
            el.urlInput.focus();
        } catch (_) {
            showError('Browser nggak izinin baca clipboard. Tempel manual ya.', 'warn');
            el.urlInput.focus();
        }
    });
    el.targetSelect.addEventListener('change', resetOutput);
    el.formatSelect.addEventListener('change', resetOutput);
    el.detailSelect.addEventListener('change', resetOutput);
    el.sharpenInput.addEventListener('change', resetOutput);
    el.btnUpscale.addEventListener('click', upscale);
    el.btnUpload.addEventListener('click', upload);
    el.btnDownload.addEventListener('click', download);
    el.btnCopy.addEventListener('click', copyLink);
    el.btnReset.addEventListener('click', resetAll);

    setBusy(false);
})();
