#!/usr/bin/env node
import {
  deriveWorkerUiState,
  hubStateLabel,
  mapSuspensionCodeToHubState,
  resolveOverviewHubState,
  resolveSuspensionPresentation,
} from '../src/renderer-react/workerUiHelpers.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const workerPageUrl = 'https://quavence.com/worker';

const runtimePolicyOverview = resolveOverviewHubState({
  ok: true,
  data: {
    terms: { required: false, accepted: true },
    node: { status: 'suspended' },
    suspension: {
      code: 'runtime_policy_mismatch',
      reason: 'Runtime policy mismatch',
      action_url: `${workerPageUrl}`,
      recoverable: true,
    },
  },
});
assert(runtimePolicyOverview.hubState === 'hub_suspended_runtime_policy', 'runtime suspension hub state');
const runtimeUi = deriveWorkerUiState({
  hasUsableToken: true,
  hubState: runtimePolicyOverview.hubState,
  suspension: runtimePolicyOverview.suspension,
  workerPageUrl,
});
assert(runtimeUi.title === 'Suspended: runtime policy mismatch', 'runtime suspension title');
assert(runtimeUi.actionLabel === 'Open Worker page', 'runtime suspension CTA');
assert(runtimeUi.actionTarget === 'open-external', 'runtime suspension opens external browser');

const duplicateOverview = resolveOverviewHubState({
  ok: true,
  data: {
    terms: { required: false, accepted: true },
    node: { status: 'suspended' },
    suspension: {
      code: 'duplicate_task_attempt',
      reason: 'Duplicate task attempt blocked',
      action_url: workerPageUrl,
    },
  },
});
assert(duplicateOverview.hubState === 'hub_suspended_duplicate_task', 'duplicate suspension hub state');
assert(
  hubStateLabel(duplicateOverview.hubState, duplicateOverview.suspension).includes('duplicate'),
  'duplicate hub label',
);

const adminPresentation = resolveSuspensionPresentation({
  code: 'admin_suspended',
  reason: 'Suspended by administrator',
  action_url: 'https://quavence.com/admin/depin',
});
assert(adminPresentation.actionLabel === 'Open Admin review', 'admin review CTA');

assert(mapSuspensionCodeToHubState('token_revoked') === 'token_invalid', 'revoked maps to token_invalid');

const { isAllowedExternalUrl } = await import('../src/externalUrlAllowlist.cjs');
assert(isAllowedExternalUrl('https://quavence.com/worker'), 'desktop allowlist accepts quavence worker url');
assert(!isAllowedExternalUrl('https://evil.example/worker'), 'desktop allowlist rejects unknown host');
assert(isAllowedExternalUrl('https://lmstudio.ai'), 'desktop allowlist accepts LM Studio download page');

console.log('smoke_worker_suspension_ui: PASS');
