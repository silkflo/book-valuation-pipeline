// src/services/cropRetryWithOpenAI.js
//
// Phase 2.5 "Pass 2": for uncertain books, download the original ad image,
// crop around the book bbox, and send all crops in ONE Vision request to read
// the exact visible title text. Returns improved text fields per book.
//
// This module does NOT touch the database and does NOT call Google Books.
// The caller (extractBooksWithOpenAI) merges the result and re-resolves ISBNs.

import { writeFile } from 'node:fs/promises';
import path from 'node:path';

import { openai, OPENAI_MODEL } from './openaiClient.js';
import { trackedOpenAiCall } from './aiUsage.js';
import { cropBookFromImage } from './bookCropper.js';
import {
    createAdTempDir,
    downloadImageToBuffer,
    removeTempDir,
} from './tempImages.js';

const PASS2_SYSTEM_PROMPT = [
    'Tu es un assistant qui lit le texte exact visible sur une image recadrée.',
    'Chaque image correspond à UN seul livre (dos ou couverture), parfois incliné, petit ou abîmé.',
    'Lis le texte réellement visible le plus fidèlement possible.',
    'Ne devine pas d’ISBN et ne renvoie pas plusieurs livres pour une image.',
].join(' ');

function resolveSourceUrl(imageUrls, imageIndex) {
    if (!Array.isArray(imageUrls) || !imageUrls.length) {
        return null;
    }

    const index = Number(imageIndex);
    if (Number.isFinite(index) && index > 0 && imageUrls[index - 1]) {
        return imageUrls[index - 1];
    }

    return imageUrls[0] || null;
}

const PASS2_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    properties: {
        results: {
            type: 'array',
            items: {
                type: 'object',
                additionalProperties: false,
                properties: {
                    index: { type: 'number' },
                    rawVisibleText: { type: 'string' },
                    possibleCorrectedTitle: { type: 'string' },
                    titleCandidates: { type: 'array', items: { type: 'string' } },
                    author: { type: 'string' },
                    seriesName: { type: 'string' },
                    confidence: { type: 'number', minimum: 0, maximum: 1 },
                },
                required: [
                    'index',
                    'rawVisibleText',
                    'possibleCorrectedTitle',
                    'titleCandidates',
                    'author',
                    'seriesName',
                    'confidence',
                ],
            },
        },
    },
    required: ['results'],
};

/**
 * @param {object} args
 * @param {string} args.adsId
 * @param {string[]} args.imageUrls   Ordered list of ad image URLs (same order sent to Pass 1).
 * @param {Array<{ref:any, bbox:number[], orientation:string, imageIndex:number}>} args.books
 * @param {number} [args.maxCrops]
 * @returns {Promise<{cropsCreated:number, resultsByRef:Map<any, object>}>}
 */
