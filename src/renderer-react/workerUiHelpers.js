import {
  classifyWorkerApiError,
  parseWorkerStopReasonLine,
  classifyHubAccessFailureFromApi,
} from '../workerHubErrorTaxonomy.mjs';

export function isOpenAiCompatProvider(provider) {
  return String(provider || 'ollama').trim().toLowerCase() === 'openai_compat';
}

export function formatProviderLabel(provider) {
  return isOpenAiCompatProvider(provider) ? 'LM Studio' : 'Ollama';
}

/** TASK_BOUNTY_COMPOSER_TURN → Bounty Composer Turn */
export function formatTaskTypeLabel(raw) {
  const text = String(raw || '').trim();
  if (!text) return 'Task';
  const cleaned = text
    .replace(/^TASK[_-]+/i, '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (!cleaned) return 'Task';
  return cleaned
    .toLowerCase()
    .replace(/\b([a-z])/g, (ch) => ch.toUpperCase());
}

export function parseWorkerUsdTotal(value) {
  const n = Number(String(value ?? '').trim());
  return Number.isFinite(n) ? n : 0;
}

export function formatUsdRewardValue(value) {
  return `$${parseWorkerUsdTotal(value).toFixed(4)}`;
}

export function formatQvncSettlementAmount(value) {
  const n = Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n <= 0) return '0';
  return n.toFixed(8);
}

export function normalizeRewardAssetLabel(value, fallback = 'QVNC') {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed && trimmed !== '[object Object]') return trimmed;
  }
  if (value && typeof value === 'object' && typeof value.nativeSymbol === 'string') {
    return value.nativeSymbol.trim() || fallback;
  }
  return fallback;
}

export function isHubAccessBlocked(hubState) {
  const state = String(hubState || '');
  return state === 'terms_required'
    || state === 'token_invalid'
    || state.startsWith('hub_suspended');
}

/** Hub is healthy/idle — no setup banner, checklist row may stay informational. */
export function isHubNormalIdleState(hubState) {
  const state = String(hubState || '');
  return state === 'online'
    || state === 'waiting'
    || state === 'duplicate_blocked';
}

export function mapSuspensionCodeToHubState(code) {
  switch (String(code || '').trim()) {
    case 'runtime_policy_mismatch':
      return 'hub_suspended_runtime_policy';
    case 'duplicate_task_attempt':
      return 'hub_suspended_duplicate_task';
    case 'device_conflict':
      return 'hub_suspended_device_conflict';
    case 'control_quality':
      return 'hub_suspended_control_quality';
    case 'admin_suspended':
      return 'hub_suspended_admin';
    case 'token_revoked':
      return 'token_invalid';
    default:
      return 'hub_suspended';
  }
}

export function resolveSuspensionPresentation(suspension = null) {
  const code = String(suspension?.code || '').trim();
  const hubState = mapSuspensionCodeToHubState(code);
  const reason = String(suspension?.reason || '').trim();

  switch (hubState) {
    case 'hub_suspended_runtime_policy':
      return {
        hubState,
        title: 'Suspended: runtime policy mismatch',
        subtitle: reason || 'Local runtime does not match Hub-approved models. Update runtime settings, then open the Worker page for review.',
        actionLabel: 'Open Worker page',
        actionTarget: 'open-external',
        externalUrl: suspension?.action_url || null,
      };
    case 'hub_suspended_duplicate_task':
      return {
        hubState,
        title: 'Suspended: duplicate task attempt',
        subtitle: reason || 'This owner already completed the same logical task. Duplicate rewards are blocked.',
        actionLabel: 'Open Worker page',
        actionTarget: 'open-external',
        externalUrl: suspension?.action_url || null,
      };
    case 'hub_suspended_device_conflict':
      return {
        hubState,
        title: 'Suspended: device conflict',
        subtitle: reason || 'Device binding conflict detected. Reset device binding on the Worker page.',
        actionLabel: 'Open Worker page',
        actionTarget: 'open-external',
        externalUrl: suspension?.action_url || null,
      };
    case 'hub_suspended_control_quality':
      return {
        hubState,
        title: 'Suspended: control task failed',
        subtitle: reason || 'Hidden control-task quality checks failed repeatedly.',
        actionLabel: 'Open Worker page',
        actionTarget: 'open-external',
        externalUrl: suspension?.action_url || null,
      };
    case 'hub_suspended_admin':
      return {
        hubState,
        title: 'Suspended: admin review',
        subtitle: reason || 'An administrator suspended this worker node.',
        actionLabel: 'Open Admin review',
        actionTarget: 'open-external',
        externalUrl: suspension?.action_url || null,
      };
    default:
      return {
        hubState: 'hub_suspended',
        title: reason ? `Suspended: ${reason}` : 'Worker access suspended',
        subtitle: reason || 'Hub policy suspended this worker node.',
        actionLabel: 'Open Worker page',
        actionTarget: 'open-external',
        externalUrl: suspension?.action_url || null,
      };
  }
}

