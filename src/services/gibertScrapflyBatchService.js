//src\services\gibertScrapflyBatchService.js
// src/services/gibertScrapflyBatchService.js

import dotenv from 'dotenv';
import * as cheerio from 'cheerio';

dotenv.config();

const SCRAPFLY_API_URL = 'https://api.scrapfly.io/scrape';
const GIBERT_SAO_URL = 'https://www.gibert.com/sao';
const MAX_ISBNS_PER_GIBERT_SUBMIT = 10;

function cleanIsbn(value) {
    if (!value) return null;

    const cleaned = String(value)
        .replace(/[^0-9Xx]/g, '')
        .toUpperCase();

    return cleaned || null;
}

function parseFrenchPrice(value) {
    if (value === null || value === undefined) return null;

    const cleaned = String(value)
        .replace(/\u00a0/g, ' ')
        .replace(/&nbsp;/gi, ' ')
        .replace(',', '.')
        .replace(/[^\d.]/g, '')
        .trim();

    const number = Number(cleaned);

    return Number.isFinite(number) ? number : null;
}

function toUrlSafeBase64(value) {
    return Buffer.from(value, 'utf8')
        .toString('base64')
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/g, '');
}

function getInputWaitMs() {
    // Capped at 9000 so input-wait + result-wait + page render stay within
    // Scrapfly's hard 30s scenario budget.
    return Math.min(Math.max(Number(process.env.GIBERT_INPUT_WAIT_MS || 8000), 2000), 9000);
}

// Shared in-page helpers (injected verbatim into both execute scripts) for
// detecting, enumerating and FORCIBLY REMOVING the Magento amgdprcookie modal.
const COOKIE_HELPERS_JS = `
const COOKIE_BAR_SEL = '.amgdprcookie-bar-container, [data-amcookie-js=bar], .amgdprcookie-modal';
const COOKIE_OVERLAY_SEL = '.modals-overlay';

function cookieBannerPresent() {
  const bar = document.querySelector(COOKIE_BAR_SEL);
  const overlay = document.querySelector(COOKIE_OVERLAY_SEL);
  const barShown = bar && (bar.classList.contains('_show') || bar.offsetParent !== null);
  const overlayShown = overlay && overlay.offsetParent !== null;
  return Boolean(barShown || overlayShown);
}

// Diagnostics: which consent controls exist (goal 5).
function consentInfo() {
  const q = (s) => Boolean(document.querySelector(s));
  return {
    bar: q(COOKIE_BAR_SEL),
    overlay: q(COOKIE_OVERLAY_SEL),
    hasAllow: q('[data-amcookie-js=allow], .amgdprcookie-button.-allow'),
    hasDecline: q('[data-amcookie-js=decline], .amgdprcookie-button.-decline'),
    hasClose: q('[data-amcookie-js=close-cookiebar], .amgdprcookie-bar-container .action-close'),
    bodyHasModal: document.body ? document.body.classList.contains('_has-modal') : false,
  };
}

// Remove the modal + backdrop + body lock outright. No navigation, so the
// #codes input and #add_sao button stay; the overlay that was intercepting the
// submit is gone. Also click the close/decline as a courtesy (best effort).
function killCookieModal() {
  let removed = false;
  document.querySelectorAll(COOKIE_BAR_SEL + ', ' + COOKIE_OVERLAY_SEL).forEach((e) => {
    try { e.remove(); removed = true; } catch (x) {}
  });
  try {
    const close = document.querySelector('[data-amcookie-js=close-cookiebar], .amgdprcookie-bar-container .action-close');
    if (close) close.click();
  } catch (x) {}
  if (document.body) { document.body.classList.remove('_has-modal'); document.body.style.overflow = ''; }
  if (document.documentElement) document.documentElement.classList.remove('_has-modal');
  return removed;
}
`.trim();

