#!/usr/bin/env node
import {
  classifyWorkerApiError,
  classifyHubAccessFailureFromApi,
  parseWorkerStopReasonLine,
  shouldFatalStopWorker,
} from '../src/workerHubErrorTaxonomy.mjs';
import {
  classifyHubAccessFailure,
  deriveWorkerUiState,
  inferHubStateFromLogLine,
} from '../src/renderer-react/workerUiHelpers.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(
  classifyWorkerApiError({ status: 401, error: 'Invalid node token', code: 'invalid_node_token' }) === 'token_invalid',
  '401 invalid token',
);
assert(
  classifyWorkerApiError({ status: 403, error: 'Node is not active', code: 'node_not_active' }) === 'hub_suspended',
  '403 node not active',
);
assert(
  classifyWorkerApiError({ status: 409, code: 'ai_worker_duplicate_task_attempt' }) === 'duplicate_blocked',
  '409 duplicate blocked',
);
assert(
  classifyWorkerApiError({ status: 409, code: 'ai_worker_terms_required' }) === 'terms_required',
  '409 terms required',
);
assert(
  classifyWorkerApiError({ status: 409, code: 'ai_worker_runtime_policy_mismatch' }) === 'runtime_blocked',
  '409 runtime blocked',
);
assert(
  classifyWorkerApiError({ status: 429, error: 'rate_limit' }) === 'throttled',
  '429 throttled',
);
assert(
  classifyWorkerApiError({ error: 'Network error: Connect Timeout Error' }) === 'retrying',
  'connect timeout retrying',
);
assert(
  classifyWorkerApiError({ error: 'Network error: fetch failed (ETIMEDOUT)' }) === 'retrying',
  'network timeout retrying',
);

assert(
  classifyHubAccessFailure({ status: 403, error: 'Forbidden' }) === 'hub_suspended',
  '403 forbidden must not map to token_invalid',
);
assert(
  classifyHubAccessFailure({ status: 409, code: 'ai_worker_duplicate_task_attempt' }) === null,
  'duplicate blocked must not become hub access block',
);

const stopLine = 'WORKER_STOP_REASON code=hub_suspended http=403 message="Node is not active"';
assert(parseWorkerStopReasonLine(stopLine)?.code === 'hub_suspended', 'parse stop reason line');
assert(inferHubStateFromLogLine(stopLine) === 'hub_suspended', 'infer hub suspended from stop line');

const duplicateUi = deriveWorkerUiState({
  hasUsableToken: true,
  runtimeCheck: { ollamaReachable: true, generationModelAvailable: true },
  llmProvider: 'ollama',
  status: { running: true },
  logs: [],
  hubState: 'duplicate_blocked',
});
assert(duplicateUi.actionLabel !== 'Replace token', 'duplicate blocked must not offer replace token');
assert(duplicateUi.title === 'Task already completed', 'duplicate blocked title');

const suspendedUi = deriveWorkerUiState({
  hasUsableToken: true,
  runtimeCheck: { ollamaReachable: true, generationModelAvailable: true },
  llmProvider: 'ollama',
  status: { running: false },
  logs: [],
  hubState: 'hub_suspended',
  suspension: { code: 'hub_suspended', reason: 'Worker access suspended' },
});
assert(suspendedUi.actionLabel !== 'Replace token', 'suspended must not offer replace token');
assert(suspendedUi.actionLabel === 'Open Worker page', 'suspended CTA');

const invalidUi = deriveWorkerUiState({
  hasUsableToken: true,
  runtimeCheck: { ollamaReachable: true, generationModelAvailable: true },
  llmProvider: 'ollama',
  status: { running: false },
  logs: [],
  hubState: 'token_invalid',
});
assert(invalidUi.actionLabel === 'Replace token', 'token invalid should offer replace token');

assert(!shouldFatalStopWorker('duplicate_blocked'), 'duplicate must not fatal stop');
assert(shouldFatalStopWorker('token_invalid'), 'token invalid should fatal stop');

console.log('smoke_worker_error_classification: ALL OK');
