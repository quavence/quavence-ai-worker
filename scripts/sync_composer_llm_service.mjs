import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const files = [
  'bountyComposerLlmService.js',
  'bountyDomainProfiles.js',
];

for (const fileName of files) {
  const source = path.resolve(root, '..', 'src', 'services', fileName);
  const target = path.join(root, 'agent', fileName);

  if (!fs.existsSync(source)) {
    throw new Error(`Missing composer LLM service source: ${source}`);
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  console.log(`sync_composer_llm_service: ${path.relative(root, target)}`);
}