export function hubStateLabel(hubState, suspension = null) {
  if (suspension?.reason && isHubAccessBlocked(hubState)) {
    if (hubState.startsWith('hub_suspended_')) {
      return resolveSuspensionPresentation(suspension).title.replace(/^Suspended:\s*/i, 'Suspended · ');
    }
  }

  switch (hubState) {
    case 'online':
      return 'Hub connected';
    case 'retrying':
      return 'Hub retrying';
    case 'hub_suspended_runtime_policy':
      return 'Suspended · runtime policy';
    case 'hub_suspended_duplicate_task':
      return 'Suspended · duplicate task';
    case 'hub_suspended_device_conflict':
      return 'Suspended · device conflict';
    case 'hub_suspended_control_quality':
      return 'Suspended · control quality';
    case 'hub_suspended_admin':
      return 'Suspended · admin review';
    case 'hub_suspended':
      return suspension?.reason ? `Suspended · ${suspension.reason}` : 'Worker access suspended';
    case 'terms_required':
      return 'Terms required';
    case 'token_invalid':
      return 'Token invalid';
    case 'duplicate_blocked':
      return 'Task already completed';
    case 'runtime_blocked':
      return 'Runtime blocked by Hub';
    case 'throttled':
      return 'Hub throttled';
    case 'waiting':
      return 'Waiting for tasks';
    case 'offline':
      return 'Hub offline';
    default:
      return 'Hub not checked yet';
  }
}

export function classifyHubAccessFailure({ status, error, reason, code, message } = {}) {
  return classifyHubAccessFailureFromApi({ status, error, reason, code, message });
}

export function resolveOverviewHubState(result, failureStreak = 0) {
  if (result?.ok) {
    const terms = result?.data?.terms;
    if (terms?.required && !terms?.accepted) {
      return { hubState: 'terms_required', failureStreak: 0, suspension: null };
    }

    const suspension = result?.data?.suspension || null;
    if (suspension?.code) {
      return {
        hubState: mapSuspensionCodeToHubState(suspension.code),
        failureStreak: 0,
        suspension,
      };
    }

    const nodeStatus = String(result?.data?.node?.status || '').toLowerCase();
    if (nodeStatus === 'revoked') {
      return {
        hubState: 'token_invalid',
        failureStreak: 0,
        suspension: suspension || { code: 'token_revoked', reason: 'Worker token revoked' },
      };
    }
    if (nodeStatus === 'suspended') {
      return {
        hubState: 'hub_suspended',
        failureStreak: 0,
        suspension: suspension || { code: 'hub_suspended', reason: 'Worker access suspended' },
      };
    }
    return { hubState: 'online', failureStreak: 0, suspension: null };
  }

  const err = String(result?.error || '').toLowerCase();
  const status = Number(result?.status);
  const accessFailure = classifyHubAccessFailure({
    status,
    error: result?.error,
    reason: result?.reason,
    code: result?.code,
    message: result?.message,
  });
  if (accessFailure === 'terms_required') {
    return { hubState: 'terms_required', failureStreak: 0, suspension: null };
  }
  if (accessFailure && isHubAccessBlocked(accessFailure)) {
    return {
      hubState: accessFailure,
      failureStreak: 0,
      suspension: result?.suspension || {
        code: accessFailure.replace(/^hub_suspended_/, '').replace(/_/g, '_'),
        reason: result?.reason || result?.error || null,
      },
    };
  }

  if (
    /network|timeout|timed out|econnrefused|enotfound|fetch failed|socket hang up/.test(err)
  ) {
    const nextStreak = failureStreak + 1;
    return {
      hubState: nextStreak >= 3 ? 'offline' : 'retrying',
      failureStreak: nextStreak,
      suspension: null,
    };
  }

  const nextStreak = failureStreak + 1;
  return {
    hubState: nextStreak >= 3 ? 'offline' : 'retrying',
    failureStreak: nextStreak,
    suspension: null,
  };
}

export function inferHubStateFromLogLine(line) {
  const raw = String(line || '');
  const text = raw.toLowerCase();

  const parsedStop = parseWorkerStopReasonLine(raw);
  if (parsedStop?.code) {
    if (parsedStop.code === 'runtime_blocked') return 'hub_suspended_runtime_policy';
    return parsedStop.code;
  }

  if (/worker access suspended|hub policy suspended|not active|auto_suspend/.test(text)) {
    return 'hub_suspended';
  }

  if (/task already completed|duplicate_task_attempt|duplicate blocked/.test(text)) {
    return 'duplicate_blocked';
  }

  if (/waiting for tasks|waiting for available task slot|rate\/parallel limit reached|no available task/.test(text)) {
    return 'waiting';
  }

  if (/rate-limited|rate limit|429/.test(text)) {
    return 'throttled';
  }

  const classified = classifyWorkerApiError({ error: raw, message: raw });
  if (classified === 'token_invalid') return 'token_invalid';
  if (classified === 'hub_suspended') return 'hub_suspended';
  if (classified === 'runtime_blocked') return 'hub_suspended_runtime_policy';
  if (classified === 'duplicate_blocked') return 'duplicate_blocked';
  if (classified === 'terms_required') return 'terms_required';
  if (classified === 'throttled') return 'throttled';
  if (classified === 'waiting') return 'waiting';
  if (classified === 'retrying') return 'retrying';

  if (/overview failed|heartbeat network|heartbeat error|network error|timeout|fetch failed/.test(text)) {
    return 'retrying';
  }
  if (/worker started|task claimed|task completed|hub connected/.test(text)) {
    return 'online';
  }
  return null;
}

