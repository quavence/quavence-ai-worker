import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'src/renderer-react/App.jsx'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'src/renderer-react/styles.css'), 'utf8');

assert(
  !appSource.includes('app-setting-row-dependent'),
  'App behavior hint row must not use nested dependent class',
);
assert(
  !stylesSource.includes('.app-setting-row-dependent'),
  'dependent row CSS should be removed',
);
assert(
  stylesSource.includes('.app-setting-row.is-disabled'),
  'disabled app setting row style should remain',
);

const appBehaviorBlock = appSource.match(
  /App behavior[\s\S]*?<div className="app-settings-list app-settings-list-compact">([\s\S]*?)<\/div>/
);
assert(appBehaviorBlock, 'App behavior settings block should exist');

const settingRows = [
  ...appBehaviorBlock[1].matchAll(/className="app-setting-row app-setting-row-compact/g),
  ...appBehaviorBlock[1].matchAll(/className=\{`app-setting-row app-setting-row-compact/g),
];
assert(settingRows.length === 5, `App behavior should have 5 flat rows, found ${settingRows.length}`);

assert(
  appBehaviorBlock[1].includes('Show close-to-tray hint')
    && appBehaviorBlock[1].includes('is-disabled'),
  'close-to-tray hint row should support disabled state without nested layout',
);

console.log('smoke_app_behavior_layout: PASS');
