import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
function files(dir) {
    return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
        const path = join(dir, entry.name);
        return entry.isDirectory() ? files(path) : /\.(mjs|js)$/.test(path) ? [path] : [];
    });
}
let failures = 0;
const paths = [...files(join(root, 'src')), ...files(join(root, 'scripts'))];
for (const path of paths) {
    const result = spawnSync(process.execPath, ['--check', path], { encoding: 'utf8' });
    if (result.status !== 0) { failures++; console.error(result.stderr); }
}
console.log(`Syntax checked ${paths.length} JavaScript files: ${failures} failures.`);
process.exitCode = failures ? 1 : 0;