export function deriveWorkerUiState({
  hasUsableToken,
  hasUsableAddress = false,
  runtimeCheck,
  llmProvider,
  status,
  currentTask,
  logs,
  hubState,
  suspension = null,
  workerPageUrl = null,
  startPending = false,
  startPhase = null,
  bootstrapping = false,
}) {
  const openAi = isOpenAiCompatProvider(llmProvider);
  const runtimeReachable = openAi
    ? Boolean(runtimeCheck?.openaiCompatReachable)
    : Boolean(runtimeCheck?.ollamaReachable);
  const modelReady = Boolean(runtimeCheck?.generationModelAvailable)
    && Boolean(runtimeCheck?.embeddingModelAvailable ?? runtimeCheck?.generationModelAvailable);
  const throttled = (logs || []).some((line) =>
    /throttle|rate\/parallel limit/i.test(String(line || ''))
  );

  if (hubState === 'terms_required') {
    return {
      phase: 'terms_required',
      title: 'Terms required',
      subtitle: 'Accept updated worker terms in the web app.',
      actionLabel: 'Accept terms',
      actionTarget: 'open-external',
      externalUrl: workerPageUrl,
      powerMode: 'blocked',
    };
  }

  if (isHubAccessBlocked(hubState) && hubState.startsWith('hub_suspended')) {
    const presentation = resolveSuspensionPresentation(suspension);
    return {
      phase: presentation.hubState,
      title: presentation.title,
      subtitle: presentation.subtitle,
      actionLabel: presentation.actionLabel,
      actionTarget: presentation.actionTarget,
      externalUrl: presentation.externalUrl || workerPageUrl,
      powerMode: 'blocked',
    };
  }

  if (hubState === 'token_invalid') {
    return {
      phase: 'token_invalid',
      title: suspension?.code === 'token_revoked' ? 'Token revoked' : 'Token invalid',
      subtitle: suspension?.reason || 'Replace your worker token to reconnect',
      actionLabel: 'Replace token',
      actionTarget: 'app-token',
      powerMode: 'blocked',
    };
  }

  if (status?.running && hubState === 'duplicate_blocked') {
    return {
      phase: 'duplicate_blocked',
      title: 'Task already completed',
      subtitle: 'Waiting for new tasks',
      actionLabel: 'View activity',
      actionTarget: 'activity',
      powerMode: 'warning',
    };
  }

  if (status?.running && hubState === 'waiting') {
    return {
      phase: 'waiting',
      title: 'Waiting for tasks',
      subtitle: 'Hub has no available tasks right now',
      actionLabel: 'View activity',
      actionTarget: 'activity',
      powerMode: 'running',
    };
  }

  if (startPending) {
    return {
      phase: 'starting',
      title: startPhase === 'starting_worker' ? 'Starting worker...' : 'Checking runtime...',
      subtitle: startPhase === 'starting_worker' ? 'Starting worker...' : 'Checking runtime...',
      actionLabel: 'Starting…',
      actionTarget: 'start',
      powerMode: 'starting',
    };
  }

  if (bootstrapping && (!hasUsableToken || !runtimeCheck)) {
    return {
      phase: 'initializing',
      title: 'Checking setup…',
      subtitle: 'Reading saved token and runtime state',
      actionLabel: 'Checking setup',
      actionTarget: null,
      powerMode: 'blocked',
    };
  }

  if (!hasUsableToken) {
    return {
      phase: 'no_token',
      title: 'Setup required',
      subtitle: 'Paste your worker token to connect to Quavence Hub',
      actionLabel: 'Paste worker token',
      actionTarget: 'app-token',
      powerMode: 'blocked',
    };
  }

  if (!hasUsableAddress) {
    return {
      phase: 'no_address',
      title: 'Payout address required',
      subtitle: 'Enter your native Quavence staking address (S...) on the App tab',
      actionLabel: 'Set payout address',
      actionTarget: 'app-address',
      powerMode: 'blocked',
    };
  }

  if (!runtimeCheck) {
    return {
      phase: 'setup_required',
      title: 'Setup required',
      subtitle: 'Check runtime to verify local AI is ready',
      actionLabel: 'Open Runtime',
      actionTarget: 'runtime',
      powerMode: 'blocked',
    };
  }

  if (!runtimeReachable) {
    return {
      phase: 'runtime_offline',
      title: `${formatProviderLabel(llmProvider)} offline`,
      subtitle: openAi ? 'Start LM Studio local server' : 'Start Ollama',
      actionLabel: 'Open Runtime',
      actionTarget: 'runtime',
      powerMode: 'blocked',
    };
  }

  if (runtimeCheck?.runtimePolicyBlocked) {
    const onlyNotLoaded = Boolean(
      runtimeCheck?.generationModelDownloadedNotLoaded || runtimeCheck?.embeddingModelDownloadedNotLoaded
    );
    return {
      phase: onlyNotLoaded ? 'model_missing' : 'runtime_blocked',
      title: onlyNotLoaded ? 'Model not loaded' : 'Runtime blocked',
      subtitle: openAi ? 'Load required models in LM Studio' : 'Load required models in Ollama',
      actionLabel: 'Open Runtime',
      actionTarget: 'runtime',
      powerMode: 'blocked',
    };
  }

  if (!modelReady) {
    return {
      phase: 'model_missing',
      title: 'Model not loaded',
      subtitle: openAi ? 'Load the model in LM Studio' : 'Load the model in Ollama',
      actionLabel: 'Open Runtime',
      actionTarget: 'runtime',
      powerMode: 'blocked',
    };
  }

  if (status?.running && throttled) {
    return {
      phase: 'throttled',
      title: 'Worker throttled',
      subtitle: 'Waiting after failures or rate limits',
      actionLabel: 'View activity',
      actionTarget: 'activity',
      powerMode: 'warning',
    };
  }

  if (status?.running && currentTask) {
    return {
      phase: 'running_active',
      title: 'Worker is running',
      subtitle: 'Processing task pipeline',
      actionLabel: 'Stop Worker',
      actionTarget: 'stop',
      powerMode: 'running',
    };
  }

  if (status?.running) {
    return {
      phase: 'running_idle',
      title: 'Worker is running',
      subtitle: 'Waiting for tasks',
      actionLabel: 'Stop Worker',
      actionTarget: 'stop',
      powerMode: 'running',
    };
  }

  return {
    phase: 'ready',
    title: 'Ready to work',
    subtitle: 'Start the worker to claim and complete tasks',
    actionLabel: 'Start Worker',
    actionTarget: 'start',
    powerMode: 'ready',
  };
}

