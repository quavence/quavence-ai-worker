import assert from 'node:assert/strict';
import http from 'node:http';
import {
  isContextOverflowError,
  inferFailReasonCode,
} from '../agent/ai_worker_agent.mjs';
import {
  buildRuntimeAttestation,
  probeOllamaModelDetails,
  fetchLmStudioModelContexts,
} from '../agent/runtime_policy.mjs';

console.log('--- TEST 1: isContextOverflowError Detection ---');
{
  const testCases = [
    // 1. llama.cpp / LM Studio n_ctx & n_keep
    { msg: 'OpenAI-compatible error 400: {"error": "n_keep >= n_ctx (8192)"}', status: 400, expected: true },
    { msg: 'n_ctx is too small for prompt', status: 0, expected: true },
    { msg: 'n_keep exceeds prompt context length', status: 400, expected: true },

    // 2. Explicit context overflow
    { msg: 'context overflow detected during generation', status: 400, expected: true },
    { msg: 'Context length exceeded maximum limit', status: 400, expected: true },
    { msg: 'context is too large for current model', status: 400, expected: true },
    { msg: 'maximum context reached (8192 tokens)', status: 400, expected: true },

    // 3. Prompt length
    { msg: 'prompt is too long for this model', status: 400, expected: true },
    { msg: 'prompt exceeds maximum allowed window', status: 400, expected: true },

    // 4. Memory & KV Cache
    { msg: 'CUDA out of memory. Tried to allocate 2.00 GiB', status: 500, expected: true },
    { msg: 'out of memory while allocating kv cache', status: 400, expected: true },
    { msg: 'llama out of memory during inference', status: 500, expected: true },
    { msg: 'OOM killed: GPU vram allocation failed', status: 500, expected: true },

    // 5. Negative cases (MUST NOT match context_overflow)
    { msg: 'Connection refused (ECONNREFUSED) 127.0.0.1:1234', status: 0, expected: false },
    { msg: 'model not found: qwen/qwen3-vl-8b', status: 404, expected: false },
    { msg: 'Unauthorized: invalid bearer token', status: 401, expected: false },
    { msg: 'OpenAI-compatible error 500: internal server error', status: 500, expected: false },
    { msg: 'timeout waiting for response', status: 504, expected: false },
  ];

  for (const tc of testCases) {
    const result = isContextOverflowError(tc.msg, tc.status);
    assert.equal(
      result,
      tc.expected,
      `Expected isContextOverflowError("${tc.msg}", ${tc.status}) to be ${tc.expected}, got ${result}`
    );
  }
  console.log('✓ PASS: All 18 isContextOverflowError vector tests passed');
}

console.log('\n--- TEST 2: inferFailReasonCode Priority & Status Parsing ---');
{
  // Must return 'context_overflow' even when wrapped in generic OpenAI error
  const lmStudioErr = 'OpenAI-compatible error 400: {"error": "n_keep >= n_ctx"}';
  assert.equal(inferFailReasonCode(lmStudioErr), 'context_overflow');
  assert.equal(inferFailReasonCode(lmStudioErr, 400), 'context_overflow');

  // Regex parsing of status from string
  const oomErr = 'Error 500: CUDA out of memory';
  assert.equal(inferFailReasonCode(oomErr), 'context_overflow');

  // Other reason codes must remain intact
  assert.equal(inferFailReasonCode('unsupported_task_type: xyz'), 'unsupported_task_type');
  assert.equal(inferFailReasonCode('ETIMEDOUT after 120s'), 'timeout');
  assert.equal(inferFailReasonCode('ECONNREFUSED'), 'runtime_unavailable');
  assert.equal(inferFailReasonCode('No models loaded in LM Studio'), 'model_unavailable');
  assert.equal(inferFailReasonCode('OpenAI-compatible error 404: model not found'), 'provider_error');
  assert.equal(inferFailReasonCode('random unknown glitch'), 'unknown');
  console.log('✓ PASS: inferFailReasonCode priorities verified');
}

console.log('\n--- TEST 3: buildRuntimeAttestation Context Clamping & Anti-Spoof ---');
{
  const policy = {
    provider: 'openai_compat',
    generation_model: 'qwen/qwen3-vl-8b',
    embedding_model: 'text-embedding-nomic-embed-text-v1.5',
    runtime_policy_version: 'v1.2.0',
  };

  // Normal context
  const att1 = buildRuntimeAttestation(policy, {
    detected_generation_model: 'qwen3-vl-8b',
    max_context_tokens: 24576,
  });
  assert.equal(att1.max_context_tokens, 24576);

  // Anti-spoof ceiling: 500k clamped to 131072
  const attSpoof = buildRuntimeAttestation(policy, {
    max_context_tokens: 500000,
  });
  assert.equal(attSpoof.max_context_tokens, 131072);

  // Lower bound clamp: 100 clamped to 512
  const attLow = buildRuntimeAttestation(policy, {
    max_context_tokens: 100,
  });
  assert.equal(attLow.max_context_tokens, 512);

  // Fallback to num_ctx
  const attOllama = buildRuntimeAttestation(policy, {
    num_ctx: 16384,
  });
  assert.equal(attOllama.max_context_tokens, 16384);

  // No context detected -> field omitted (Hub defaults to 8192)
  const attDefault = buildRuntimeAttestation(policy, {});
  assert.equal(attDefault.max_context_tokens, undefined);

  console.log('✓ PASS: buildRuntimeAttestation context clamping [512..131072] verified');
}