export async function cropRetryBooks({ adsId, imageUrls, books, maxCrops = 6 }) {
    const flagged = (Array.isArray(books) ? books : []).slice(0, maxCrops);
    const resultsByRef = new Map();

    if (!flagged.length) {
        return { cropsCreated: 0, resultsByRef };
    }

    const tempDir = await createAdTempDir(adsId);
    const bufferCache = new Map();
    const crops = []; // { ref, index, dataUrl }

    try {
        let cropIndex = 0;

        for (const book of flagged) {
            const url = resolveSourceUrl(imageUrls, book.imageIndex);
            if (!url) {
                console.warn(`Ad ${adsId}: crop retry skipped a book (no source image URL).`);
                continue;
            }

            try {
                if (!bufferCache.has(url)) {
                    bufferCache.set(url, await downloadImageToBuffer(url));
                }

                const cropBuffer = await cropBookFromImage({
                    imageBuffer: bufferCache.get(url),
                    bbox: book.bbox,
                    orientation: book.orientation,
                });

                cropIndex += 1;

                // Write to the temp folder (cleaned up in finally) and use the
                // in-memory buffer as a base64 data URL for the Vision request.
                await writeFile(path.join(tempDir, `crop-${cropIndex}.jpg`), cropBuffer);

                crops.push({
                    ref: book.ref,
                    index: cropIndex,
                    dataUrl: `data:image/jpeg;base64,${cropBuffer.toString('base64')}`,
                });
            } catch (error) {
                console.warn(`Ad ${adsId}: crop failed for one book:`, error?.message || error);
            }
        }

        if (!crops.length) {
            return { cropsCreated: 0, resultsByRef };
        }

        const indexList = crops.map((crop) => crop.index).join(', ');

        const response = await trackedOpenAiCall({
            callSite: 'pass2_crop_retry',
            adsId,
            inputKind: 'base64',
            imageCount: crops.length,
            costType: 'openai_crop_retry',
            // model resolves per call site (OPENAI_PASS2_CROP_MODEL -> OPENAI_MODEL), injected into create()
            fn: (model) => openai.responses.create({
            model,
            input: [
                {
                    role: 'system',
                    content: [{ type: 'input_text', text: PASS2_SYSTEM_PROMPT }],
                },
                {
                    role: 'user',
                    content: [
                        {
                            type: 'input_text',
                            text: [
                                `Voici ${crops.length} image(s) recadrée(s), numérotée(s) dans l’ordre: ${indexList}.`,
                                'Pour CHAQUE image, renvoie un objet avec:',
                                '- index: le numéro de l’image (commence à 1, dans l’ordre fourni)',
                                '- rawVisibleText: le texte exact visible sur le livre',
                                '- possibleCorrectedTitle: ta meilleure hypothèse du vrai titre publié',
                                '- titleCandidates: jusqu’à 3 titres possibles',
                                '- author: auteur si visible, sinon chaîne vide',
                                '- seriesName: nom de série si visible, sinon chaîne vide',
                                '- confidence: fiabilité de possibleCorrectedTitle entre 0 et 1',
                                'Retourne uniquement du JSON, une entrée par image.',
                            ].join('\n'),
                        },
                        ...crops.map((crop) => ({
                            type: 'input_image',
                            image_url: crop.dataUrl,
                        })),
                    ],
                },
            ],
            text: {
                format: {
                    type: 'json_schema',
                    name: 'crop_retry_reading',
                    strict: true,
                    schema: PASS2_SCHEMA,
                },
            },
            }),
        });

        let parsed;
        try {
            parsed = JSON.parse(response.output_text);
        } catch (error) {
            console.warn(
                `Ad ${adsId}: crop retry JSON parse failed:`,
                String(response.output_text || '').slice(0, 300)
            );
            return { cropsCreated: crops.length, resultsByRef };
        }

        const results = Array.isArray(parsed.results) ? parsed.results : [];
        const refByIndex = new Map(crops.map((crop) => [crop.index, crop.ref]));

        for (const result of results) {
            const ref = refByIndex.get(Number(result.index));
            if (ref === undefined) {
                continue;
            }

            resultsByRef.set(ref, {
                rawVisibleText: result.rawVisibleText ? String(result.rawVisibleText).trim() : null,
                possibleCorrectedTitle: result.possibleCorrectedTitle
                    ? String(result.possibleCorrectedTitle).trim()
                    : null,
                titleCandidates: Array.isArray(result.titleCandidates)
                    ? result.titleCandidates.map((value) => String(value || '').trim()).filter(Boolean)
                    : [],
                author: result.author ? String(result.author).trim() : null,
                seriesName: result.seriesName ? String(result.seriesName).trim() : null,
                confidence: Number.isFinite(Number(result.confidence)) ? Number(result.confidence) : null,
            });
        }

        return { cropsCreated: crops.length, resultsByRef };
    } finally {
        const cleanup = await removeTempDir(tempDir);
        if (cleanup.ok) {
            console.log(`Ad ${adsId}: crop retry temp folder cleaned up.`);
        } else {
            console.warn(`Ad ${adsId}: crop retry temp cleanup FAILED:`, cleanup.error);
        }
    }
}
