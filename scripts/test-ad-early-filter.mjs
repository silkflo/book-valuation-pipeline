// scripts/test-ad-early-filter.mjs
//
// OFFLINE / $0 tests for the deterministic early non-book ad filter. Pure, no DB/AI/network.
//   node scripts/test-ad-early-filter.mjs

import { classifyAdBookRelevance, shouldRejectAsNonBook } from '../src/services/adEarlyFilter.js';

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };

const verdict = (title) => classifyAdBookRelevance({ title });
const rejected = (title) => shouldRejectAsNonBook(verdict(title));

// Reject ONLY when isBookRelevant === false && confidence === 'high'.
const KEEP_BOOK = [
    'Lot de livres enfants',
    'Mangas Naruto tome 1 à 10',
    'BD Astérix',
    'Roman policier',
    'Livre scolaire maths 5ème',
    'Coffret livres Harry Potter',
    'Dictionnaire Larousse',
];
const REJECT = [
    'DVD Harry Potter',
    'Blu-ray collection',
    'Jeu PS4',
    'Puzzle enfant',
    'Figurine manga',
    'Carte Pokémon lot',
    'Meuble bibliothèque',
    'CD audio',
    'Vinyle',
    'VHS',
];
const AMBIGUOUS_KEEP = [
    'Coffret Harry Potter',
    'Collection enfant',
    'Lot culturel',
    'Manga figurine + livre',
    'BD + DVD',
];

console.log('KEEP (clear book signals -> not rejected):');
for (const t of KEEP_BOOK) {
    const v = verdict(t);
    ok(`keep "${t}" (isBookRelevant, not rejected, reason=${v.reason})`, v.isBookRelevant === true && !shouldRejectAsNonBook(v));
}

console.log('\nREJECT (clear non-book, no book signal -> rejected high):');
for (const t of REJECT) {
    const v = verdict(t);
    ok(`reject "${t}" (false+high, reason=${v.reason})`, v.isBookRelevant === false && v.confidence === 'high' && shouldRejectAsNonBook(v));
}

console.log('\nAMBIGUOUS (book signal present or no decisive non-book -> KEEP):');
for (const t of AMBIGUOUS_KEEP) {
    const v = verdict(t);
    ok(`keep "${t}" (not rejected, reason=${v.reason})`, !shouldRejectAsNonBook(v));
}

console.log('\nspecific behaviors:');
ok('book noun overrides a co-occurring non-book ("Livre DVD apprendre anglais")', !rejected('Livre DVD apprendre anglais'));
ok('"BD + DVD collector" kept (bd wins)', !rejected('BD + DVD collector'));
ok('book-title words that look like media are NOT rejected ("Le jeu de la dame")', !rejected('Le jeu de la dame'));
ok('"Journal d\'Anne Frank" not rejected (journal singular ignored)', !rejected("Journal d'Anne Frank"));
ok('description carries the signal too', shouldRejectAsNonBook(classifyAdBookRelevance({ title: 'Lot à vendre', description: 'Console PS5 + manette, état neuf' })));
ok('raw_data category contributes', shouldRejectAsNonBook(classifyAdBookRelevance({ title: 'À donner', rawData: { category_name: 'Jeux & Jouets', tags: ['puzzle'] } })));
ok('empty ad -> kept (low, ambiguous)', (() => { const v = classifyAdBookRelevance({}); return v.isBookRelevant && v.confidence === 'low' && !shouldRejectAsNonBook(v); })());
ok('result shape is complete', (() => {
    const v = verdict('DVD');
    return typeof v.isBookRelevant === 'boolean' && ['high', 'medium', 'low'].includes(v.confidence)
        && typeof v.reason === 'string' && Array.isArray(v.matchedSignals);
})());

console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
