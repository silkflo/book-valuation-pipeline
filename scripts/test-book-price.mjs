// scripts/test-book-price.mjs
//
// OFFLINE / $0 tests for per-book seller-price parsing + matching. Pure functions, no DB.
//   node scripts/test-book-price.mjs

import assert from 'node:assert';
import {
    parseBookPricesFromDescription,
    matchBookPriceToDetectedBook,
    normalizeFrenchPriceToNumber,
    singleBookAdPrice,
    parseTitleFallbackPrice,
    computeSellerBookPrices,
} from '../src/services/bookPriceFromDescription.js';

let pass = 0;
let fail = 0;
function ok(name, cond) {
    if (cond) { console.log(`  PASS  ${name}`); pass += 1; }
    else { console.log(`  FAIL  ${name}`); fail += 1; }
}

console.log('normalizeFrenchPriceToNumber:');
ok("'2,5 €' -> 2.5", normalizeFrenchPriceToNumber('2,5 €') === 2.5);
ok("'1,5€' -> 1.5", normalizeFrenchPriceToNumber('1,5€') === 1.5);
ok("'0,5€' -> 0.5", normalizeFrenchPriceToNumber('0,5€') === 0.5);
ok("'2€' -> 2", normalizeFrenchPriceToNumber('2€') === 2);
ok("'2 €' -> 2", normalizeFrenchPriceToNumber('2 €') === 2);
ok('garbage -> null', normalizeFrenchPriceToNumber('abc') === null);
ok('negative -> null', normalizeFrenchPriceToNumber('-1') === null);

const DESCRIPTION = `Livres divers à vendre en très bon état :
- "Con Brio" Brina Svit ed Métailié/ 2€
- "Deuil interdit" Michael Connelly / 2,5 €
- "Panique à Porterhouse" Tom Sharpe / 1,5€
- "Le baiser de la veuve" André Héléna / 0,5€`;

console.log('\nparseBookPricesFromDescription:');
const parsed = parseBookPricesFromDescription(DESCRIPTION);
ok('parsed 4 priced lines (header + bundles skipped)', parsed.length === 4);
const byTitle = Object.fromEntries(parsed.map((e) => [e.title, e.price]));
ok('Con Brio -> 2.00', byTitle['Con Brio'] === 2);
ok('Deuil interdit -> 2.50', byTitle['Deuil interdit'] === 2.5);
ok('Panique à Porterhouse -> 1.50', byTitle['Panique à Porterhouse'] === 1.5);
ok('Le baiser de la veuve -> 0.50', byTitle['Le baiser de la veuve'] === 0.5);
ok('author captured (Con Brio -> Brina Svit, no publisher)', parsed.find((e) => e.title === 'Con Brio')?.author === 'Brina Svit');
ok('rawLine preserved', parsed.every((e) => typeof e.rawLine === 'string' && e.rawLine.length));

console.log('\nmatchBookPriceToDetectedBook:');
ok('detected "Con Brio" -> 2.00', matchBookPriceToDetectedBook({ title: 'Con Brio' }, parsed) === 2);
ok('detected "Deuil interdit" -> 2.50', matchBookPriceToDetectedBook({ title: 'Deuil interdit' }, parsed) === 2.5);
ok('detected "Le baiser de la veuve" -> 0.50', matchBookPriceToDetectedBook({ title: 'Le baiser de la veuve' }, parsed) === 0.5);
ok('case/accents-insensitive match', matchBookPriceToDetectedBook({ title: 'panique a porterhouse' }, parsed) === 1.5);
ok('containment match (extra subtitle)', matchBookPriceToDetectedBook({ title: 'Con Brio (roman)' }, parsed) === 2);
ok('unlisted title -> null', matchBookPriceToDetectedBook({ title: 'Some Unlisted Book' }, parsed) === null);
ok('empty title -> null', matchBookPriceToDetectedBook({ title: '' }, parsed) === null);
ok('no entries -> null', matchBookPriceToDetectedBook({ title: 'Con Brio' }, []) === null);

