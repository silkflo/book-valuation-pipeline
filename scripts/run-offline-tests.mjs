import { readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
// These original integration scripts require the separate application database.
const databaseTests = new Set(['test-lart-provider-send.mjs', 'test-provider-fanout.mjs']);
const tests = readdirSync(new URL('./', import.meta.url))
    .filter(name => /^test-.*\.mjs$/.test(name) && !databaseTests.has(name)).sort();
let failed = 0;
for (const name of tests) {
    // Do not inherit provider keys or database credentials from the host.
    const result = spawnSync(process.execPath, [
        '--import', './scripts/offline-guard.mjs', `scripts/${name}`,
    ], {
        cwd: root, encoding: 'utf8', timeout: 45000, maxBuffer: 4 * 1024 * 1024,
        env: {
            PATH: process.env.PATH,
            ...(process.env.SystemRoot ? { SystemRoot: process.env.SystemRoot } : {}),
            NODE_ENV: 'test', TZ: 'UTC',
            DATABASE_URL: 'postgres://test:test@127.0.0.1:1/offline_test',
            OPENAI_API_KEY: 'test-placeholder', APIFY_TOKEN: 'test-placeholder',
            WEBHOOK_SECRET: 'test-secret',
            PUBLIC_WEBHOOK_BASE_URL: 'https://webhook.example.test',
            GOOGLE_LENS_ACTOR_ID: 'test-actor',
        },
    });
    if (result.status === 0 && !result.error) {
        console.log(`PASS ${name}`);
    } else {
        failed++;
        console.error(`FAIL ${name}\n${result.stdout || ''}${result.stderr || ''}`);
        if (result.error) console.error(result.error.message);
    }
}
console.log(`\n${tests.length - failed}/${tests.length} offline test scripts passed.`);
process.exitCode = failed ? 1 : 0;