export function buildSetupChecklist({
  hasUsableToken,
  hasStoredToken,
  runtimeCheck,
  llmProvider,
  hubState,
  suspension = null,
}) {
  const openAi = isOpenAiCompatProvider(llmProvider);
  const runtimeReachable = openAi
    ? Boolean(runtimeCheck?.openaiCompatReachable)
    : Boolean(runtimeCheck?.ollamaReachable);
  const modelReady = Boolean(runtimeCheck?.generationModelAvailable);
  const embedReady = Boolean(runtimeCheck?.embeddingModelAvailable ?? runtimeCheck?.generationModelAvailable);
  const hubOk = hubState === 'online';

  return [
    {
      id: 'token',
      label: hasStoredToken ? 'Token saved' : hasUsableToken ? 'Token ready' : 'No token',
      ok: hasUsableToken && hubState !== 'token_invalid',
      action: hasUsableToken ? null : 'Paste worker token',
      target: 'app-token',
    },
    {
      id: 'hub',
      label: hubStateLabel(hubState, suspension),
      ok: isHubNormalIdleState(hubState),
      action: hubState === 'token_invalid'
        ? 'Replace token'
        : hubState === 'terms_required'
          ? 'Accept terms'
          : (isHubAccessBlocked(hubState) && hubState.startsWith('hub_suspended')
            ? resolveSuspensionPresentation(suspension).actionLabel
            : null),
      target: hubState === 'token_invalid'
        ? 'app-token'
        : (hubState === 'terms_required' || (isHubAccessBlocked(hubState) && hubState.startsWith('hub_suspended'))
          ? 'open-external'
          : null),
    },
    {
      id: 'runtime',
      label: runtimeReachable
        ? `${formatProviderLabel(llmProvider)} reachable`
        : `${formatProviderLabel(llmProvider)} offline`,
      ok: runtimeReachable,
      action: runtimeReachable ? null : 'Check runtime',
      target: 'runtime',
    },
    {
      id: 'model',
      label: runtimeCheck?.runtimePolicyBlocked
        ? 'Runtime blocked by hub policy'
        : modelReady
          ? (runtimeCheck?.policyEnforced && !embedReady ? 'Embedding model not loaded' : 'Model loaded')
          : 'Model not loaded',
      ok: modelReady && !runtimeCheck?.runtimePolicyBlocked && embedReady,
      action: modelReady && embedReady && !runtimeCheck?.runtimePolicyBlocked ? null : 'Refresh',
      target: 'runtime',
    },
  ];
}

export function truncateModelName(name, maxLen = 28) {
  const value = String(name || '').trim();
  if (value.length <= maxLen) return value;
  return `${value.slice(0, Math.max(1, maxLen - 1))}…`;
}

