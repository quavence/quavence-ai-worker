import assert from 'node:assert/strict';
import http from 'node:http';
import {
  isApprovedGenerationModel as isApprovedCjs,
  extractHardwareTier as extractHardwareTierCjs,
  applyPolicyToConfig,
  buildRuntimePolicyIssues
} from '../src/runtimePolicyShared.cjs';
import {
  isApprovedGenerationModel as isApprovedMjs,
  extractHardwareTier as extractHardwareTierMjs,
  verifyLocalRuntimeAgainstPolicy,
  buildRuntimeAttestation
} from '../agent/runtime_policy.mjs';
import {
  WATCHDOG_INFERENCE_TIMEOUT_MS,
  WATCHDOG_EMBEDDING_TIMEOUT_MS
} from '../agent/ai_worker_agent.mjs';

console.log('--- TEST 1: Strict empty-string and null guard ---');
const policyTier2 = {
  enabled: true,
  mode: 'enforce',
  hardware_tier: 2,
  provider: 'openai_compat',
  generation_model: 'qwen2.5-coder-7b-instruct',
  allowed_generation_models: [
    'qwen2.5-coder-7b-instruct',
    'qwen2.5-coder-32b-instruct'
  ],
  embedding_model: 'text-embedding-nomic-embed-text-v1.5'
};

assert.equal(isApprovedCjs(policyTier2, ''), false, 'Empty string must be rejected');
assert.equal(isApprovedCjs(policyTier2, '   '), false, 'Whitespace must be rejected');
assert.equal(isApprovedCjs(policyTier2, null), false, 'null must be rejected');
assert.equal(isApprovedCjs(policyTier2, undefined), false, 'undefined must be rejected');
assert.equal(isApprovedMjs(policyTier2, ''), false, 'mjs: Empty string must be rejected');
assert.equal(isApprovedMjs(policyTier2, null), false, 'mjs: null must be rejected');
console.log('✓ PASS: Empty string protection verified');

console.log('--- TEST 2: Dynamic model approval across Tiers (CJS & MJS parity) ---');
assert.equal(isApprovedCjs(policyTier2, 'qwen2.5-coder-32b-instruct'), true);
assert.equal(isApprovedCjs(policyTier2, 'qwen2.5-coder-7b-instruct'), true);
assert.equal(isApprovedCjs(policyTier2, 'unapproved-random-model'), false);
assert.equal(isApprovedMjs(policyTier2, 'qwen2.5-coder-32b-instruct'), true);
assert.equal(isApprovedMjs(policyTier2, 'qwen2.5-coder-7b-instruct'), true);
assert.equal(isApprovedMjs(policyTier2, 'unapproved-random-model'), false);
console.log('✓ PASS: Dynamic model approval verified');

console.log('--- TEST 3: Hardware Tier extraction ---');
assert.equal(extractHardwareTierCjs(policyTier2), 2);
assert.equal(extractHardwareTierMjs(policyTier2), 2);
assert.equal(extractHardwareTierCjs({ tier: 3 }), 3);
assert.equal(extractHardwareTierMjs({ tier: 3 }), 3);
assert.equal(extractHardwareTierCjs({}), 1);
assert.equal(extractHardwareTierMjs({}), 1);
console.log('✓ PASS: Hardware Tier extraction verified');

console.log('--- TEST 4: Operator model preference preservation ---');
const configWithPreferred32b = {
  llmProvider: 'openai_compat',
  genModel: 'qwen2.5-coder-32b-instruct',
  model: 'qwen2.5-coder-32b-instruct'
};
const mergedConfig = applyPolicyToConfig(configWithPreferred32b, policyTier2);
assert.equal(
  mergedConfig.genModel,
  'qwen2.5-coder-32b-instruct',
  'Operator selected 32B model must NOT be overwritten when approved by policy'
);

const configWithUnapproved = {
  llmProvider: 'openai_compat',
  genModel: 'llama-3-8b',
  model: 'llama-3-8b'
};
const mergedFallback = applyPolicyToConfig(configWithUnapproved, policyTier2);
assert.equal(
  mergedFallback.genModel,
  'qwen2.5-coder-7b-instruct',
  'Unapproved model must be reset to policy default generation_model'
);
console.log('✓ PASS: Operator preference priority verified');

console.log('--- TEST 5: verifyLocalRuntimeAgainstPolicy with Tier 2 preferred 32B ---');
const server = http.createServer((req, res) => {
  if (req.url === '/v1/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        { id: 'qwen2.5-coder-32b-instruct' },
        { id: 'text-embedding-nomic-embed-text-v1.5' }
      ]
    }));
  } else if (req.url === '/api/v0/models') {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [
        { id: 'qwen2.5-coder-32b-instruct', state: 'loaded', loaded_context_length: 32768 }
      ]
    }));
  } else {
    res.writeHead(404);
    res.end();
  }
});
await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const baseUrl = `http://127.0.0.1:${port}/v1`;

const verificationResult = await verifyLocalRuntimeAgainstPolicy({
  policy: policyTier2,
  llmProvider: 'openai_compat',
  baseUrl,
  preferredModel: 'qwen2.5-coder-32b-instruct'
});
server.close();

assert.equal(verificationResult.ok, true, 'Verification must pass for Tier 2 32B node');
assert.equal(verificationResult.hardware_tier, 2);
assert.equal(verificationResult.attestation.generation_model, 'qwen2.5-coder-32b-instruct');
assert.equal(verificationResult.attestation.hardware_tier, 2);
console.log('✓ PASS: Local runtime verification with Tier 2 model verified');

console.log('--- TEST 6: buildRuntimeAttestation with Tier 2 & Tier 3 ---');
const attestationTier2 = buildRuntimeAttestation(policyTier2, {
  detected_generation_model: 'qwen2.5-coder-32b-instruct',
  detected_embedding_model: 'text-embedding-nomic-embed-text-v1.5',
  max_context_tokens: 32768
});
assert.equal(attestationTier2.hardware_tier, 2, 'Attestation must include hardware_tier');
assert.equal(attestationTier2.detected_generation_model, 'qwen2.5-coder-32b-instruct');
assert.equal(attestationTier2.generation_model, 'qwen2.5-coder-32b-instruct');

const policyTier3 = {
  enabled: true,
  mode: 'enforce',
  hardware_tier: 3,
  provider: 'openai_compat',
  generation_model: 'qwen2.5-72b-instruct',
  allowed_generation_models: ['qwen2.5-72b-instruct'],
  embedding_model: 'text-embedding-nomic-embed-text-v1.5'
};
const attestationTier3 = buildRuntimeAttestation(policyTier3, {
  detected_generation_model: 'qwen2.5-72b-instruct',
  detected_embedding_model: 'text-embedding-nomic-embed-text-v1.5'
});
assert.equal(attestationTier3.hardware_tier, 3);
assert.equal(attestationTier3.generation_model, 'qwen2.5-72b-instruct');
console.log('✓ PASS: buildRuntimeAttestation for Tier 2 and Tier 3 verified');

console.log('--- TEST 7: Watchdog Timers Configuration ---');
assert.equal(WATCHDOG_INFERENCE_TIMEOUT_MS, 120000, 'Inference watchdog must be 120s (120000ms)');
assert.equal(WATCHDOG_EMBEDDING_TIMEOUT_MS, 60000, 'Embedding watchdog must be 60s (60000ms)');
console.log('✓ PASS: Watchdog timeouts verified (120s inference, 60s embedding)');

console.log('======================================================');
console.log('  ALL TIER & POLICY PARITY TESTS PASSED (100% OK)');
console.log('======================================================');
