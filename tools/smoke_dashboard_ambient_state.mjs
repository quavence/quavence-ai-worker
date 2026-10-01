import { resolveDashboardAmbientState } from '../src/renderer-react/workerUiHelpers.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const running = { running: true };

assert(
  resolveDashboardAmbientState({ uiState: { phase: 'ready' }, status: running }) === 'off',
  'stopped worker should disable ambient',
);
assert(
  resolveDashboardAmbientState({ uiState: { phase: 'terms_required' } }) === 'off',
  'terms required should disable ambient',
);
assert(
  resolveDashboardAmbientState({ startPending: true, uiState: { phase: 'starting' } }) === 'starting',
  'starting should pulse',
);
assert(
  resolveDashboardAmbientState({
    uiState: { phase: 'running_idle' },
    status: running,
  }) === 'idle',
  'running idle should use static glow',
);
assert(
  resolveDashboardAmbientState({
    uiState: { phase: 'running_active' },
    status: running,
    currentTask: { type: 'consensus' },
  }) === 'active',
  'running with task should animate',
);
assert(
  resolveDashboardAmbientState({
    uiState: { phase: 'running_active' },
    status: running,
    currentTask: null,
  }) === 'idle',
  'running without task must not use active animation',
);

console.log('smoke_dashboard_ambient_state: PASS');