export function formatWorkerReputationScore(node) {
  const display = node?.reputation_display;
  if (display?.tier === 'under_review') {
    return {
      text: 'Under review',
      title: display.caption || 'Worker quality or policy review is active.',
      tone: 'warn',
    };
  }
  if (display) {
    const samples = Number(display.samples || 0);
    const text = samples > 0
      ? `${display.score_label} · ${display.label} · ${samples} samples`
      : `${display.score_label} · ${display.label}`;
    return {
      text,
      title: display.caption || null,
      tone: reputationTierTone(display.tier),
    };
  }

  const raw = node?.reputation_score;
  if (raw == null || raw === '') return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  const samples = Number(node?.reputation_sample_count || 0);
  const text = samples > 0
    ? `${value.toFixed(2)} · Baseline · ${samples} samples`
    : `${value.toFixed(2)} · Baseline`;
  return {
    text,
    title: samples > 0 ? 'Quality profile' : 'New worker baseline. Quality score updates after scored tasks.',
    tone: 'neutral',
  };
}

function reputationTierTone(tier) {
  switch (String(tier || '').toLowerCase()) {
    case 'strong':
    case 'good':
      return 'good';
    case 'watch':
      return 'warn';
    case 'at_risk':
    case 'under_review':
      return 'bad';
    case 'baseline':
    default:
      return 'neutral';
  }
}

export function formatWorkerReputationLine(node) {
  const formatted = formatWorkerReputationScore(node);
  return formatted?.text || null;
}

function resolveDeviceBindingLabel(binding, localDeviceId) {
  if (binding?.is_locked) {
    return { text: 'Locked', tone: 'bad' };
  }
  if (binding?.has_conflict) {
    return { text: 'Conflict', tone: 'warn' };
  }
  if (binding?.device_id_short || binding?.first_seen_at) {
    return { text: 'Active', tone: 'good' };
  }
  if (localDeviceId) {
    return { text: 'Pending', tone: 'neutral' };
  }
  return { text: 'Not bound', tone: 'muted' };
}

function platformProtectionLabel(hasNode) {
  if (hasNode) {
    return { text: 'Active', tone: 'good' };
  }
  return { text: 'Managed by Hub', tone: 'neutral' };
}

export function buildWorkerProtectionRows({
  overview,
  hasStoredToken,
  hasUsableToken,
  localDeviceId,
}) {
  const binding = overview?.device_binding;
  const hasNode = Boolean(overview?.has_node);
  const deviceBinding = resolveDeviceBindingLabel(binding, localDeviceId);
  const tokenStorage = hasStoredToken
    ? { text: 'Local', tone: 'good' }
    : hasUsableToken
      ? { text: 'Session only', tone: 'neutral' }
      : { text: 'Not saved', tone: 'muted' };
  const platform = platformProtectionLabel(hasNode);

  const rows = [
    { id: 'device-binding', label: 'Device binding', text: deviceBinding.text, tone: deviceBinding.tone },
    { id: 'token-storage', label: 'Token storage', text: tokenStorage.text, tone: tokenStorage.tone },
    { id: 'quality-checks', label: 'Quality checks', text: platform.text, tone: platform.tone },
    { id: 'duplicate-checks', label: 'Duplicate checks', text: platform.text, tone: platform.tone },
    { id: 'payout-review', label: 'Payout review', text: platform.text, tone: platform.tone },
  ];

  const reputation = formatWorkerReputationScore(overview?.node);
  if (reputation != null) {
    rows.push({
      id: 'reputation',
      label: 'Reputation',
      text: reputation.text,
      title: reputation.title || undefined,
      tone: reputation.tone,
    });
  }

  return rows;
}

export function resolveWorkerProtectionBadge(overview, protectionRows) {
  const binding = overview?.device_binding;
  if (binding?.is_locked || binding?.has_conflict) {
    return { label: 'Review needed', className: 'is-pending' };
  }
  if (!overview?.has_node) {
    return { label: 'Hub managed', className: 'is-neutral' };
  }
  const deviceRow = protectionRows.find((row) => row.id === 'device-binding');
  if (deviceRow?.text !== 'Active') {
    return { label: 'Partially protected', className: 'is-neutral' };
  }
  return { label: 'Protected', className: 'is-ok' };
}

/** Merge identical Hub policy rows for dashboard refresh expand. Full rows stay for default UI. */
export function compactProtectionRows(rows) {
  const list = Array.isArray(rows) ? rows : [];
  const hubIds = new Set(['quality-checks', 'duplicate-checks', 'payout-review']);
  const result = [];
  let hubMerged = false;
  for (const row of list) {
    if (hubIds.has(row.id)) {
      if (!hubMerged) {
        result.push({
          id: 'hub-managed-checks',
          label: 'Hub-managed checks',
          text: row.text,
          tone: row.tone,
          title: row.title,
        });
        hubMerged = true;
      }
      continue;
    }
    result.push(row);
  }
  return result;
}

function parseActivityEventTimeMs(timeLabel) {
  const match = String(timeLabel || '').match(/(\d{1,2}):(\d{2})(?::(\d{2}))?/);
  if (!match) return null;
  const date = new Date();
  date.setHours(Number(match[1]), Number(match[2]), Number(match[3] || 0), 0);
  return date.getTime();
}

