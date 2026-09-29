// src/services/triggerMomoxActor.js

import dotenv from 'dotenv';
import { apifyClient } from './apifyClient.js';

dotenv.config();

function cleanIsbn(value) {
    if (!value) return null;
    const cleaned = String(value).replace(/[^0-9Xx]/g, '').toUpperCase();
    return cleaned || null;
}

function cleanBookForMomox(book) {
    const cleanIsbnValue = cleanIsbn(book.isbn);
    const cleanIsbn13 = cleanIsbn(book.isbn13) || cleanIsbnValue;
    const cleanIsbn10 = cleanIsbn(book.isbn10);

    if (!cleanIsbnValue && !cleanIsbn13 && !cleanIsbn10) {
        return null;
    }

    return {
        isbn: cleanIsbnValue || cleanIsbn13 || cleanIsbn10,
        isbn13: cleanIsbn13,
        isbn10: cleanIsbn10,
        title: book.title || null,
        aiConfidence: book.aiConfidence ?? null,
        isbnConfidence: book.isbnConfidence ?? null,
        cost: book.cost ?? null,
    };
}

export async function triggerMomoxActorForAd({
    adsId,
    books,
    cost,
    maxBooksPerRun = 10,
}) {
    if (!adsId) {
        throw new Error('triggerMomoxActorForAd missing adsId');
    }

    if (!Array.isArray(books) || !books.length) {
        throw new Error('triggerMomoxActorForAd missing books array');
    }

    if (!process.env.MOMOX_ACTOR_ID) {
        throw new Error('Missing MOMOX_ACTOR_ID in .env');
    }

    if (!process.env.PUBLIC_WEBHOOK_BASE_URL) {
        throw new Error('Missing PUBLIC_WEBHOOK_BASE_URL in .env');
    }

    if (!process.env.WEBHOOK_SECRET) {
        throw new Error('Missing WEBHOOK_SECRET in .env');
    }

    const callbackUrl = `${process.env.PUBLIC_WEBHOOK_BASE_URL}/webhooks/momox?secret=${process.env.WEBHOOK_SECRET}`;

    const cleanedBooks = books
        .map((book) =>
            cleanBookForMomox({
                ...book,
                cost: book.cost ?? cost ?? null,
            })
        )
        .filter(Boolean)
        .slice(0, maxBooksPerRun);

    if (!cleanedBooks.length) {
        throw new Error(`triggerMomoxActorForAd has no valid ISBN candidates for adsId=${adsId}`);
    }

    const input = {
        adsId,
        cost: cost ?? null,
        books: cleanedBooks,

        webhookUrl: callbackUrl,

        useProxy: true,
        proxyGroup: 'RESIDENTIAL',
        proxyCountryCode: 'FR',

        maxRequestRetries: 2,
        resultTimeoutMs: 30000,
        requestHandlerTimeoutSecs: 900,
        waitBetweenBooksMs: 3000,
    };

    console.log(
        `Triggering Momox actor once for adsId=${adsId}, books=${cleanedBooks.length}, ISBNs=${cleanedBooks
            .map((book) => book.isbn)
            .join(', ')}`
    );

    const run = await apifyClient.actor(process.env.MOMOX_ACTOR_ID).call(input, {
        memory: 1024,
        timeout: 600,
    });

    console.log(
        `Momox actor finished for adsId=${adsId}: runId=${run.id}, status=${run.status}`
    );

    if (run.status !== 'SUCCEEDED') {
        throw new Error(
            `Momox actor run ${run.id} did not succeed (status=${run.status}) for adsId=${adsId}`
        );
    }

    return {
        runId: run.id,
        status: run.status,
        actorId: process.env.MOMOX_ACTOR_ID,
        adsId,
        booksSent: cleanedBooks.length,
    };
}

// Keep backward compatibility for old code if something still imports this function.
export async function triggerMomoxActorForBook({
    adsId,
    isbn,
    isbn10,
    isbn13,
    title,
    aiConfidence,
    isbnConfidence,
    cost,
}) {
    return triggerMomoxActorForAd({
        adsId,
        cost,
        books: [
            {
                isbn,
                isbn10,
                isbn13,
                title,
                aiConfidence,
                isbnConfidence,
                cost,
            },
        ],
        maxBooksPerRun: 1,
    });
}
