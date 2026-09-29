// src/services/bookColumns.js
//
// Runtime capability check for optional books columns. The app DB role cannot
// run DDL (table owned by the admin role), so momox_status may not exist yet:
// scripts/sql/add_momox_status.sql must be applied manually. Until then the
// writers skip the column and the global "status" field carries the Momox
// lifecycle, exactly as before.

import { pool } from '../db.js';

// One cached information_schema lookup of every books column. Optional columns
// (momox_status, ai_isbn_*, selected_isbn*, provider_match_*) only exist once
// the migrations are applied; until then the writers degrade gracefully.
let booksColumnsPromise = null;
const warnedColumns = new Set();

// Columns whose absence should be announced once (they gate documented features).
const WARNED_COLUMN_HINTS = {
    momox_status: 'Apply scripts/sql/add_momox_status.sql with the admin role. Falling back to the global status field until then.',
    selected_isbn: 'Apply scripts/sql/003_resale_strategy_fields.sql with the admin role. selected_isbn/provider_match_* tracking is disabled until then.',
};

async function loadBooksColumns() {
    if (!booksColumnsPromise) {
        booksColumnsPromise = pool
            .query(
                `
                SELECT column_name
                FROM information_schema.columns
                WHERE table_name = 'books'
                `
            )
            .then((result) => new Set(result.rows.map((row) => row.column_name)))
            .catch((error) => {
                booksColumnsPromise = null; // allow re-check after transient DB errors
                console.warn('books column introspection failed:', error?.message || error);
                return new Set();
            });
    }

    return booksColumnsPromise;
}

/**
 * True when books.<name> exists. Cached for the process lifetime; warns once
 * for feature-gating columns listed in WARNED_COLUMN_HINTS.
 */
export async function hasBooksColumn(name) {
    const columns = await loadBooksColumns();
    const exists = columns.has(name);

    if (!exists && WARNED_COLUMN_HINTS[name] && !warnedColumns.has(name)) {
        warnedColumns.add(name);
        console.warn(`books.${name} column is missing. ${WARNED_COLUMN_HINTS[name]}`);
    }

    return exists;
}

export function hasMomoxStatusColumn() {
    return hasBooksColumn('momox_status');
}

const PROVIDER_STATUS_WHITELIST = new Set([
    // Shared: the row was deliberately NOT sent to a provider (eligibility held
    // it, or it has no usable ISBN). Distinct from a provider that ran and
    // returned no offer (*_no_offer / *_non_repris). Price stays NULL.
    'not_sent',
    'momox_pending',
    'momox_price_found',
    'momox_no_offer',
    'momox_failed',
    'gibert_pending',
    'gibert_price_found',
    'gibert_non_repris',
    'gibert_missing',
    'gibert_failed',
]);

/**
 * Render a provider status as a safe SQL literal (or NULL). Statuses are
 * server-controlled constants; the whitelist makes embedding them in dynamic
 * SQL fragments injection-proof without disturbing positional parameters.
 */
export function providerStatusLiteral(status) {
    if (status === null || status === undefined) {
        return 'NULL';
    }

    if (!PROVIDER_STATUS_WHITELIST.has(status)) {
        throw new Error(`Unknown provider status: ${status}`);
    }

    return `'${status}'`;
}

/**
 * Render a short, server-controlled string as a safe SQL literal (or NULL).
 * Strips everything except a conservative charset (no quotes/backslashes), so
 * it is injection-proof for embedding in dynamic SQL fragments without shifting
 * positional parameters. For free AI text use a bound parameter instead.
 */
export function safeTextLiteral(value, maxLen = 120) {
    if (value === null || value === undefined || value === '') {
        return 'NULL';
    }

    const cleaned = String(value).replace(/[^a-zA-Z0-9 _.:\-/]/g, '').slice(0, maxLen);

    return cleaned ? `'${cleaned}'` : 'NULL';
}
