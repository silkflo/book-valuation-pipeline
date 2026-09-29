// scripts/test-catalog-union-plan.mjs
//
// OFFLINE / $0 unit tests for the deterministic pre-AI catalog candidate planning
// (planUnionCompares): cover-URL dedupe, pipeline-first + title-similarity ranking,
// CATALOG_MATCH_MAX_COMPARE cap applied AFTER dedupe, and the budget stats. No network,
// no AI. This is the logic that bounds catalog_cover_verify fan-out per book.
//
//   node scripts/test-catalog-union-plan.mjs

import assert from 'node:assert';

process.env.CATALOG_MATCH_MAX_COMPARE = '3';
process.env.CATALOG_PREFILTER_TITLE_MIN = '0'; // prefilter off by default

const { planUnionCompares, titleSimilarity } = await import('../src/services/catalog/catalogUnionMatcher.js');

let pass = 0, fail = 0;
const ok = (n, c) => { c ? (pass++, console.log('  PASS', n)) : (fail++, console.log('  FAIL', n)); };

const cand = (isbn13, imageUrl, { title = 'Le Petit Prince', flags = ['abebooks_keyword'] } = {}) =>
    ({ isbn13, imageUrl, title, author: 'Saint-Exupery', sourceFlags: flags });

try {
    console.log('title similarity:');
    ok('identical titles -> 1', titleSimilarity('Le Petit Prince', 'le petit prince') === 1);
    ok('no overlap -> 0', titleSimilarity('Dune', 'Le Petit Prince') === 0);
    ok('partial overlap in (0,1)', titleSimilarity('Le Petit Prince', 'Le Prince') > 0 && titleSimilarity('Le Petit Prince', 'Le Prince') < 1);

    console.log('\ncover-URL dedupe + cap after dedupe:');
    // 5 candidates, ISBNs A/B share cover c1; C/D share c2; E has c3 -> 3 unique covers.
    const c = [
        cand('9780000000001', 'https://cdn/c1.jpg'),
        cand('9780000000002', 'https://cdn/c1.jpg'),
        cand('9780000000003', 'https://cdn/c2.jpg'),
        cand('9780000000004', 'https://cdn/c2.jpg'),
        cand('9780000000005', 'https://cdn/c3.jpg'),
    ];
    const p = planUnionCompares({ candidates: c, detectedTitle: 'Le Petit Prince' });
    ok('candidateRows counts all with-cover (5)', p.candidateRows === 5);
    ok('uniqueCandidates = distinct covers (3)', p.uniqueCandidates === 3);
    ok('skippedDedupe = 5 - 3 = 2', p.skippedDedupe === 2);
    ok('toCompare capped at 3', p.toCompare.length === 3);
    ok('each compared candidate carries its full coverIsbnGroup', p.toCompare.every((x) => Array.isArray(x.coverIsbnGroup) && x.coverIsbnGroup.length >= 1));
    const grp = p.toCompare.find((x) => x.imageUrl === 'https://cdn/c1.jpg');
    ok('c1 group has both ISBNs (reissues)', grp && grp.coverIsbnGroup.length === 2);

    console.log('\ncap bites after dedupe (10 distinct covers -> 3):');
    const many = Array.from({ length: 10 }, (_, i) => cand(`97800000001${i}0`, `https://cdn/u${i}.jpg`));
    const pm = planUnionCompares({ candidates: many, detectedTitle: 'Le Petit Prince' });
    ok('uniqueCandidates = 10', pm.uniqueCandidates === 10);
    ok('toCompare capped at 3', pm.toCompare.length === 3);
    ok('cappedOut = 7', pm.cappedOut === 7);

    console.log('\nranking: pipeline ISBNs first, then title similarity:');
    const mixed = [
        cand('9781111111111', 'https://cdn/k1.jpg', { title: 'Le Petit Prince edition exacte', flags: ['abebooks_keyword'] }),
        cand('9782222222222', 'https://cdn/ppl.jpg', { title: 'Totally Different Book', flags: ['pipeline'] }),
        cand('9783333333333', 'https://cdn/k2.jpg', { title: 'Le Petit Prince', flags: ['abebooks_keyword'] }),
    ];
    const pr = planUnionCompares({ candidates: mixed, detectedTitle: 'Le Petit Prince' });
    ok('pipeline candidate ranked first despite low title sim', (pr.toCompare[0].sourceFlags || []).includes('pipeline'));
    ok('keyword candidates follow, best title-sim first', pr.toCompare[1].imageUrl === 'https://cdn/k2.jpg');

    console.log('\nno-cover candidates excluded:');
    const withMissing = [cand('9784444444444', null), cand('9785555555555', 'https://cdn/x.jpg')];
    const pmiss = planUnionCompares({ candidates: withMissing, detectedTitle: 'Le Petit Prince' });
    ok('candidate without imageUrl excluded', pmiss.candidateRows === 1 && pmiss.toCompare.length === 1);

    console.log('\noptional low-floor title prefilter (only drops non-pipeline, never pipeline):');
    const floorCands = [
        cand('9786666666666', 'https://cdn/p.jpg', { title: 'Zzz Qqq Www', flags: ['pipeline'] }),   // pipeline, no overlap -> KEEP
        cand('9787777777777', 'https://cdn/k.jpg', { title: 'Zzz Qqq Www', flags: ['abebooks_keyword'] }), // keyword, no overlap -> DROP
        cand('9788888888888', 'https://cdn/g.jpg', { title: 'Le Petit Prince', flags: ['abebooks_keyword'] }),
    ];
    const pf = planUnionCompares({ candidates: floorCands, detectedTitle: 'Le Petit Prince', titleFloor: 0.1 });
    ok('low-overlap keyword candidate dropped', pf.skippedLowScore === 1);
    ok('pipeline candidate kept despite no overlap', pf.toCompare.some((x) => (x.sourceFlags || []).includes('pipeline')));

    console.log('\nexplicit maxCompare overrides env cap:');
    const p2 = planUnionCompares({ candidates: many, detectedTitle: 'x', maxCompare: 2 });
    ok('maxCompare=2 -> toCompare length 2', p2.toCompare.length === 2);

    console.log(`\n${fail ? 'FAILED' : 'ALL PASS'}: ${pass} passed, ${fail} failed`);
    process.exit(fail ? 1 : 0);
} catch (error) {
    console.error('TEST CRASHED:', error);
    process.exit(1);
}
