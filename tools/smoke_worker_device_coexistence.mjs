#!/usr/bin/env node
import { strict as assert } from 'node:assert';
import http from 'node:http';
import { createRequire } from 'node:module';
import {
  classifyWorkerApiError,
  classifyHubAccessFailureFromApi,
  parseWorkerStopReasonLine,
  shouldFatalStopWorker,
  mapStopReasonToWorkerExitReason,
} from '../src/workerHubErrorTaxonomy.mjs';
import {
  classifyHubAccessFailure,
  deriveWorkerUiState,
  inferHubStateFromLogLine,
  mapSuspensionCodeToHubState,
  resolveSuspensionPresentation,
  hubStateLabel,
} from '../src/renderer-react/workerUiHelpers.js';
import {
  isWorkerDeviceBindingError,
} from '../agent/ai_worker_agent.mjs';

const require = createRequire(import.meta.url);
const main = require('../src/main.cjs');

console.log('=== WORKER DEVICE BINDING COEXISTENCE & STANDBY SUITE ===\n');

// ---------------------------------------------------------------------------
// Vector 1: Taxonomy Parity & False Positive Prevention
// ---------------------------------------------------------------------------
console.log('[Vector 1] Taxonomy Parity & False Positive Prevention');

// 1.1 HTTP 409 worker_device_conflict
assert.equal(
  classifyWorkerApiError({ status: 409, code: 'worker_device_conflict' }),
  'device_conflict',
  'HTTP 409 worker_device_conflict must classify as device_conflict',
);
assert.equal(
  classifyHubAccessFailureFromApi({ status: 409, code: 'worker_device_conflict' }),
  'hub_suspended_device_conflict',
  'HTTP 409 worker_device_conflict must map to hub_suspended_device_conflict',
);

// 1.2 HTTP 423 worker_device_binding_active
assert.equal(
  classifyWorkerApiError({ status: 423, code: 'worker_device_binding_active' }),
  'device_conflict',
  'HTTP 423 worker_device_binding_active must classify as device_conflict',
);
assert.equal(
  classifyHubAccessFailureFromApi({ status: 423, code: 'worker_device_binding_active' }),
  'hub_suspended_device_conflict',
  'HTTP 423 worker_device_binding_active must map to hub_suspended_device_conflict',
);

// 1.3 Pure HTTP 423 Locked with no body
assert.equal(
  classifyWorkerApiError({ status: 423 }),
  'device_conflict',
  'Bare HTTP 423 with no body must strictly classify as device_conflict',
);
assert.notEqual(
  classifyWorkerApiError({ status: 423 }),
  'hub_suspended',
  'Bare HTTP 423 must never return generic hub_suspended',
);
assert.equal(
  classifyHubAccessFailureFromApi({ status: 423 }),
  'hub_suspended_device_conflict',
  'Bare HTTP 423 must map to hub_suspended_device_conflict',
);

// 1.4 Agent isWorkerDeviceBindingError checks
assert.ok(isWorkerDeviceBindingError({ status: 423 }), 'Agent recognizes status 423 as device binding error');
assert.ok(
  isWorkerDeviceBindingError({ status: 409, data: { code: 'worker_device_conflict' } }),
  'Agent recognizes worker_device_conflict',
);
assert.ok(
  isWorkerDeviceBindingError({ status: 409, data: { code: 'worker_device_binding_active' } }),
  'Agent recognizes worker_device_binding_active',
);
assert.ok(
  isWorkerDeviceBindingError({ status: 409, data: { code: 'worker_device_id_required' } }),
  'Agent recognizes worker_device_id_required',
);
assert.ok(
  isWorkerDeviceBindingError({ status: 409, data: { code: 'worker_device_id_invalid' } }),
  'Agent recognizes worker_device_id_invalid',
);

// 1.5 Log parsing & fatal stop checks
const stopLine = 'WORKER_STOP_REASON code=device_conflict http=409 message="bound to another device"';
const parsedStop = parseWorkerStopReasonLine(stopLine);
assert.equal(parsedStop?.code, 'device_conflict', 'Log line parses device_conflict');
assert.equal(inferHubStateFromLogLine(stopLine), 'hub_suspended_device_conflict', 'Infer hub state from stop line');
assert.equal(mapStopReasonToWorkerExitReason('device_conflict'), 'device_conflict', 'Map stop reason to exit reason');
assert.equal(mapStopReasonToWorkerExitReason('hub_suspended_device_conflict'), 'device_conflict', 'Map hub state to exit reason');
assert.ok(shouldFatalStopWorker('device_conflict'), 'shouldFatalStopWorker for device_conflict must be true');
assert.ok(shouldFatalStopWorker('hub_suspended_device_conflict'), 'shouldFatalStopWorker for hub_suspended_device_conflict must be true');

