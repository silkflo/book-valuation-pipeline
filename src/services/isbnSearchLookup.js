// src/services/isbnSearchLookup.js
//
// Provider-routing wrapper for ISBNSearch lookups:
//   1. Scrapfly is the primary provider.
//   2. The legacy Apify actor is an optional fallback, used only when the
//      Scrapfly pass failed technically as a whole (every call failed or the
//      site blocked us) AND ISBNSEARCH_APIFY_ENABLED=true.
//
// Both providers return the same shape:
//   { candidatesByQuery: Map, candidatesByIsbn: Map, rawItems, blocked, runs, costEvents? }

import { runIsbnSearchApifyLookup } from './isbnSearchApifyClient.js';
import {
    runIsbnSearchScrapflyLookup,
    isIsbnSearchScrapflyEnabled,
} from './isbnSearchScrapflyClient.js';
import { saveTechnicalCostEvent } from './costEvents.js';

function createEmptyLookup() {
    return {
        candidatesByQuery: new Map(),
        candidatesByIsbn: new Map(),
        rawItems: [],
        blocked: false,
        runs: [],
        costEvents: [],
        provider: 'none',
    };
}

async function persistCostEvents({ costEvents, adsId }) {
    if (!Array.isArray(costEvents) || !costEvents.length) return;

    for (const event of costEvents) {
        await saveTechnicalCostEvent({
            adsId: adsId || null,
            costType: event.costType,
            provider: event.provider,
            amount: event.amount,
            currency: 'SCRAPFLY_CREDIT',
            unitCount: event.unitCount ?? null,
            unitType: event.unitType || null,
            metadata: event.metadata || {},
        });
    }
}

function scrapflyLookupFailedCompletely(lookup) {
    if (!lookup) return true;

    // Blocked mid-run with nothing usable, or every attempted call failed.
    const gotNothing = !lookup.candidatesByQuery.size && !lookup.candidatesByIsbn.size;

    if (lookup.blocked && gotNothing) return true;

    return lookup.attemptedCalls > 0 && lookup.failedCalls >= lookup.attemptedCalls && gotNothing;
}

export async function runIsbnSearchLookup({
    queries = [],
    isbns = [],
    maxCandidatesPerQuery = 5,
    adsId = null,
    allowApifyFallback = true,
} = {}) {
    let scrapflyLookup = null;

    if (isIsbnSearchScrapflyEnabled()) {
        try {
            scrapflyLookup = await runIsbnSearchScrapflyLookup({
                queries,
                isbns,
                maxCandidatesPerQuery,
            });

            await persistCostEvents({ costEvents: scrapflyLookup.costEvents, adsId });
        } catch (error) {
            console.error('ISBNSearch Scrapfly lookup crashed:', error?.message || error);
            scrapflyLookup = null;
        }

        if (scrapflyLookup && !scrapflyLookupFailedCompletely(scrapflyLookup)) {
            return { ...scrapflyLookup, provider: 'scrapfly' };
        }
    }

    if (allowApifyFallback && process.env.ISBNSEARCH_APIFY_ENABLED === 'true') {
        console.warn(
            `ISBNSearch falling back to Apify (scrapfly=${scrapflyLookup ? 'failed/blocked' : 'disabled/crashed'}).`
        );

        try {
            const apifyLookup = await runIsbnSearchApifyLookup({
                queries,
                isbns,
                maxCandidatesPerQuery,
            });

            return { ...apifyLookup, costEvents: [], provider: 'apify' };
        } catch (error) {
            console.error('ISBNSearch Apify fallback crashed:', error?.message || error);
        }
    }

    // Return whatever Scrapfly produced (possibly empty) so callers can still
    // use partial results; never throw.
    if (scrapflyLookup) {
        return { ...scrapflyLookup, provider: 'scrapfly' };
    }

    return createEmptyLookup();
}
