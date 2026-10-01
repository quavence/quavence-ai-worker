import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const releaseDir = path.join(root, 'release');
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function formatBytes(bytes) {
  if (bytes >= 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  if (bytes >= 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${bytes} B`;
}

function dirSizeBytes(targetPath) {
  let total = 0;
  if (!fs.existsSync(targetPath)) return 0;
  const stat = fs.statSync(targetPath);
  if (stat.isFile()) return stat.size;
  for (const entry of fs.readdirSync(targetPath, { withFileTypes: true })) {
    total += dirSizeBytes(path.join(targetPath, entry.name));
  }
  return total;
}

function walkFiles(dir, visitor, prefix = dir) {
  if (!fs.existsSync(dir)) return;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkFiles(fullPath, visitor, prefix);
      continue;
    }
    visitor(path.relative(prefix, fullPath).replace(/\\/g, '/'), fullPath);
  }
}

function findUnpackedDir() {
  if (!fs.existsSync(releaseDir)) return null;
  const entries = fs.readdirSync(releaseDir, { withFileTypes: true });
  const unpacked = entries.find((entry) => entry.isDirectory() && entry.name.endsWith('-unpacked'));
  return unpacked ? path.join(releaseDir, unpacked.name) : null;
}

function listAsarFiles(asarPath) {
  const asar = require('@electron/asar');
  return asar.listPackage(asarPath).map((entry) => entry.replace(/^\\+/, '').replace(/\\/g, '/'));
}

const forbiddenPathPatterns = [
  /(^|\/)\.env$/i,
  /(^|\/)worker-config\.json$/i,
  /(^|\/)tools\//i,
  /(^|\/)scripts\//i,
  /(^|\/)logs\//i,
  /(^|\/)models\//i,
  /(^|\/)lm-studio\//i,
  /OllamaSetup\.exe$/i,
  /install-ollama-runtime\.ps1$/i,
  /\.gguf$/i,
  /(^|\/)runtime\/ollama\//i,
  /smoke_.*\.mjs$/i,
  /(^|\/)dist-renderer\/.*\.map$/i,
];

const requiredResourcePaths = [
  'resources/assets/app.ico',
  'resources/assets/tray.ico',
  'QuavenceAIWorker-icon.ico',
];

const requiredAsarPaths = [
  'dist-renderer/index.html',
  'src/main.cjs',
  'src/preload.cjs',
  'src/externalUrlAllowlist.cjs',
  'src/appLifecycle.cjs',
  'src/workerHubErrorTaxonomy.cjs',
  'src/workerHubErrorTaxonomy.mjs',
  'src/hubRequestShared.cjs',
  'src/runtimePolicyShared.cjs',
  'agent/ai_worker_agent.mjs',
  'agent/package.json',
  'agent/aiWorkerModelAliases.json',
  'agent/hub_request.mjs',
  'agent/bountyComposerLlmService.js',
];

const forbiddenAsarPaths = [
  /^tools\//,
  /^scripts\//,
  /^src\/renderer-react\//,
  /\.map$/,
  /\.env$/,
  /worker-config\.json$/,
  /\.gguf$/,
];

const unpackedDir = findUnpackedDir();
assert(unpackedDir, `Expected unpacked app under ${releaseDir} (run npm run pack:dir first)`);

const installerCandidates = [
  path.join(releaseDir, `Quavence-AI-Worker-Setup-${version}.exe`),
  path.join(releaseDir, `Quavence-AI-Worker-Portable-${version}.exe`),
];
const existingInstallers = installerCandidates.filter((filePath) => fs.existsSync(filePath));

const filesystemPaths = [];
walkFiles(unpackedDir, (relativePath) => filesystemPaths.push(relativePath));

for (const required of requiredResourcePaths) {
  const fullPath = path.join(unpackedDir, required.replace(/\//g, path.sep));
  assert(fs.existsSync(fullPath), `Missing required packaged resource: ${required}`);
}

for (const relativePath of filesystemPaths) {
  const normalized = relativePath.replace(/\\/g, '/');
  for (const pattern of forbiddenPathPatterns) {
    assert(!pattern.test(normalized), `Forbidden packaged path present: ${normalized}`);
  }
}

const asarPath = path.join(unpackedDir, 'resources', 'app.asar');
assert(fs.existsSync(asarPath), 'Missing resources/app.asar');

const asarFiles = listAsarFiles(asarPath);
for (const required of requiredAsarPaths) {
  assert(asarFiles.includes(required), `Missing required app.asar entry: ${required}`);
}

for (const entry of asarFiles) {
  for (const pattern of forbiddenAsarPaths) {
    assert(!pattern.test(entry), `Forbidden app.asar entry present: ${entry}`);
  }
}

const unpackedSize = dirSizeBytes(unpackedDir);
const installerSizes = existingInstallers.map((filePath) => ({
  file: path.basename(filePath),
  size: formatBytes(fs.statSync(filePath).size),
}));

console.log('verify_packaged_worker_artifact: PASS');
console.log(`  unpacked: ${path.relative(root, unpackedDir)} (${formatBytes(unpackedSize)})`);
if (installerSizes.length) {
  for (const item of installerSizes) {
    console.log(`  installer: ${item.file} (${item.size})`);
  }
} else {
  console.log('  installers: none (pack:dir only — run dist:win for Setup/Portable exe checks)');
}
console.log(`  asar entries checked: ${asarFiles.length}`);
console.log('  required asar paths:', requiredAsarPaths.join(', '));
console.log('  forbidden paths: absent');
