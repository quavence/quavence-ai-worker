import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const source = path.resolve(root, '..', 'src', 'config', 'aiWorkerModelAliases.json');
const target = path.join(root, 'agent', 'aiWorkerModelAliases.json');

if (!fs.existsSync(source)) {
  throw new Error(`Missing model alias catalog source: ${source}`);
}

fs.mkdirSync(path.dirname(target), { recursive: true });
fs.copyFileSync(source, target);
console.log(`sync_model_aliases: ${path.relative(root, target)}`);