console.log('  ✓ Vector 1 PASSED: Error taxonomy invariants verified\n');

// ---------------------------------------------------------------------------
// Vector 2: UI Presentation & Differentiation
// ---------------------------------------------------------------------------
console.log('[Vector 2] UI Presentation & Differentiation');

const presentation = resolveSuspensionPresentation({ code: 'device_conflict' });
assert.equal(presentation.title, 'Device binding conflict', 'Title must strictly be "Device binding conflict"');
assert.ok(!/suspended/i.test(presentation.title), 'Title must not contain "Suspended"');
assert.ok(!/banned/i.test(presentation.title), 'Title must not contain "Banned"');
assert.equal(presentation.actionLabel, 'Reset on Workers page', 'Action label must be "Reset on Workers page"');
assert.equal(presentation.actionTarget, 'open-external', 'Action target must be "open-external"');
assert.equal(presentation.externalUrl, 'https://quavence.com/dashboard/workers', 'Default external URL');

// UI state derivation for conflict
const uiState = deriveWorkerUiState({
  hasUsableToken: true,
  runtimeCheck: { ollamaReachable: true, generationModelAvailable: true },
  llmProvider: 'ollama',
  status: { running: false },
  logs: [],
  hubState: 'hub_suspended_device_conflict',
});
assert.equal(uiState.title, 'Device binding conflict', 'UI title matches');
assert.equal(uiState.actionLabel, 'Reset on Workers page', 'UI action label matches');
assert.notEqual(uiState.actionLabel, 'Replace token', 'Must not suggest Replace token for device conflict');
assert.equal(hubStateLabel('hub_suspended_device_conflict'), 'Device binding conflict', 'Hub state label matches');

console.log('  ✓ Vector 2 PASSED: UI presentation invariants verified\n');

// ---------------------------------------------------------------------------
// Vector 3: Registry Query Invariants & Safe Fallback
// ---------------------------------------------------------------------------
console.log('[Vector 3] Registry Query Invariants & Safe Fallback');

// 3.1 Device ID format validation regex
const DEVICE_ID_REGEX = /^[0-9a-zA-Z_\-]{6,128}$/;
assert.ok(DEVICE_ID_REGEX.test('qt-worker-0123456789ab'), 'Valid Qt worker format');
assert.ok(DEVICE_ID_REGEX.test('hw-abcdef0123456789abcdef0123456789'), 'Valid hardware format');
assert.ok(DEVICE_ID_REGEX.test('f738941c-b8e7-4f67-8d19-322409f5e128'), 'Valid UUID format');
assert.ok(DEVICE_ID_REGEX.test('device_node_1'), 'Valid custom format');

// Invalid inputs must be rejected
assert.ok(!DEVICE_ID_REGEX.test(''), 'Empty string is invalid');
assert.ok(!DEVICE_ID_REGEX.test('12345'), 'Too short (< 6 chars) is invalid');
assert.ok(!DEVICE_ID_REGEX.test('bad id with spaces'), 'Spaces are invalid');
assert.ok(!DEVICE_ID_REGEX.test('bad;command-injection'), 'Semicolons are invalid');
assert.ok(!DEVICE_ID_REGEX.test('bad\r\ninjection'), 'Newlines are invalid');
assert.ok(!DEVICE_ID_REGEX.test('x'.repeat(129)), 'Too long (> 128 chars) is invalid');

// 3.2 Simulated reg.exe stdout parser check
const mockRegStdout = 'HKEY_CURRENT_USER\\Software\\Quavence\\Quavence-Qt\\AIWorker\r\n    deviceId    REG_SZ    qt-worker-9f8e7d6c5b4a\r\n';
const regMatch = mockRegStdout.match(/deviceId\s+REG_\w+\s+([^\r\n]+)/i);
assert.ok(regMatch && regMatch[1], 'Match regex finds deviceId');
const extractedVal = regMatch[1].trim();
assert.equal(extractedVal, 'qt-worker-9f8e7d6c5b4a', 'Extracted deviceId matches');
assert.ok(DEVICE_ID_REGEX.test(extractedVal), 'Extracted deviceId passes format regex');

// 3.3 ensureWorkerDeviceId fallback logic
const validCustom = main.ensureWorkerDeviceId({ deviceId: 'qt-worker-custom123' });
assert.ok(DEVICE_ID_REGEX.test(validCustom), 'ensureWorkerDeviceId returns valid format');
if (!main.readQtWorkerDeviceIdFromRegistry()) {
  assert.equal(validCustom, 'qt-worker-custom123', 'Preserves valid config deviceId when registry absent');
  const fallback = main.ensureWorkerDeviceId({ deviceId: 'invalid!' });
  assert.ok(fallback.startsWith('hw-'), 'Falls back to hardware fingerprint on invalid ID');
}

console.log('  ✓ Vector 3 PASSED: Registry query and ID validation invariants verified\n');

