import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const preloadSource = fs.readFileSync(path.join(root, 'src', 'preload.cjs'), 'utf8');
const mainSource = fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');

const invokeChannels = [...preloadSource.matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map((match) => match[1]);
const handleChannels = [...mainSource.matchAll(/ipcMain\.handle\('([^']+)'/g)].map((match) => match[1]);

const uniqueInvoke = [...new Set(invokeChannels)];
const uniqueHandle = new Set(handleChannels);
const missing = uniqueInvoke.filter((channel) => !uniqueHandle.has(channel));
const extra = [...uniqueHandle].filter((channel) => !uniqueInvoke.includes(channel));

if (missing.length) {
  console.error('Missing ipcMain.handle for preload invoke channels:');
  for (const channel of missing) console.error(`  - ${channel}`);
  process.exit(1);
}

console.log(`IPC smoke OK: ${uniqueInvoke.length} preload invoke channels registered in main.cjs`);
if (extra.length) {
  console.log(`Note: ${extra.length} main handlers without preload invoke (${extra.join(', ')})`);
}