function formatDedupedActivityText(text, count, { forDebug = false } = {}) {
  if (count <= 1) return text;
  const waitingBase = String(text || '').replace(/\s·\s*last heartbeat.*$/i, '').trim();
  if (!forDebug && waitingBase === 'Waiting for tasks') {
    return text.includes('last heartbeat') ? text : 'Waiting for tasks';
  }
  if (!forDebug && text === 'Worker started' && count > 3) {
    return 'Worker restarted several times';
  }
  return `${text} ×${count}`;
}

function activityDedupeBaseText(text) {
  return String(text || '').replace(/\s·\s*last heartbeat.*$/i, '').trim();
}

function activityTaskDedupeKey(event) {
  if (event?.kind === 'waiting_idle') return 'waiting_idle';
  if (event?.kind && event?.taskId) {
    return `${event.kind}|${event.taskId}`;
  }
  return null;
}

function shouldMergeActivityByText(last, event, windowMs) {
  const lastBase = activityDedupeBaseText(last.text);
  const eventBase = activityDedupeBaseText(event.text);
  if (lastBase === 'Waiting for tasks' && eventBase === 'Waiting for tasks') {
    return true;
  }
  if (!last || last.text !== event.text) return false;
  if (activityTaskDedupeKey(last)) return false;
  const firstMs = parseActivityEventTimeMs(last.time);
  const nextMs = parseActivityEventTimeMs(event.time);
  return firstMs == null || nextMs == null || Math.abs(nextMs - firstMs) <= windowMs;
}

export function dedupeActivityEvents(events, windowMs = 60000, { forDebug = false } = {}) {
  if (!Array.isArray(events) || events.length === 0) return [];

  // Oldest → newest so merged groups keep the latest timestamp.
  const chronological = [...events];
  const grouped = [];
  const taskKeyIndex = new Map();

  for (const event of chronological) {
    const taskKey = activityTaskDedupeKey(event);
    if (taskKey) {
      if (taskKeyIndex.has(taskKey)) {
        const idx = taskKeyIndex.get(taskKey);
        grouped[idx].count += 1;
        grouped[idx].time = event.time;
        continue;
      }
      const entry = {
        text: event.text,
        tone: event.tone,
        time: event.time,
        kind: event.kind,
        taskId: event.taskId,
        count: 1,
      };
      taskKeyIndex.set(taskKey, grouped.length);
      grouped.push(entry);
      continue;
    }

    const lastGroup = grouped[grouped.length - 1];
    if (lastGroup && shouldMergeActivityByText(lastGroup, event, windowMs)) {
      lastGroup.count += 1;
      lastGroup.time = event.time;
      continue;
    }

    grouped.push({
      text: event.text,
      tone: event.tone,
      time: event.time,
      kind: event.kind,
      taskId: event.taskId,
      count: 1,
    });
  }

  // Newest first for activity feed.
  return grouped
    .reverse()
    .map((group, index) => {
      const silentTaskMerge = Boolean(group.kind && group.taskId);
      return {
        id: `dedupe-${index}-${group.kind || 'evt'}-${group.taskId || group.text}`,
        time: group.time,
        text: formatDedupedActivityText(
          group.text,
          silentTaskMerge ? 1 : group.count,
          { forDebug },
        ),
        tone: group.tone || 'neutral',
      };
    });
}

function prependSyntheticActivityEvents(events, context = {}) {
  const next = [...events];
  const hasLabel = (pattern) => next.some((item) => pattern.test(String(item.text || '')));

  if (context.hubState === 'online' && !hasLabel(/hub connected/i)) {
    const heartbeat = context.lastHubContactLabel && context.lastHubContactLabel !== '—'
      ? ` · last heartbeat ${context.lastHubContactLabel}`
      : '';
    next.unshift({
      id: 'synthetic-hub-connected',
      time: context.lastHubContactLabel && context.lastHubContactLabel !== '—' ? context.lastHubContactLabel : '--:--',
      text: `Hub connected${heartbeat}`,
      tone: 'good',
    });
  }

  if (
    context.statusRunning
    && !context.currentTask
    && (context.hubState === 'online' || context.hubState === 'waiting')
    && !hasLabel(/waiting for tasks/i)
  ) {
    const heartbeat = context.lastHubContactLabel && context.lastHubContactLabel !== '—'
      ? ` · last heartbeat ${context.lastHubContactLabel}`
      : '';
    next.unshift({
      id: 'synthetic-waiting',
      time: context.lastHubContactLabel && context.lastHubContactLabel !== '—' ? context.lastHubContactLabel : '--:--',
      text: `Waiting for tasks${heartbeat}`,
      tone: 'neutral',
    });
  }

  return next;
}

export function shouldRefreshOverviewOnLogLine(line, lastRefreshedTaskId = null) {
  const parsed = parseProgressEvent(line);
  if (parsed?.kind !== 'task_completed' || !parsed.taskId) {
    return { refresh: false, taskId: null };
  }
  if (parsed.taskId === lastRefreshedTaskId) {
    return { refresh: false, taskId: parsed.taskId };
  }
  return { refresh: true, taskId: parsed.taskId };
}