// ---------------------------------------------------------------------------
// Vector 4: Standby Release Payload Integrity
// ---------------------------------------------------------------------------
console.log('[Vector 4] Standby Release Payload Integrity');

let receivedBeacon = null;
const beaconServer = http.createServer((req, res) => {
  let body = '';
  req.on('data', (chunk) => {
    body += chunk;
  });
  req.on('end', () => {
    receivedBeacon = {
      method: req.method,
      url: req.url,
      headers: req.headers,
      body: body ? JSON.parse(body) : null,
    };
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ ok: true, node: { is_compute_ready: false } }));
  });
});

await new Promise((resolve) => beaconServer.listen(0, '127.0.0.1', resolve));
const beaconPort = beaconServer.address().port;

try {
  await main.sendStandbyBeacon(
    {
      apiUrl: `http://127.0.0.1:${beaconPort}`,
      token: 'test_session_token_123',
      deviceId: 'qt-worker-standbytest01',
    },
    'Worker stopped by user',
  );

  assert.ok(receivedBeacon, 'Server received the standby beacon request');
  assert.equal(receivedBeacon.method, 'POST', 'Beacon must be a POST request');
  assert.equal(receivedBeacon.url, '/api/ai/nodes/heartbeat', 'Beacon endpoint must be /api/ai/nodes/heartbeat');
  assert.equal(
    receivedBeacon.headers['authorization'],
    'Bearer test_session_token_123',
    'Authorization header must match token',
  );
  assert.equal(
    receivedBeacon.headers['x-ai-worker-device-id'],
    'qt-worker-standbytest01',
    'X-AI-Worker-Device-ID header must match deviceId',
  );
  assert.ok(
    Boolean(receivedBeacon.headers['x-ai-worker-hardware-fingerprint']),
    'X-AI-Worker-Hardware-Fingerprint header must be present',
  );

  // Payload assertions
  assert.equal(receivedBeacon.body?.device_id, 'qt-worker-standbytest01', 'Body device_id matches');
  assert.equal(receivedBeacon.body?.compute_ready, false, 'compute_ready must strictly be false');
  assert.equal(receivedBeacon.body?.reason, 'Worker stopped by user', 'reason must be "Worker stopped by user"');
  assert.ok(
    Boolean(receivedBeacon.body?.hardware_fingerprint),
    'hardware_fingerprint must be present in body',
  );
} finally {
  await new Promise((resolve) => beaconServer.close(resolve));
}

console.log('  ✓ Vector 4 PASSED: Standby release payload integrity verified\n');

// ---------------------------------------------------------------------------
// Vector 5: Fail-Open / Non-Blocking Exit Invariant
// ---------------------------------------------------------------------------
console.log('[Vector 5] Fail-Open / Non-Blocking Exit Invariant');

// 5.1 Unreachable backend (ECONNREFUSED) must not throw or hang
const refusedT0 = Date.now();
let refusedError = null;
try {
  // Use a port where no server is listening
  await main.sendStandbyBeacon(
    {
      apiUrl: 'http://127.0.0.1:49151',
      token: 'test_token',
      deviceId: 'qt-worker-refused01',
    },
    'Worker stopped by user',
  );
} catch (err) {
  refusedError = err;
}
const refusedElapsed = Date.now() - refusedT0;
assert.equal(refusedError, null, 'Must fail-open silently without throwing error on network refusal');
assert.ok(refusedElapsed < 1500, `Refusal must complete fast, took ${refusedElapsed}ms`);

// 5.2 Server that hangs must timeout within <= 2500ms (+ 500ms buffer)
const hangingServer = http.createServer((_req, _res) => {
  // Intentionally never respond to simulate socket hang / packet blackhole
});
await new Promise((resolve) => hangingServer.listen(0, '127.0.0.1', resolve));
const hangingPort = hangingServer.address().port;

try {
  const hangT0 = Date.now();
  let hangError = null;
  try {
    await main.sendStandbyBeacon(
      {
        apiUrl: `http://127.0.0.1:${hangingPort}`,
        token: 'test_token',
        deviceId: 'qt-worker-hangtest01',
      },
      'Worker stopped by user',
    );
  } catch (err) {
    hangError = err;
  }
  const hangElapsed = Date.now() - hangT0;
  assert.equal(hangError, null, 'Must fail-open silently on request timeout');
  assert.ok(
    hangElapsed >= 2300 && hangElapsed <= 3500,
    `Request must timeout around 2500ms (elapsed: ${hangElapsed}ms)`,
  );
} finally {
  await new Promise((resolve) => hangingServer.close(resolve));
}

console.log('  ✓ Vector 5 PASSED: Fail-open and non-blocking timeout invariants verified\n');

console.log('=== ALL 5 VECTORS PASSED (100% OK) ===');