// The execute step ONLY clears the cookie modal, waits for the input to exist,
// fills it and verifies it. It does NOT click submit: the /sao form submission
// triggers a real page navigation, which would destroy the execute context
// ("Inspected target navigated or closed"). A native Scrapfly `click` action
// (next scenario stage) performs the submit and survives the navigation.
// Returns a structured { stage, ... } for diagnostics; never throws.
function buildFillScript(codes, inputWaitMs) {
    return `
const codes = ${JSON.stringify(codes)};
const INPUT_WAIT = ${inputWaitMs};
const INPUT_SELECTOR = "input[name='codes']";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snippet = () => (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ').slice(0, 400);

// Gibert's banner is a Magento amgdprcookie MODAL: a
//   <div class="modal-popup _show amgdprcookie-bar-container" data-amcookie-js="bar">
// plus a full-viewport ".modals-overlay" backdrop and a "_has-modal" lock on
// <body>/<html>. The overlay intercepts the #add_sao submit -> empty cart.
${COOKIE_HELPERS_JS}

function diag(stage, extra) {
  return Object.assign({
    stage,
    url: location.href,
    title: document.title || null,
    inputPresent: Boolean(document.querySelector(INPUT_SELECTOR)),
    submitPresent: Boolean(document.querySelector('#add_sao')),
    cookieVisible: cookieBannerPresent(),
    consent: consentInfo(),
    textSnippet: snippet(),
  }, extra || {});
}

// 1) Wait for the ISBN input AND remove the consent modal+overlay on each poll
//    (removal, not clicking: close is unreliable and accept-all reloads & wipes
//    the input). Removal unblocks the later native #add_sao click.
let input = null;
const inputDeadline = Date.now() + INPUT_WAIT;
while (Date.now() < inputDeadline) {
  if (cookieBannerPresent()) killCookieModal();
  input = document.querySelector(INPUT_SELECTOR);
  if (input && !cookieBannerPresent()) break;
  await sleep(300);
}
if (!input) return diag('input_missing');

// 2) Extra removal sweep. If the modal STILL will not go, FAIL EARLY before the
//    submit so we do not waste the click / a provider attempt on a blocked page.
for (let i = 0; i < 6 && cookieBannerPresent(); i += 1) { killCookieModal(); await sleep(200); }
if (cookieBannerPresent()) {
  return diag('consent_modal_blocked', { cookieGone: false });
}

// 3) Set the value via the DOM and fire the events the page listens for.
try {
  input.focus();
  input.value = codes;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new Event('change', { bubbles: true }));
} catch (e) {
  return diag('fill_error', { error: String(e) });
}

// 4) Verify the field really holds the ISBNs before the native click submits.
if (!input.value || !input.value.includes(codes.split(';')[0])) {
  return diag('fill_unverified', { fieldValue: (input.value || '').slice(0, 120) });
}

return diag('filled_ok', { filled: true, cookieGone: !cookieBannerPresent() });
`.trim();
}

// Post-submit diagnostics + row poll. Runs in the navigated results page
// (after the native click). Re-dismisses the cookie banner in case it blocked
// the submit, polls for product rows, and reports rich diagnostics so a
// "filled_ok but no rows" failure can be understood from the log alone.
function buildPostSubmitScript(resultWaitMs) {
    return `
const RESULT_WAIT = ${resultWaitMs};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const snippet = () => (document.body ? document.body.innerText : '').replace(/\\s+/g, ' ');
${COOKIE_HELPERS_JS}

// Remove a re-rendered modal so it cannot cover the results, then poll for rows.
if (cookieBannerPresent()) killCookieModal();
const deadline = Date.now() + RESULT_WAIT;
while (Date.now() < deadline) {
  if (document.querySelector('#product_list tr')) break;
  if (cookieBannerPresent()) killCookieModal();
  await sleep(400);
}

const text = snippet();
const productList = document.querySelector('#product_list');
const priceArea =
  document.querySelector('#total_amount') ||
  document.querySelector('td.repris') ||
  document.querySelector('.repris');
const addSao = document.querySelector('#add_sao');

return {
  stage: 'post_submit',
  url: location.href,
  title: document.title || null,
  hasProductList: Boolean(productList),
  rowCount: document.querySelectorAll('#product_list tr').length,
  hasArtAuto: /l.?art de l.?automobile/i.test(text),
  has13: /13[.,]00|13\\s*€/.test(text),
  cookieVisible: cookieBannerPresent(),
  consent: consentInfo(),
  addSaoHtml: addSao ? addSao.outerHTML.slice(0, 300) : null,
  productListHtml: productList ? productList.outerHTML.slice(0, 4000) : null,
  priceAreaHtml: priceArea ? priceArea.outerHTML.slice(0, 800) : null,
  textSnippet: text.slice(0, 400),
};
`.trim();
}

