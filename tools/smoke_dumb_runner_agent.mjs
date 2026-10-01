import { strict as assert } from 'node:assert';
import crypto from 'crypto';

console.log('=== RUNNING WORKER DESKTOP DUMB RUNNER SMOKE TEST ===\n');

// 1. Canonical JSON and HMAC Signature verification
function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function canonicalize(value) {
  if (Array.isArray(value)) return value.map((item) => canonicalize(item));
  if (isPlainObject(value)) {
    const out = {};
    for (const key of Object.keys(value).sort()) {
      out[key] = canonicalize(value[key]);
    }
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(canonicalize(value));
}

function buildSubmitSignature(nodeToken, taskId, claimNonce, submitTimestamp, resultJson) {
  const resultHash = crypto
    .createHash('sha256')
    .update(canonicalJson(resultJson), 'utf8')
    .digest('hex');
  const payload = `${taskId}.${claimNonce}.${submitTimestamp}.${resultHash}`;
  return crypto.createHmac('sha256', nodeToken).update(payload, 'utf8').digest('hex');
}

const testToken = 'test_token_12345';
const taskId = 'e7135e5d-16f5-41e9-a3d8-5ec2781d4a0e';
const nonce = 'claim_nonce_abcdef';
const ts = 1725720000;
const sampleResult = {
  summary: 'Verified task execution',
  details: { b: 2, a: 1 },
  score: 0.99,
};

const sig1 = buildSubmitSignature(testToken, taskId, nonce, ts, sampleResult);
// Key order perturbation must yield the exact same signature (canonicalization)
const sampleResultReordered = {
  score: 0.99,
  details: { a: 1, b: 2 },
  summary: 'Verified task execution',
};
const sig2 = buildSubmitSignature(testToken, taskId, nonce, ts, sampleResultReordered);

assert.equal(sig1, sig2, 'Canonicalization must make key ordering deterministic');
assert.ok(/^[0-9a-f]{64}$/.test(sig1), 'Signature must be a 64-character hex string');
console.log('  ✓ HMAC-SHA256 signature and canonicalization are verified');

// 2. JSON Extraction & Candidate Parsing
function extractLikelyJsonObject(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  if (source.startsWith('{') && source.endsWith('}')) return source;

  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < source.length; index += 1) {
    const char = source[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === '\\') {
      escaped = true;
      continue;
    }
    if (char === '"') {
      inString = !inString;
      continue;
    }
    if (inString) continue;

    if (char === '{') {
      if (start === -1) start = index;
      depth += 1;
      continue;
    }
    if (char === '}') {
      if (depth > 0) depth -= 1;
      if (depth === 0 && start !== -1) {
        return source.slice(start, index + 1).trim();
      }
    }
  }

  return '';
}

function parseJsonCandidate(text, fallback = null) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const rawCandidate = (fenced ? fenced[1] : text || '').trim();
  const candidate = extractLikelyJsonObject(rawCandidate) || rawCandidate;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

// Fenced JSON
const fencedInput = 'Here is the output:\n```json\n{\n  "recommendation": "needs_review",\n  "pass": true\n}\n```\nHope this helps!';
const parsedFenced = parseJsonCandidate(fencedInput);
assert.deepEqual(parsedFenced, { recommendation: 'needs_review', pass: true });
console.log('  ✓ Markdown fenced JSON parsed successfully');

// Embedded JSON without fences
const embeddedInput = 'Model reasoning: I analyzed the chunk.\n{"question":"What is PoUS?","answer":"Proof of Useful Stake","confidence":0.99}\nEnd of response.';
const parsedEmbedded = parseJsonCandidate(embeddedInput);
assert.equal(parsedEmbedded.question, 'What is PoUS?');
assert.equal(parsedEmbedded.confidence, 0.99);
console.log('  ✓ Unfenced embedded JSON extracted and parsed successfully');

// Malformed output -> fallback
const malformedInput = 'I could not produce JSON. Just plain text summary of the proposal.';
const parsedMalformed = parseJsonCandidate(malformedInput, { summary: malformedInput });
assert.equal(parsedMalformed.summary, malformedInput);
console.log('  ✓ Malformed non-JSON output handled gracefully via fallback');

console.log('\n=== ALL DUMB RUNNER SMOKE TESTS PASSED ===');