export function parseProgressEvent(line) {
  const tsMatch = String(line || '').match(/^\[([^\]]+)\]/);
  const tsRaw = tsMatch ? tsMatch[1] : '--:--:--';
  const tsParts = tsRaw.match(/(\d{1,2}:\d{2}(?::\d{2})?)/);
  const ts = tsParts ? tsParts[1] : tsRaw;
  const raw = String(line || '');

  if (/runtime check passed/i.test(raw)) {
    return { ts, label: 'Runtime check passed', tone: 'good', kind: 'worker' };
  }
  if (/\bstarting worker\b/i.test(raw) && !/already/i.test(raw)) {
    return { ts, label: 'Starting worker', tone: 'neutral', kind: 'worker' };
  }
  if (/worker started|starting worker agent/i.test(raw)) {
    return { ts, label: 'Worker started', tone: 'neutral', kind: 'worker' };
  }
  if (/hub connected|overview refreshed/i.test(raw)) {
    return { ts, label: 'Hub connected', tone: 'good', kind: 'hub' };
  }
  if (/overview failed|heartbeat network|heartbeat error|network error/i.test(raw)) {
    return { ts, label: 'Hub retrying', tone: 'warn', kind: 'hub' };
  }
  if (/worker access suspended|hub policy suspended|not active|auto_suspend/i.test(raw)) {
    const suspendedLabel = /runtime policy|runtime_policy/i.test(raw)
      ? 'Suspended · runtime policy mismatch'
      : /duplicate/i.test(raw)
        ? 'Suspended · duplicate task attempt'
        : /device conflict|worker_device/i.test(raw)
          ? 'Suspended · device conflict'
          : 'Worker access suspended by Hub policy';
    return { ts, label: suspendedLabel, tone: 'bad', kind: 'hub' };
  }
  if (/invalid node token|node token expired|401 unauthorized/i.test(raw) && !/not active|auto_suspend|403/.test(raw)) {
    return { ts, label: 'Token invalid', tone: 'bad', kind: 'hub' };
  }
  if (/task already completed|duplicate_task_attempt/i.test(raw)) {
    return { ts, label: 'Task already completed', tone: 'warn', kind: 'hub' };
  }
  if (/waiting for tasks|waiting for available task slot|rate\/parallel limit reached/i.test(raw)) {
    return { ts, label: 'Waiting for tasks', tone: 'neutral', kind: 'waiting_idle' };
  }

  const claimed = raw.match(/task claimed:\s*([a-f0-9-]+)\s*\(([^)]+)\)/i);
  if (claimed) {
    return {
      ts,
      label: `Task claimed (${claimed[2]})`,
      tone: 'neutral',
      kind: 'task_claimed',
      taskId: claimed[1],
      taskType: claimed[2],
    };
  }

  const completed = raw.match(/task completed:\s*([a-f0-9-]+)(.*)$/i);
  if (completed) {
    const suffix = String(completed[2] || '').trim();
    const rewardMatch = suffix.match(/~\$([0-9.]+)\s*USD\s*→\s*([0-9.]+)\s*(\w+)/i);
    if (rewardMatch) {
      return {
        ts,
        label: `Task completed · + $${rewardMatch[1]} / ≈ ${rewardMatch[2]} ${rewardMatch[3]}`,
        tone: 'good',
        kind: 'task_completed',
        taskId: completed[1],
      };
    }
    return {
      ts,
      label: suffix ? `Task completed ${suffix}` : 'Task completed',
      tone: 'good',
      kind: 'task_completed',
      taskId: completed[1],
    };
  }

  const failed = raw.match(/task failed:\s*([a-f0-9-]+)/i);
  if (failed) {
    return {
      ts,
      label: 'Task failed',
      tone: 'bad',
      kind: 'task_failed',
      taskId: failed[1],
    };
  }

  if (/payout|paid batch/i.test(raw)) {
    return { ts, label: 'Payout update', tone: 'neutral', kind: 'payout' };
  }

  if (/Runtime blocked|runtime policy/i.test(raw)) {
    return { ts, label: 'Runtime blocked', tone: 'bad', kind: 'runtime' };
  }

  if (/Runtime check:|Runtime preparation|Ollama is already running/i.test(raw)) {
    return { ts, label: 'Runtime check', tone: 'muted', kind: 'runtime' };
  }

  if (/rate\/parallel limit reached/i.test(raw)) {
    return { ts, label: 'Waiting for tasks', tone: 'neutral', kind: 'waiting_idle' };
  }

  return null;
}

function mapParsedEventToActivityItem(event, index) {
  return {
    id: `l-${event.ts}-${index}-${event.kind || 'evt'}`,
    time: event.ts,
    text: event.label,
    tone: event.tone || 'neutral',
    kind: event.kind,
    taskId: event.taskId,
  };
}