function buildBatchScenario(codes) {
    const inputWaitMs = getInputWaitMs();
    // Scrapfly hard budget is 30s. Keep rendering + waits + both executes + click < 30s.
    const fillTimeout = Math.min(11000, inputWaitMs + 3000);
    const resultWaitMs = Math.min(Math.max(Number(process.env.GIBERT_RESULT_WAIT_MS || 6000), 3000), 8000);
    const postTimeout = Math.min(11000, resultWaitMs + 3000);

    return JSON.stringify([
        { wait: 600 },
        {
            execute: {
                script: buildFillScript(codes, inputWaitMs),
                timeout: fillTimeout,
            },
        },
        // Native click survives the form's page navigation.
        { click: { selector: '#add_sao' } },
        { wait: 1200 },
        // Post-submit: re-dismiss cookie, poll rows, capture diagnostics.
        {
            execute: {
                script: buildPostSubmitScript(resultWaitMs),
                timeout: postTimeout,
            },
        },
    ]);
}

// Stages that mean the FORM itself failed (vs a transient http/proxy error).
const FORM_FAILURE_STAGES = new Set(['input_missing', 'fill_error', 'fill_unverified', 'submit_missing']);

function diagSaysModalBlocked(d) {
    if (!d) return false;
    return d.stage === 'consent_modal_blocked' || d.fillStage === 'consent_modal_blocked' || d.cookieVisible === true;
}

// Retriable = an INTERMITTENT render-timing miss where the modal was NOT in the
// way (filled+submitted, modal gone, but rows had not rendered yet). When the
// consent modal is still visible / blocked, a retry just wastes a provider
// attempt, so it is NOT retriable (goal 3).
export function isRetriableScenarioFailure(batchResult) {
    const d = batchResult?.diagnostics;
    if (!d) return false;
    if (batchResult?.failureKind === 'consent_modal_blocked' || diagSaysModalBlocked(d)) return false;
    return d.stage === 'post_submit';
}

export function classifyFailureKind(diagnostics, reason) {
    if (diagSaysModalBlocked(diagnostics)) return 'consent_modal_blocked';
    if (diagnostics && FORM_FAILURE_STAGES.has(diagnostics.stage)) return 'scenario_form_failure';
    if (/consent|cookie/i.test(String(reason || ''))) return 'consent_modal_blocked';
    if (/no product rows|not present in the page|did not submit|#add_sao|input\[name/i.test(String(reason || ''))) {
        return 'scenario_form_failure';
    }
    return 'http_error';
}

// Scrapfly exposes the post-scrape cookies; surface them so the real Magento
// consent cookie (amcookie_allowed=...) can be captured and set via
// GIBERT_CONSENT_COOKIE (goal 4/5). Returns a compact "name=value;..." string.
function extractScrapflyCookies(data) {
    const cookies = data?.result?.cookies;
    if (!Array.isArray(cookies) || !cookies.length) return null;
    return cookies
        .map((c) => `${c.name || c.key || '?'}=${String(c.value ?? '').slice(0, 40)}`)
        .join('; ')
        .slice(0, 600);
}

// Merge ALL execute-step results (fill + post-submit). Later steps win, so
// post-submit fields (rowCount, hasProductList, productListHtml, ...) override,
// while fill fields (inputPresent, filled) are retained. The fill `stage` is
// preserved as `fillStage` for debugging.
function extractScenarioDiagnostics(data) {
    const steps = data?.result?.browser_data?.js_scenario?.steps;
    if (!Array.isArray(steps)) return null;

    let merged = null;
    for (const step of steps) {
        if (step?.action === 'execute' && step?.result && typeof step.result === 'object') {
            if (!merged) {
                merged = { ...step.result };
            } else {
                merged = { ...merged, fillStage: merged.stage, ...step.result };
            }
        }
    }
    return merged;
}

function extractScreenshotUrl(data) {
    const shots = data?.result?.screenshots;
    if (shots && typeof shots === 'object') {
        const first = Object.values(shots)[0];
        return first?.url || first || null;
    }
    return null;
}

function extractScrapflyCost(data) {
    // context.cost is an object: { details: [...], total: N }
    const cost =
        data?.context?.cost?.total ??
        data?.context?.cost ??
        data?.result?.cost ??
        data?.cost ??
        null;

    return Number.isFinite(Number(cost)) ? Number(cost) : null;
}

function extractRequestId(data) {
    return (
        data?.context?.request_id ||
        data?.result?.request_id ||
        data?.result?.log_url?.split('/').pop() ||
        null
    );
}