console.log('\nambiguity + safety:');
const dupTitle = [
    { title: 'Trilogie', author: 'Auteur A', price: 5 },
    { title: 'Trilogie', author: 'Auteur B', price: 9 },
];
ok('same title, different prices, no author -> null', matchBookPriceToDetectedBook({ title: 'Trilogie' }, dupTitle) === null);
ok('same title, author disambiguates -> 9', matchBookPriceToDetectedBook({ title: 'Trilogie', author: 'Auteur B' }, dupTitle) === 9);
ok('same title, SAME price -> that price', matchBookPriceToDetectedBook({ title: 'Trilogie' }, [
    { title: 'Trilogie', author: 'X', price: 4 }, { title: 'Trilogie', author: 'Y', price: 4 },
]) === 4);
ok('unquoted line WITH a separator now parses (title + price)', (() => {
    const e = parseBookPricesFromDescription('- Some book without quotes / 3€');
    return e.length === 1 && e[0].price === 3 && /some book without quotes/i.test(e[0].title);
})());
ok('unquoted line with NO separator/tome/quote is skipped (conservative)', parseBookPricesFromDescription('Envoi rapide possible 3€').length === 0);
ok('line with no price is skipped', parseBookPricesFromDescription('- "A title with no price"').length === 0);

console.log('\nsingle-book ad price:');
ok("ad price 2 -> 2.00", singleBookAdPrice(2) === 2);
ok("ad price '2.5' -> 2.50", singleBookAdPrice('2.5') === 2.5);
ok('free/0 -> null', singleBookAdPrice(0) === null);
ok('null -> null', singleBookAdPrice(null) === null);
ok('negative -> null', singleBookAdPrice(-3) === null);
ok('one detected book + ad price 2 -> 2.00', (() => {
    const r = computeSellerBookPrices({ books: [{ title: 'Le Petit Prince' }], adPriceAmount: 2 });
    return r.length === 1 && r[0].price === 2 && r[0].source === 'single_ad_price';
})());
ok('one detected book + free price -> null', (() => {
    const r = computeSellerBookPrices({ books: [{ title: 'Le Petit Prince' }], adPriceAmount: 0, description: '', adTitle: '' });
    return r[0].price === null && r[0].source === 'none';
})());
ok('multi-book ad NEVER uses the (summed) ad price per book', (() => {
    const r = computeSellerBookPrices({ books: [{ title: 'A' }, { title: 'B' }], adPriceAmount: 10, description: '', adTitle: '' });
    return r.every((x) => x.price === null);
})());

console.log('\nunquoted description lines (separators, tomes, decimal comma):');
const realAcct = parseBookPricesFromDescription('Real Account tome 1 : 2€');
ok('Real Account tome 1 : 2€ -> title=Real Account, vol 1, 2.00', realAcct.length === 1 && realAcct[0].price === 2 && realAcct[0].volume === 1 && /real account/i.test(realAcct[0].title));
ok('matched to detected "Real Account tome 1" -> 2.00', matchBookPriceToDetectedBook({ title: 'Real Account tome 1' }, realAcct) === 2);
const bb = parseBookPricesFromDescription('Black Butler tome 1 : 1,50€');
ok('Black Butler tome 1 : 1,50€ -> 1.50 (decimal comma)', bb[0].price === 1.5 && bb[0].volume === 1);
ok("'Title - 2€' (spaced dash) parses", parseBookPricesFromDescription('Naruto - 2€')[0].price === 2);
ok("'Title 2€' bare (no sep) is skipped", parseBookPricesFromDescription('Naruto 2€').length === 0);

