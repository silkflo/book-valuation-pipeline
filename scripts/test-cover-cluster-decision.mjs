// scripts/test-cover-cluster-decision.mjs
//
// Offline unit test for the Phase 5b cover-cluster decision (decideUnion).
// Deterministic — no DB, no network, no vision. Proves the 4-outcome logic is
// correct INDEPENDENT of the (noisy) live vision scores, including the exact
// Yvain twin case (0.97 + 0.96 'match' -> selected_cover_ambiguous_isbn, 2 ISBNs).
//   node scripts/test-cover-cluster-decision.mjs

import { decideUnion } from '../src/services/catalog/catalogUnionMatcher.js';

let failures = 0;
function check(label, cond, detail) {
    if (cond) console.log(`  OK  ${label}`);
    else { failures += 1; console.error(`FAIL  ${label}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`); }
}
const c = (isbn13, similarity, confidence, matchStatus) => ({ isbn13, similarity, confidence, matchStatus });

// 1) Yvain twin: two near-identical strong matches -> cover-ambiguous, cluster 2.
{
    const r = decideUnion([
        c('9782012706071', 0.97, 0.92, 'match'),
        c('9782253183228', 0.96, 0.97, 'match'),
        c('9782701196787', 0.72, 0.98, 'mismatch'),
    ]);
    check('Yvain twin -> selected_cover_ambiguous_isbn', r.decision === 'selected_cover_ambiguous_isbn', r.decision);
    check('  cluster size 2', r.clusterSize === 2, r.clusterSize);
    check('  cluster ISBNs are the two twins',
        JSON.stringify(r.ambiguousCluster.map((x) => x.isbn13)) === JSON.stringify(['9782012706071', '9782253183228']),
        r.ambiguousCluster?.map((x) => x.isbn13));
    check('  no exact ISBN', r.selectedExactIsbn === null);
}

// 2) Exactly one strong match -> selected_exact_isbn.
{
    const r = decideUnion([c('A', 0.95, 0.95, 'match'), c('B', 0.60, 0.9, 'mismatch')]);
    check('single strong -> selected_exact_isbn', r.decision === 'selected_exact_isbn', r.decision);
    check('  exact ISBN = A', r.selectedExactIsbn === 'A');
}

// 3) Second "match" is below the similarity floor -> only one strong -> exact.
{
    const r = decideUnion([c('A', 0.95, 0.95, 'match'), c('B', 0.78, 0.95, 'match')]);
    check('sub-floor 2nd match -> selected_exact_isbn', r.decision === 'selected_exact_isbn', r.decision);
}

// 4) Three near-identical strong matches (<=CLUSTER_MAX) -> cover-ambiguous size 3.
{
    const r = decideUnion([c('A', 0.95, 0.95, 'match'), c('B', 0.93, 0.95, 'match'), c('C', 0.90, 0.95, 'match')]);
    check('three twins -> selected_cover_ambiguous_isbn', r.decision === 'selected_cover_ambiguous_isbn', r.decision);
    check('  cluster size 3', r.clusterSize === 3, r.clusterSize);
}

// 5) Four near-identical strong matches (>CLUSTER_MAX) -> needs_verification.
{
    const r = decideUnion([c('A', 0.95, 0.95, 'match'), c('B', 0.93, 0.95, 'match'), c('C', 0.91, 0.95, 'match'), c('D', 0.89, 0.95, 'match')]);
    check('four twins -> needs_verification', r.decision === 'needs_verification', r.decision);
}

// 6) Two strong but top's lead is unclear (0.95 vs 0.82, gap 0.13) -> needs_verification.
{
    const r = decideUnion([c('A', 0.95, 0.95, 'match'), c('B', 0.82, 0.95, 'match')]);
    check('unclear lead (0.13) -> needs_verification', r.decision === 'needs_verification', r.decision);
}

// 7) Best is high-similarity but model says MISMATCH (the live Yvain-this-run case)
//    -> no strong match -> needs_verification (NOT a false select).
{
    const r = decideUnion([c('9782012706071', 0.86, 0.96, 'mismatch')]);
    check('high-sim MISMATCH -> needs_verification', r.decision === 'needs_verification', r.decision);
}

// 8) Nothing resembles the crop -> no_match.
{
    const r = decideUnion([c('A', 0.22, 0.98, 'mismatch'), c('B', 0.18, 0.97, 'mismatch')]);
    check('all low -> no_match', r.decision === 'no_match', r.decision);
}

// 9) Empty -> no_match.
check('empty -> no_match', decideUnion([]).decision === 'no_match');

console.log(failures ? `\n${failures} FAILURE(S)` : '\nCOVER-CLUSTER DECISION LOGIC PASSED');
process.exit(failures ? 1 : 0);
