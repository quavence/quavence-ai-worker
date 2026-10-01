import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const build = pkg.build || {};

assert(build.appId === 'com.quavence.ai-worker', 'appId should be com.quavence.ai-worker');
assert(build.productName === 'Quavence AI Worker', 'productName should use short NSIS wizard name');
assert(build.directories?.output === 'release', 'build output should be release/');

const fileEntries = build.files || [];
assert(fileEntries.some((entry) => String(entry).includes('dist-renderer')), 'files whitelist must include dist-renderer');
assert(fileEntries.some((entry) => String(entry).includes('agent')), 'files whitelist must include agent');
assert(pkg.scripts['sync:composer-llm'], 'sync:composer-llm script must exist to vendor bountyComposerLlmService.js');
assert(fileEntries.some((entry) => String(entry).includes('externalUrlAllowlist.cjs')), 'files whitelist must include externalUrlAllowlist.cjs');
assert(!fileEntries.some((entry) => /^src\/renderer-react/.test(String(entry))), 'renderer source must not be packaged');
assert(fileEntries.some((entry) => String(entry).includes('!tools')), 'files must explicitly exclude tools');

const extraResources = JSON.stringify(build.extraResources || []);
assert(!extraResources.includes('OllamaSetup.exe'), 'Ollama installer must not be bundled');
assert(!extraResources.includes('"runtime"'), 'bundled runtime folder must not be packaged');
assert(extraResources.includes('app.ico'), 'app.ico must be in extraResources');

assert(Array.isArray(build.win?.target) && build.win.target.includes('nsis'), 'win target must include nsis');
assert(Array.isArray(build.win?.target) && build.win.target.includes('portable'), 'win target must include portable');

assert(pkg.scripts['dist:win'], 'dist:win script must exist');
assert(pkg.scripts['verify:dist'], 'verify:dist script must exist');

const prodDeps = Object.keys(pkg.dependencies || {});
assert(prodDeps.includes('keytar'), 'keytar must remain a production dependency');
assert(!prodDeps.includes('react'), 'react should be bundled via vite, not production dependency');

console.log('smoke_packaging_contract: PASS');