console.log('\n--- TEST 4: LM Studio v0 Models Probe (Mock Server on Dynamic Port) ---');
{
  // Start mock HTTP server on dynamic port (listen(0))
  const server = http.createServer((req, res) => {
    if (req.url === '/api/v0/models') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        data: [
          { id: 'qwen/qwen3-vl-8b', state: 'loaded', loaded_context_length: 24576 },
          { id: 'qwen/qwen3-vl-8b@4bit', state: 'loaded', max_context_length: 32768 },
          { id: 'llama-3.2-3b', state: 'not_loaded', loaded_context_length: 0 },
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

  try {
    const result = await fetchLmStudioModelContexts(baseUrl);
    assert.equal(result.supported, true);
    assert.equal(result.modelContextLengths['qwen/qwen3-vl-8b'], 24576);
    assert.equal(result.modelContextLengths['qwen/qwen3-vl-8b@4bit'], 32768);
    assert.equal(result.modelContextLengths['llama-3.2-3b'], 8192); // default fallback for 0
    console.log('✓ PASS: fetchLmStudioModelContexts successfully parsed loaded_context_length');
  } finally {
    server.close();
  }
}

console.log('\n--- TEST 5: Fallback when /api/v0/models returns 404 ---');
{
  const server404 = http.createServer((req, res) => {
    res.writeHead(404);
    res.end();
  });
  await new Promise((resolve) => server404.listen(0, '127.0.0.1', resolve));
  const port404 = server404.address().port;
  const baseUrl404 = `http://127.0.0.1:${port404}/v1`;

  try {
    const result = await fetchLmStudioModelContexts(baseUrl404);
    assert.equal(result.supported, false);
    assert.deepEqual(result.modelContextLengths, {});
    console.log('✓ PASS: Graceful fallback on 404 verified');
  } finally {
    server404.close();
  }
}

console.log('\n--- TEST 6: Ollama probeOllamaModelDetails num_ctx Parsing ---');
{
  const ollamaServer = http.createServer(async (req, res) => {
    if (req.url === '/api/show') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({
        parameters: "stop                           \"<|im_start|>\"\nnum_ctx                        32768\n",
        details: { parameter_size: "8B", quantization_level: "Q4_K_M" },
      }));
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  await new Promise((resolve) => ollamaServer.listen(0, '127.0.0.1', resolve));
  const port = ollamaServer.address().port;
  try {
    const details = await probeOllamaModelDetails(`http://127.0.0.1:${port}`, 'qwen:8b');
    assert.equal(details.num_ctx, 32768);
    assert.equal(details.parameter_size, '8B');
    console.log('✓ PASS: probeOllamaModelDetails num_ctx parsed correctly (32768)');
  } finally {
    ollamaServer.close();
  }
}

console.log('\n--- TEST 7: LM Studio Model Contexts TTL Caching ---');
{
  let hits = 0;
  const serverCache = http.createServer((req, res) => {
    hits += 1;
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      data: [{ id: 'qwen3-8b', state: 'loaded', loaded_context_length: 16384 }]
    }));
  });
  await new Promise((resolve) => serverCache.listen(0, '127.0.0.1', resolve));
  const port = serverCache.address().port;
  const baseUrl = `http://127.0.0.1:${port}/v1`;

  try {
    const res1 = await fetchLmStudioModelContexts(baseUrl, '', { bypassCache: true });
    assert.equal(res1.modelContextLengths['qwen3-8b'], 16384);
    assert.equal(hits, 1);

    // Second call within TTL should return cached result without hitting server
    const res2 = await fetchLmStudioModelContexts(baseUrl);
    assert.equal(res2.modelContextLengths['qwen3-8b'], 16384);
    assert.equal(hits, 1, 'Second call should use memory cache and not increment server hits');

    console.log('✓ PASS: TTL caching prevents duplicate /api/v0/models calls');
  } finally {
    serverCache.close();
  }
}

console.log('\n--- TEST 8: Zero Context Protection Guarantee ---');
{
  const attZero = buildRuntimeAttestation({ provider: 'openai_compat' }, { max_context_tokens: 0 });
  assert.equal(attZero.max_context_tokens, undefined, 'Context of 0 must be ignored, allowing Hub default');

  const attNegative = buildRuntimeAttestation({ provider: 'openai_compat' }, { max_context_tokens: -100 });
  assert.equal(attNegative.max_context_tokens, undefined, 'Negative context must be ignored');

  console.log('✓ PASS: Zero and negative context protection verified');
}

console.log('\n======================================================');
console.log('  ALL CONTEXT OVERFLOW & PROBE TESTS PASSED (100% PASS)');
console.log('======================================================\n');