function parseGibertRowsFromHtml(html) {
    const $ = cheerio.load(html || '');

    const rows = [];
    const seen = new Set();

    $('#product_list tr').each((_, element) => {
        const row = $(element);
        const rowText = row.text().replace(/\s+/g, ' ').trim();

        const isbn = rowText.match(/\b97[89][0-9]{10}\b/)?.[0] || null;

        if (!isbn || seen.has(isbn)) {
            return;
        }

        seen.add(isbn);

        const title = row.find('.product-item-name').first().text().replace(/\s+/g, ' ').trim() || null;
        const imageUrl = row.find('img.product-image-photo').first().attr('src') || null;

        const priceText = row.find('td.repris .price').first().text().replace(/\s+/g, ' ').trim() || null;
        const nonReprisText = row.find('td.non-repris').first().text().replace(/\s+/g, ' ').trim() || null;

        const isNonRepris = /non repris/i.test(nonReprisText || rowText);

        const price = priceText ? parseFrenchPrice(priceText) : 0;

        rows.push({
            isbn,
            title,
            imageUrl,
            gibertPrice: Number.isFinite(price) ? price : 0,
            status: isNonRepris ? 'gibert_non_repris' : 'gibert_price_found',
            priceText,
            nonReprisText: nonReprisText || null,
        });
    });

    const totalAmountText = $('#total_amount .price').first().text().replace(/\s+/g, ' ').trim() || null;
    const totalTirelireText = $('#totalTirelire .price').first().text().replace(/\s+/g, ' ').trim() || null;
    const itemCountText = $('#itemscount').first().text().replace(/\s+/g, ' ').trim() || null;

    const totalAmount = parseFrenchPrice(totalAmountText);
    const totalTirelire = parseFrenchPrice(totalTirelireText);

    return {
        rows,
        totalAmount,
        totalAmountText,
        totalTirelire,
        totalTirelireText,
        itemCountText,
    };
}