export function buildActivityFeed(logs, { includeRuntime = false, limit = 6, context = {}, forDebug = false } = {}) {
  const items = (logs || [])
    .map((line) => parseProgressEvent(line))
    .filter(Boolean)
    .filter((event) => includeRuntime || event.kind !== 'runtime')
    .filter((event) => !/current task/i.test(String(event.label || '')))
    .slice(-20)
    .map((event, index) => mapParsedEventToActivityItem(event, index));

  const deduped = dedupeActivityEvents(items, 60000, { forDebug });
  const withSynthetic = prependSyntheticActivityEvents(deduped, context);
  return withSynthetic.slice(0, limit);
}

const COMPLETED_TASKS_TODAY_KEY = 'worker.ui.completedTasksToday';

function localDayKey(date = new Date()) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function extractCompletedTaskId(line) {
  const match = String(line || '').match(/task completed:\s*([a-f0-9-]+)/i);
  return match ? match[1] : null;
}

function readCompletedTasksTodayState(storage) {
  if (!storage) return { date: localDayKey(), taskIds: [] };
  try {
    const raw = storage.getItem(COMPLETED_TASKS_TODAY_KEY);
    if (!raw) return { date: localDayKey(), taskIds: [] };
    const parsed = JSON.parse(raw);
    const date = String(parsed?.date || '');
    const taskIds = Array.isArray(parsed?.taskIds)
      ? parsed.taskIds.map((id) => String(id)).filter(Boolean)
      : [];
    if (date !== localDayKey()) return { date: localDayKey(), taskIds: [] };
    return { date, taskIds };
  } catch {
    return { date: localDayKey(), taskIds: [] };
  }
}

function writeCompletedTasksTodayState(state, storage) {
  if (!storage) return;
  try {
    storage.setItem(
      COMPLETED_TASKS_TODAY_KEY,
      JSON.stringify({
        date: state.date || localDayKey(),
        taskIds: [...new Set(state.taskIds || [])],
      }),
    );
  } catch {
    /* ignore quota / private mode */
  }
}

/** Session/log fallback only — logs have time-of-day, not calendar date. */
export function countTodayCompletedTasks(logs, storage = typeof localStorage !== 'undefined' ? localStorage : null) {
  const state = readCompletedTasksTodayState(storage);
  const ids = new Set(state.taskIds);
  for (const line of logs || []) {
    const taskId = extractCompletedTaskId(line);
    if (taskId) ids.add(taskId);
  }
  writeCompletedTasksTodayState({ date: localDayKey(), taskIds: [...ids] }, storage);
  return ids.size;
}

/** Prefer hub overview.tasks.done_today; fall back to persisted session completions. */
export function resolveTasksDoneToday(
  overview,
  logs,
  storage = typeof localStorage !== 'undefined' ? localStorage : null,
) {
  const hub = overview?.tasks?.done_today;
  if (hub != null && Number.isFinite(Number(hub))) {
    return Math.max(0, Math.floor(Number(hub)));
  }
  return countTodayCompletedTasks(logs, storage);
}

export function classifyLogFilter(line, filter) {
  const text = String(line || '');
  const lower = text.toLowerCase();

  if (filter === 'all') return true;
  if (filter === 'errors') return /\bERROR\b/.test(text);
  if (filter === 'warnings') return /\bWARN\b/.test(text);
  if (filter === 'debug') return /\bDEBUG\b/.test(text);
  if (filter === 'runtime') {
    return /runtime check:|runtime preparation|ollama|openai_compat|lm studio|embed|generation model/i.test(lower);
  }
  if (filter === 'hub') {
    return /overview|heartbeat|hub|task claimed|task completed|task failed|token|api error|network error/i.test(lower);
  }
  if (filter === 'xdao') {
    return /xdao|factory|governance target|proposal candidate|jetton/i.test(lower);
  }
  return true;
}

export const RUNTIME_CONFIG_KEYS = [
  'llmProvider',
  'llmBaseUrl',
  'llmApiKey',
  'openAiCompatRoleMode',
  'genModel',
  'embedModel',
  'model',
  'ollamaUrl',
];

export function pickRuntimeConfig(config) {
  const source = config || {};
  return Object.fromEntries(RUNTIME_CONFIG_KEYS.map((key) => [key, source[key]]));
}

export function isRuntimeConfigDirty(saved, current) {
  return JSON.stringify(pickRuntimeConfig(saved)) !== JSON.stringify(pickRuntimeConfig(current));
}

/**
 * Dashboard ambient background state for the top worker rail grid.
 * Active animation only when a real task is in progress.
 */
export function resolveDashboardAmbientState({
  uiState,
  startPending = false,
  currentTask = null,
  status = null,
} = {}) {
  if (startPending || uiState?.phase === 'starting') {
    return 'starting';
  }

  if (uiState?.phase === 'running_active' && currentTask) {
    return 'active';
  }

  if (
    status?.running
    && (
      uiState?.phase === 'running_idle'
      || uiState?.phase === 'throttled'
      || (uiState?.phase === 'running_active' && !currentTask)
    )
  ) {
    return 'idle';
  }

  return 'off';
}
