const TOKEN_INVALID_CODES = new Set([
  'invalid_node_token',
  'node_token_expired',
  'node_token_required',
  'token_revoked',
]);

const TOKEN_INVALID_MESSAGES = [
  'invalid node token',
  'node token expired',
  'node token is required',
  'node token required',
];

function normalizeCode(value) {
  return String(value || '').trim().toLowerCase();
}

function buildCombined({ status, error, reason, code, message } = {}) {
  return `${error || ''} ${reason || ''} ${code || ''} ${message || ''} ${status || ''}`.toLowerCase();
}

export function classifyWorkerApiError({ status, error, reason, code, message } = {}) {
  const http = Number(status) || 0;
  const codeText = normalizeCode(code || reason);
  const combined = buildCombined({ status, error, reason, code, message });

  if (http === 401 || TOKEN_INVALID_CODES.has(codeText)) {
    return 'token_invalid';
  }
  if (TOKEN_INVALID_MESSAGES.some((fragment) => combined.includes(fragment))) {
    return 'token_invalid';
  }

  if (
    http === 409
    && (
      codeText === 'ai_worker_terms_required'
      || combined.includes('ai_worker_terms_required')
      || combined.includes('terms_required')
    )
  ) {
    return 'terms_required';
  }

  if (
    http === 409
    && (
      codeText === 'ai_worker_runtime_policy_mismatch'
      || combined.includes('ai_worker_runtime_policy_mismatch')
      || combined.includes('runtime_policy_mismatch')
    )
  ) {
    return 'runtime_blocked';
  }

  if (
    http === 409
    && (
      codeText === 'ai_worker_duplicate_task_attempt'
      || combined.includes('ai_worker_duplicate_task_attempt')
      || combined.includes('duplicate_task_attempt')
    )
  ) {
    return 'duplicate_blocked';
  }

  if (
    http === 429
    || codeText === 'rate_limit'
    || codeText === 'max_parallel'
    || combined.includes('rate_limit')
    || combined.includes('max_parallel')
    || combined.includes('worker_temporarily_throttled')
  ) {
    return 'throttled';
  }

  if (
    http === 409
    && (
      codeText === 'worker_device_conflict'
      || codeText === 'worker_device_binding_active'
      || codeText === 'worker_device_id_required'
      || combined.includes('worker_device_conflict')
    )
  ) {
    return 'hub_suspended';
  }

  if (
    http === 403
    || codeText === 'node_not_active'
    || combined.includes('node is not active')
    || combined.includes('not active')
    || combined.includes('auto_suspend')
    || combined.includes('hub policy suspended')
    || combined.includes('worker access suspended')
  ) {
    return 'hub_suspended';
  }

  if (
    combined.includes('waiting for tasks')
    || combined.includes('waiting for available task slot')
    || combined.includes('rate/parallel limit reached')
    || combined.includes('no task slot')
    || combined.includes('no available task')
  ) {
    return 'waiting';
  }

  if (
    combined.includes('timeout')
    || combined.includes('timed out')
    || combined.includes('fetch failed')
    || combined.includes('econnrefused')
    || combined.includes('enotfound')
    || combined.includes('network error')
    || combined.includes('socket hang up')
    || combined.includes('overview failed')
    || combined.includes('heartbeat network')
    || combined.includes('heartbeat error')
  ) {
    return 'retrying';
  }

  return null;
}

export function formatWorkerStopReasonLine({ code, http = 0, message = '' } = {}) {
  const safeMessage = String(message || '').slice(0, 240);
  return `WORKER_STOP_REASON code=${code} http=${http} message=${JSON.stringify(safeMessage)}`;
}

export function parseWorkerStopReasonLine(line) {
  const raw = String(line || '').trim();
  if (!raw) return null;

  if (raw.startsWith('{') && raw.includes('worker_stop_reason')) {
    try {
      const payload = JSON.parse(raw);
      if (payload?.event === 'worker_stop_reason' && payload?.code) {
        return {
          code: String(payload.code),
          http: Number(payload.http || 0),
          message: String(payload.message || ''),
        };
      }
    } catch {
      // fall through
    }
  }

  const match = raw.match(/WORKER_STOP_REASON code=([a-z0-9_]+)(?: http=(\d+))?(?: message=(.+))?$/i);
  if (!match) return null;

  let parsedMessage = match[3] || '';
  if (parsedMessage.startsWith('"') && parsedMessage.endsWith('"')) {
    try {
      parsedMessage = JSON.parse(parsedMessage);
    } catch {
      parsedMessage = parsedMessage.slice(1, -1);
    }
  }

  return {
    code: match[1],
    http: Number(match[2] || 0),
    message: String(parsedMessage || ''),
  };
}

export function inferHubStateFromWorkerSignal(line) {
  const parsedStop = parseWorkerStopReasonLine(line);
  if (parsedStop?.code) {
    return parsedStop.code;
  }

  return classifyWorkerApiError({
    error: line,
    message: line,
  });
}

export function mapStopReasonToWorkerExitReason(code) {
  switch (String(code || '').trim()) {
    case 'token_invalid':
      return 'invalid_token';
    case 'hub_suspended':
      return 'hub_suspended';
    case 'runtime_blocked':
      return 'runtime';
    case 'terms_required':
      return 'terms_required';
    case 'throttled':
    case 'waiting':
    case 'retrying':
    case 'duplicate_blocked':
      return 'network';
    default:
      return null;
  }
}

export function shouldFatalStopWorker(code) {
  return code === 'token_invalid' || code === 'hub_suspended';
}

export function isTokenInvalidHubState(code) {
  return code === 'token_invalid';
}

export function hubStateBlocksToken(code) {
  return isTokenInvalidHubState(code);
}

export function classifyHubAccessFailureFromApi(input) {
  const mapped = classifyWorkerApiError(input);
  if (!mapped) return null;
  switch (mapped) {
    case 'runtime_blocked':
      return 'hub_suspended_runtime_policy';
    case 'duplicate_blocked':
    case 'throttled':
    case 'waiting':
    case 'retrying':
      return null;
    default:
      return mapped;
  }
}