export async function lookupGibertPricesBatch({
    books,
    adsId = null,
}) {
    if (!Array.isArray(books) || !books.length) {
        throw new Error('lookupGibertPricesBatch missing books array');
    }

    if (!process.env.SCRAPFLY_KEY) {
        throw new Error('Missing SCRAPFLY_KEY in .env');
    }

    if (process.env.SCRAPFLY_ENABLED === 'false') {
        return {
            ok: false,
            skipped: true,
            reason: 'SCRAPFLY_ENABLED=false',
            adsId,
            rows: [],
        };
    }

    const cleanedBooks = books
        .map((book) => ({
            ...book,
            isbn: cleanIsbn(book.isbn),
        }))
        .filter((book) => book.isbn)
        .slice(0, MAX_ISBNS_PER_GIBERT_SUBMIT);

    if (!cleanedBooks.length) {
        throw new Error('lookupGibertPricesBatch has no valid ISBN');
    }

    const requestedIsbns = cleanedBooks.map((book) => book.isbn);
    const codes = requestedIsbns.join(';');

    const scenario = buildBatchScenario(codes);
    const encodedScenario = toUrlSafeBase64(scenario);

    const params = new URLSearchParams();

    // Page-load wait (Scrapfly min 1000); the scenario does the heavy polling,
    // so this can be modest. Total scenario budget stays under Scrapfly's 30s.
    const renderingWait = Math.min(Math.max(Number(process.env.GIBERT_RENDERING_WAIT_MS || 2500), 1000), 4000);

    params.set('key', process.env.SCRAPFLY_KEY);
    params.set('url', GIBERT_SAO_URL);
    params.set('tags', 'books,gibert,batch,project:books-sell');
    params.set('country', 'fr');
    params.set('asp', 'true');
    params.set('render_js', 'true');
    params.set('rendering_wait', String(renderingWait));
    params.set('js_scenario', encodedScenario);

    if (process.env.SCRAPFLY_GIBERT_RESIDENTIAL !== 'false') {
        params.set('proxy_pool', 'public_residential_pool');
    }

    // Optional: pre-accept the Magento amgdprcookie consent so the blocking
    // modal never renders (it intermittently intercepts the #add_sao submit ->
    // empty cart). Set GIBERT_CONSENT_COOKIE once the exact production cookie
    // value is captured (e.g. "amcookie_allowed=...") from a consented session.
    if (process.env.GIBERT_CONSENT_COOKIE) {
        params.set('cookies', process.env.GIBERT_CONSENT_COOKIE);
    }

    // Optional full-page screenshot for failure diagnostics (adds Scrapfly
    // credits — off by default since this provider is cost-sensitive).
    if (process.env.GIBERT_DEBUG_SCREENSHOTS === 'true') {
        params.set('screenshots[gibert]', 'fullpage');
    }

    console.log(
        `Gibert batch lookup started adsId=${adsId || ''}, books=${cleanedBooks.length}, ISBNs=${requestedIsbns.join(', ')}`
    );

    const response = await fetch(`${SCRAPFLY_API_URL}?${params.toString()}`, {
        method: 'GET',
        headers: {
            Accept: 'application/json',
        },
    });

    const responseText = await response.text();

    let data;
    try {
        data = JSON.parse(responseText);
    } catch (error) {
        throw new Error(`Scrapfly JSON parse failed: ${responseText.slice(0, 500)}`);
    }

    const result = data.result || {};
    const html = result.content || '';

    const scrapflyCost = extractScrapflyCost(data);
    const requestId = extractRequestId(data);
    const diagnostics = extractScenarioDiagnostics(data);
    const screenshotUrl = extractScreenshotUrl(data);
    const cookiesSeen = extractScrapflyCookies(data);

    if (!response.ok || result.success === false) {
        const reason = result.error?.message || result.reason || data.message || 'Scrapfly request failed';
        return {
            ok: false,
            failureKind: classifyFailureKind(diagnostics, reason),
            adsId,
            requestedIsbns,
            rows: [],
            missingIsbns: requestedIsbns,
            statusCode: result.status_code || response.status,
            reason,
            scrapflyCost,
            requestId,
            logUrl: result.log_url || null,
            diagnostics,
            screenshotUrl,
            cookiesSeen,
            raw: {
                error: result.error || null,
            },
        };
    }

    let parsed = parseGibertRowsFromHtml(html);

    // Robustness: result.content can be captured a beat before the rows are in
    // the DOM, but the post-submit execute snapshotted #product_list directly.
    // Parse that fragment when the page HTML yielded nothing.
    if (!parsed.rows.length && diagnostics?.productListHtml) {
        const fromDiag = parseGibertRowsFromHtml(diagnostics.productListHtml);
        if (fromDiag.rows.length) {
            console.log(
                `Gibert: parsed ${fromDiag.rows.length} row(s) from post-submit diagnostics fragment (result.content had none).`
            );
            parsed = fromDiag;
        }
    }

    const byIsbn = new Map(parsed.rows.map((row) => [row.isbn, row]));

    const rows = requestedIsbns
        .map((isbn) => byIsbn.get(isbn))
        .filter(Boolean);

    const missingIsbns = requestedIsbns.filter((isbn) => !byIsbn.has(isbn));

    // Zero parsed rows for a non-empty submission means the FORM flow failed
    // (input never appeared / cookie wall / did not submit), not that every
    // ISBN is unknown — even unknown and "non repris" ISBNs produce rows. This
    // is a technical failure (failureKind=scenario_form_failure): the caller
    // must NOT stamp gibert_checked_at and must NOT spend single fallbacks on
    // the same broken page.
    if (!rows.length) {
        const stage = diagnostics?.stage || 'unknown';
        // Distinguish a consent-modal block (the modal was still up) from a
        // generic form failure, so the caller can fail fast without retrying.
        const failureKind = classifyFailureKind(diagnostics, '') === 'consent_modal_blocked'
            ? 'consent_modal_blocked'
            : 'scenario_form_failure';
        return {
            ok: false,
            failureKind,
            adsId,
            requestedIsbns,
            rows: [],
            missingIsbns: requestedIsbns,
            statusCode: result.status_code || response.status,
            reason: `Gibert returned no product rows (scenario stage=${stage}, failureKind=${failureKind})`,
            scrapflyCost,
            requestId,
            logUrl: result.log_url || null,
            diagnostics,
            screenshotUrl,
            cookiesSeen,
        };
    }

    const sumRows = Number(
        rows.reduce((sum, row) => sum + Number(row.gibertPrice || 0), 0).toFixed(2)
    );

    return {
        ok: true,
        adsId,
        requestedIsbns,
        rows,
        missingIsbns,
        totalAmount: parsed.totalAmount,
        totalAmountText: parsed.totalAmountText,
        totalTirelire: parsed.totalTirelire,
        totalTirelireText: parsed.totalTirelireText,
        itemCountText: parsed.itemCountText,
        sumRows,
        totalMatchesRows:
            Number.isFinite(parsed.totalAmount)
                ? Math.abs(sumRows - parsed.totalAmount) < 0.01
                : null,
        scrapflyCost,
        requestId,
        logUrl: result.log_url || null,
        diagnostics,
    };
}