console.log('\nmulti-volume group line (tome 1 et 2 : 3€):');
const bleach = parseBookPricesFromDescription('Bleach tome 1 et 2 : 3€');
ok('expands to 2 volume entries', bleach.length === 2 && bleach[0].volume === 1 && bleach[1].volume === 2);
ok('lot price split 3/2 = 1.50 each (no per-unit wording)', bleach.every((e) => e.price === 1.5 && e.distributed === true));
ok('detected "Bleach tome 1" -> 1.50', matchBookPriceToDetectedBook({ title: 'Bleach tome 1' }, bleach) === 1.5);
ok('detected "Bleach tome 2" -> 1.50', matchBookPriceToDetectedBook({ title: 'Bleach tome 2' }, bleach) === 1.5);
ok('detected "Bleach tome 5" (not listed) -> null', matchBookPriceToDetectedBook({ title: 'Bleach tome 5' }, bleach) === null);
const bleachEach = parseBookPricesFromDescription('Bleach tome 1 et 2 : 3€ chacun');
ok("'3€ chacun' -> 3.00 each (per-unit wording)", bleachEach.every((e) => e.price === 3 && e.distributed === false));
const naruto = parseBookPricesFromDescription('Naruto tomes 1 à 3 : 9€');
ok("'tomes 1 à 3 : 9€' -> vols [1,2,3] @ 3.00 each", naruto.length === 3 && naruto.every((e) => e.price === 3));
ok('bare "tomes 1 à 3 : 10€" (no series title) -> skipped', parseBookPricesFromDescription('tomes 1 à 3 : 10€').length === 0);

console.log('\ntitle fallback:');
ok("'Mangas 2€ pièce' -> per-book 2.00", (() => { const f = parseTitleFallbackPrice('Mangas 2€ pièce', 3); return f.perBook === 2 && f.mode === 'title_per_unit'; })());
ok("'Livres 1€ chacun' -> 1.00", parseTitleFallbackPrice('Livres 1€ chacun', 5).perBook === 1);
ok("'Mangas 3€ l’unité' -> 3.00", parseTitleFallbackPrice('Mangas 3€ l’unité', 4).perBook === 3);
ok("'Lot de 10 livres 20€' + 10 detected -> 2.00 (safe distribute)", (() => { const f = parseTitleFallbackPrice('Lot de 10 livres 20€', 10); return f.perBook === 2 && f.mode === 'title_lot_distributed'; })());
ok("'Lot de 10 livres 20€' + 5 detected -> null (unsafe)", (() => { const f = parseTitleFallbackPrice('Lot de 10 livres 20€', 5); return f.perBook === null && /lot_unsafe/.test(f.reason); })());
ok("'Lot de 10 livres 20€' + 3 detected -> NOT 20 each", parseTitleFallbackPrice('Lot de 10 livres 20€', 3).perBook === null);
ok('plain title with a price but no per-unit/lot wording -> null', parseTitleFallbackPrice('Roman policier 5€', 4).perBook === null);
ok('title fallback applied to all books when no description price', (() => {
    const r = computeSellerBookPrices({ books: [{ title: 'X' }, { title: 'Y' }], adPriceAmount: null, description: '', adTitle: 'Mangas 2€ pièce' });
    return r.every((x) => x.price === 2 && x.source === 'title_per_unit');
})());
ok('description price wins over title fallback per book', (() => {
    const r = computeSellerBookPrices({
        books: [{ title: 'Bleach tome 1' }, { title: 'Naruto tome 1' }],
        adPriceAmount: null,
        description: 'Bleach tome 1 : 5€',
        adTitle: 'Mangas 2€ pièce',
    });
    const byTitleSrc = r.map((x) => `${x.price}/${x.source}`);
    return byTitleSrc[0] === '5/description' && byTitleSrc[1] === '2/title_per_unit';
})());

console.log('\nambiguity + volume safety:');
const sameTitleVols = parseBookPricesFromDescription('Gamaran tome 1 : 2€\nGamaran tome 2 : 3€');
ok('same title different volumes resolve by tome (t1 -> 2.00)', matchBookPriceToDetectedBook({ title: 'Gamaran tome 1' }, sameTitleVols) === 2);
ok('same title different volumes resolve by tome (t2 -> 3.00)', matchBookPriceToDetectedBook({ title: 'Gamaran tome 2' }, sameTitleVols) === 3);
ok('same title, unknown detected volume, different listed prices -> null', matchBookPriceToDetectedBook({ title: 'Gamaran' }, sameTitleVols) === null);
ok('no price found anywhere -> null', computeSellerBookPrices({ books: [{ title: 'Z' }], adPriceAmount: null, description: 'rien ici', adTitle: 'Lecture' })[0].price === null);

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
