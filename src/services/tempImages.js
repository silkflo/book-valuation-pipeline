// src/services/tempImages.js
//
// Tiny helpers for the Phase 2.5 crop-retry flow:
// - create a throwaway temp folder per ad
// - download an original ad image into memory
// - delete the temp folder afterwards (no local files kept)

import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

export async function createAdTempDir(adsId) {
    const safeId = String(adsId || 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 40);
    return mkdtemp(path.join(tmpdir(), `books-crop-${safeId}-`));
}

export async function downloadImageToBuffer(url) {
    const response = await fetch(url, { method: 'GET' });

    if (!response.ok) {
        throw new Error(`Image download failed (${response.status}) for ${url}`);
    }

    const arrayBuffer = await response.arrayBuffer();
    return Buffer.from(arrayBuffer);
}

export async function removeTempDir(dir) {
    if (!dir) {
        return { ok: true };
    }

    try {
        await rm(dir, { recursive: true, force: true });
        return { ok: true };
    } catch (error) {
        return { ok: false, error: error?.message || String(error) };
    }
}
