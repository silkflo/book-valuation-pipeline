// src/services/isbnSearchApifyClient.js

import { ApifyClient } from 'apify-client';

function normalizeText(value) {
    return String(value || '')
        .toLowerCase()
        .normalize('NFD')
        .replace(/\p{Diacritic}/gu, '')
        .replace(/[^\p{L}\p{N}\s]/gu, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanText(value) {
    return String(value || '')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanIsbn(value) {
    const cleaned = String(value || '')
        .replace(/[^0-9Xx]/g, '')
        .toUpperCase();

    return cleaned || null;
}

function normalizeQueryKey(query) {
    return normalizeText(query);
}

function uniqueValues(values) {
    const seen = new Set();
    const result = [];

    for (const value of values) {
        const clean = cleanText(value);
        const key = normalizeQueryKey(clean);

        if (!clean || seen.has(key)) continue;

        seen.add(key);
        result.push(clean);
    }

    return result;
}

function chunkArray(items, size) {
    const chunks = [];

    for (let index = 0; index < items.length; index += size) {
        chunks.push(items.slice(index, index + size));
    }

    return chunks;
}

function createEmptyResult() {
    return {
        candidatesByQuery: new Map(),
        candidatesByIsbn: new Map(),
        rawItems: [],
        blocked: false,
        runs: [],
    };
}

function pushCandidatesByQuery(candidatesByQuery, query, candidates) {
    const queryKey = normalizeQueryKey(query);

    if (!queryKey) return;

    if (!candidatesByQuery.has(queryKey)) {
        candidatesByQuery.set(queryKey, []);
    }

    candidatesByQuery.get(queryKey).push(...candidates);
}

function pushCandidatesByIsbn(candidatesByIsbn, isbn, candidates) {
    const clean = cleanIsbn(isbn);

    if (!clean) return;

    if (!candidatesByIsbn.has(clean)) {
        candidatesByIsbn.set(clean, []);
    }

    candidatesByIsbn.get(clean).push(...candidates);
}

function getCandidateIsbn(candidate) {
    return cleanIsbn(candidate?.isbn || candidate?.isbn13 || candidate?.isbn10);
}

export async function runIsbnSearchApifyLookup({
    queries = [],
    isbns = [],
    maxCandidatesPerQuery = 5,
    proxyCountryCode = process.env.ISBNSEARCH_APIFY_PROXY_COUNTRY || 'US',
} = {}) {
    if (process.env.ISBNSEARCH_APIFY_ENABLED !== 'true') {
        console.warn('ISBNSearch Apify lookup skipped: ISBNSEARCH_APIFY_ENABLED is not true.');
        return createEmptyResult();
    }

    const token = process.env.APIFY_TOKEN;
    const actorId = process.env.ISBNSEARCH_APIFY_ACTOR_ID;

    if (!token) {
        console.warn('ISBNSearch Apify lookup skipped: APIFY_TOKEN is missing.');
        return createEmptyResult();
    }

    if (!actorId) {
        console.warn('ISBNSearch Apify lookup skipped: ISBNSEARCH_APIFY_ACTOR_ID is missing.');
        return createEmptyResult();
    }

    const batchSize = Math.min(
        Math.max(Number(process.env.ISBNSEARCH_APIFY_BATCH_SIZE || 15), 1),
        15
    );

    const maxBatches = Math.min(
        Math.max(Number(process.env.ISBNSEARCH_APIFY_MAX_BATCHES || 5), 1),
        50
    );

    const waitSecs = Math.min(
        Math.max(Number(process.env.ISBNSEARCH_APIFY_WAIT_SECS || 300), 60),
        900
    );

    const delayBetweenBatchesMs = Math.min(
        Math.max(Number(process.env.ISBNSEARCH_APIFY_BATCH_DELAY_MS || 2500), 0),
        60000
    );

    const cleanQueries = uniqueValues(queries);
    const cleanIsbns = uniqueValues(isbns.map(cleanIsbn).filter(Boolean));

    if (!cleanQueries.length && !cleanIsbns.length) {
        return createEmptyResult();
    }

    const queryBatches = chunkArray(cleanQueries, batchSize);
    const isbnBatches = chunkArray(cleanIsbns, batchSize);

    const allBatches = [
        ...queryBatches.map((batch) => ({
            type: 'query',
            queries: batch,
            isbns: [],
        })),
        ...isbnBatches.map((batch) => ({
            type: 'isbn',
            queries: [],
            isbns: batch,
        })),
    ].slice(0, maxBatches);

    const candidatesByQuery = new Map();
    const candidatesByIsbn = new Map();
    const rawItems = [];
    const runs = [];

    let blocked = false;

    console.log(
        `ISBNSearch Apify lookup planned: queries=${cleanQueries.length}, isbns=${cleanIsbns.length}, batchSize=${batchSize}, batches=${allBatches.length}, maxBatches=${maxBatches}`
    );

    const client = new ApifyClient({ token });

    for (let batchIndex = 0; batchIndex < allBatches.length; batchIndex += 1) {
        if (blocked) {
            console.warn(
                `ISBNSearch Apify stopped before batch ${batchIndex + 1}/${allBatches.length}: previous batch detected captcha/block.`
            );
            break;
        }

        const batch = allBatches[batchIndex];

        const input = {
            queries: batch.queries,
            isbns: batch.isbns,
            maxQueries: batchSize,
            maxCandidatesPerQuery,
            useApifyProxy: true,
            proxyCountryCode,
            saveDebugHtml: false,
            saveDebugScreenshots: false,
        };

        console.log(
            `Starting ISBNSearch Apify batch ${batchIndex + 1}/${allBatches.length}: type=${batch.type}, queries=${batch.queries.length}, isbns=${batch.isbns.length}`
        );

        let run;

        try {
            run = await client.actor(actorId).call(input, {
                waitSecs,
            });
        } catch (error) {
            console.error(
                `ISBNSearch Apify batch ${batchIndex + 1}/${allBatches.length} failed:`,
                error?.message || error
            );
            continue;
        }

        runs.push({
            id: run?.id || null,
            status: run?.status || null,
            defaultDatasetId: run?.defaultDatasetId || null,
        });

        if (run?.status !== 'SUCCEEDED') {
            console.warn(
                `ISBNSearch Apify batch ${batchIndex + 1}/${allBatches.length} did not fully succeed: status=${run?.status}, runId=${run?.id}`
            );
        }

        if (!run?.defaultDatasetId) {
            console.warn(
                `ISBNSearch Apify batch ${batchIndex + 1}/${allBatches.length} finished without defaultDatasetId.`
            );
            continue;
        }

        let datasetItems = [];

        try {
            const dataset = await client.dataset(run.defaultDatasetId).listItems({
                limit: 1000,
                clean: true,
            });

            datasetItems = Array.isArray(dataset?.items) ? dataset.items : [];
        } catch (error) {
            console.error(
                `ISBNSearch Apify batch ${batchIndex + 1}/${allBatches.length}: failed to read dataset:`,
                error?.message || error
            );
            continue;
        }

        rawItems.push(...datasetItems);

        for (const item of datasetItems) {
            if (item?.blocked) {
                blocked = true;
            }

            const candidates = Array.isArray(item?.candidates) ? item.candidates : [];

            if (item?.type === 'search' && item?.query) {
                pushCandidatesByQuery(candidatesByQuery, item.query, candidates);
            }

            if (item?.type === 'isbn' && item?.requestedIsbn) {
                pushCandidatesByIsbn(candidatesByIsbn, item.requestedIsbn, candidates);
            }

            for (const candidate of candidates) {
                const candidateIsbn = getCandidateIsbn(candidate);

                if (candidateIsbn) {
                    pushCandidatesByIsbn(candidatesByIsbn, candidateIsbn, [candidate]);
                }
            }
        }

        console.log(
            `ISBNSearch Apify batch ${batchIndex + 1}/${allBatches.length} done: runId=${run?.id}, status=${run?.status}, datasetItems=${datasetItems.length}, blocked=${blocked}`
        );

        if (blocked) {
            console.warn(
                `ISBNSearch Apify detected captcha/block in batch ${batchIndex + 1}. Stopping further batches.`
            );
            break;
        }

        if (delayBetweenBatchesMs > 0 && batchIndex < allBatches.length - 1) {
            await new Promise((resolve) => {
                setTimeout(resolve, delayBetweenBatchesMs);
            });
        }
    }

    console.log(
        `ISBNSearch Apify lookup finished: rawItems=${rawItems.length}, queryKeys=${candidatesByQuery.size}, isbnKeys=${candidatesByIsbn.size}, blocked=${blocked}, runs=${runs.length}`
    );

    return {
        candidatesByQuery,
        candidatesByIsbn,
        rawItems,
        blocked,
        runs,
    };
}
