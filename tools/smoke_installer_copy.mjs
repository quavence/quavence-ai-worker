import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const installerNsh = fs.readFileSync(path.join(root, 'build/installer.nsh'), 'utf8');
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));

const requiredTitles = [
  'Install Quavence AI Worker',
  'Quavence AI Worker installed',
  'Uninstall Quavence AI Worker',
  'Quavence AI Worker removed',
];

for (const title of requiredTitles) {
  assert(installerNsh.includes(title), `Missing installer wizard title override: ${title}`);
}

assert(
  !/MUI_(UN)?(?:WELCOME|FINISH)PAGE_TITLE.*Quavence AI Worker Desktop/.test(installerNsh),
  'Wizard title overrides must not use the long Desktop product name',
);

assert(
  pkg.build.productName === 'Quavence AI Worker',
  'NSIS productName should use the short wizard display name',
);
assert(
  installerNsh.includes('QuavenceAIWorker-icon.ico'),
  'Installer shortcuts must reference QuavenceAIWorker-icon.ico instead of the executable icon',
);
assert(
  pkg.build.nsis.shortcutName === 'Quavence AI Worker',
  'Start menu shortcut should use the short display name',
);

console.log('smoke_installer_copy: PASS');
