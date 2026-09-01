import process from 'process';
import crypto from 'crypto';
import http from 'node:http';
import https from 'node:https';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  buildRuntimeAttestation,
  fetchHubRuntimePolicy,
  fetchOpenAICompatModelIds,
  formatRuntimeMismatchLabels,
  resolveListedModelId,
  verifyLocalRuntimeAgainstPolicy,
} from './runtime_policy.mjs';
import {
  classifyWorkerApiError,
  formatWorkerStopReasonLine,
  shouldFatalStopWorker,
} from '../src/workerHubErrorTaxonomy.mjs';
import {
  HUB_REQUEST_TIMEOUT_MS,
  isHubTransientNetworkError,
  requestJsonWithRetry,
} from './hub_request.mjs';

const API_BASE_URL = String(process.env.AI_NODE_API_URL || 'https://quavence.com').replace(/\/+$/, '');
const RAW_NODE_TOKEN = String(process.env.AI_NODE_TOKEN || '').trim();
const NODE_TOKEN = RAW_NODE_TOKEN.replace(/^Bearer\s+/i, '').trim();
const OLLAMA_BASE_URL = String(process.env.OLLAMA_BASE_URL || 'http://localhost:11434').replace(/\/+$/, '');
const OLLAMA_MODEL = String(process.env.OLLAMA_MODEL || 'phi3:latest');
const LLM_PROVIDER = String(process.env.AI_WORKER_LLM_PROVIDER || 'ollama').trim().toLowerCase();
const OPENAI_COMPAT_BASE_URL = String(
  process.env.AI_WORKER_LLM_BASE_URL || process.env.LM_STUDIO_BASE_URL || 'http://localhost:1234/v1'
).trim();
const OPENAI_COMPAT_MODEL = String(
  process.env.AI_WORKER_LLM_MODEL || process.env.OLLAMA_MODEL || 'qwen/qwen3-vl-8b'
).trim();
const OPENAI_COMPAT_API_KEY = String(process.env.AI_WORKER_LLM_API_KEY || '').trim();
const OPENAI_COMPAT_MAX_TOKENS = Number(process.env.AI_WORKER_LLM_MAX_TOKENS || 2048);
const OPENAI_COMPAT_ROLE_MODE = normalizeOpenAICompatRoleMode(process.env.AI_WORKER_OPENAI_COMPAT_ROLE_MODE);
const OPENAI_COMPAT_JSON_SYSTEM_PROMPT =
  'Return only valid JSON. Do not include markdown fences, comments, or explanatory text.';
const WORKER_COUNTRY_CODE = String(process.env.AI_WORKER_COUNTRY_CODE || '').trim().toUpperCase();
const WORKER_COUNTRY_NAME = String(process.env.AI_WORKER_COUNTRY_NAME || '').trim();
const WORKER_REGION_NAME = String(process.env.AI_WORKER_REGION_NAME || '').trim();
const HEARTBEAT_INTERVAL_MS = Number(process.env.AI_WORKER_HEARTBEAT_INTERVAL_MS || 45000);
const POLL_INTERVAL_MS = Number(process.env.AI_WORKER_POLL_INTERVAL_MS || 6000);
const RUNTIME_POLICY_REFRESH_MS = Number(process.env.AI_WORKER_RUNTIME_POLICY_REFRESH_MS || 60000);
const OLLAMA_TIMEOUT_MS = Number(process.env.AI_WORKER_OLLAMA_TIMEOUT_MS || 120000);
const OLLAMA_MAX_RETRIES = Number(process.env.AI_WORKER_OLLAMA_MAX_RETRIES || 3);
const TASK_EXECUTION_MAX_RETRIES = Number(process.env.AI_WORKER_TASK_EXECUTION_MAX_RETRIES || 2);

const SUMMARY_PROMPT_KEY = 'TASK_SUMMARY';
const RISK_PROMPT_KEY = 'TASK_RISK_FLAGS';
const HISTORICAL_PROMPT_KEY = 'TASK_HISTORICAL_CONTEXT';
const OUTCOME_PROMPT_KEY = 'TASK_OUTCOME_RECAP';
const BOUNTY_SCREEN_PROMPT_KEY = 'TASK_BOUNTY_SUBMISSION_SCREEN';
const BOUNTY_CONSULTANT_PROMPT_KEY = 'TASK_BOUNTY_REVIEW_CONSULTANT_TURN';
const BOUNTY_COMPOSER_PROMPT_KEY = 'TASK_BOUNTY_COMPOSER_TURN';
const RAG_IDLE_PROMPT_KEY = 'TASK_RAG_IDLE_VERIFICATION';
const CONSULTANT_SEMANTIC_FLAGS = new Set([
  'off_topic',
  'wrong_deliverable',
  'weak_evidence',
  'incoherence',
  'suspicious_proof',
  'spam',
  'missing_proof',
]);

const FORCE_ALL_TASKS = String(process.env.DEPIN_AI_CONSENSUS_FORCE_ALL_TASKS || '')
  .trim()
  .toLowerCase() === 'true';
const WORKER_EXECUTABLE_TASK_TYPES = new Set([
  SUMMARY_PROMPT_KEY,
  RISK_PROMPT_KEY,
  BOUNTY_SCREEN_PROMPT_KEY,
  BOUNTY_CONSULTANT_PROMPT_KEY,
  BOUNTY_COMPOSER_PROMPT_KEY,
  RAG_IDLE_PROMPT_KEY,
  ...(FORCE_ALL_TASKS ? [HISTORICAL_PROMPT_KEY, OUTCOME_PROMPT_KEY] : []),
]);
const RISK_FLAG_CODES = new Set([
  'MISSING_BUDGET_BREAKDOWN',
  'UNCLEAR_DELIVERABLES',
  'UNCLEAR_TIMELINE',
  'NO_SUCCESS_METRICS',
  'MISSING_TEAM_INFO',
  'MISSING_PRIOR_WORK',
  'DEPENDENCY_RISK',
  'UNVERIFIED_ASSUMPTIONS',
  'OVERLAPPING_SCOPE',
  'INSUFFICIENT_RESOURCING',
  'VAGUE_MILESTONES',
  'MISSING_MAINTENANCE_PLAN',
  'MISSING_RISK_MITIGATION',
  'LARGE_UPFRONT_PAYMENT',
  'UNCLEAR_OWNERSHIP',
  'MISSING_EXTERNAL_QUOTES',
  'LEGAL_OR_COMPLIANCE_RISK',
  'SECURITY_RISK',
  'CONFLICT_OF_INTEREST_RISK',
  'NO_CONTINGENCY_PLAN',
  'UNCLEAR_EXECUTION_TARGET',
  'MISSING_EXECUTION_PROOF',
  'PARITY_OR_AMOUNT_VALIDATION_REQUIRED',
  'EXECUTION_UNCLEAR',
  'INSUFFICIENT_SPEC'
]);
const RISK_SEVERITIES = new Set(['low', 'medium', 'high', 'critical']);
const RISK_CATEGORIES = new Set(['observed_risk', 'missing_information', 'requires_manual_review']);

let heartbeatTimer = null;
let stopRequested = false;
let deviceBindingStop = false;
let networkErrorStreak = 0;
let heartbeatNetworkErrorStreak = 0;
let claimBackoffUntil = 0;
let failRateLimitUntil = 0;
let runtimePolicy = null;
let runtimePolicyFetchedAt = 0;
let runtimeAttestation = null;
let runtimePolicyBlocked = false;
let runtimePolicyBlockReason = '';
/**
 * Model id accepted by the local endpoint. LM Studio registers the same weights under
 * publisher/quant/format-specific ids, so requests must use its id, not the policy canonical.
 */
let activeGenerationModel = OPENAI_COMPAT_MODEL;
/** Hub rejected attestation on claim/complete — do not retry claim until policy/attestation changes. */
let hubRuntimeAttestationRejected = false;
let hubRuntimeAttestationRejectedVersion = '';

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function log(...args) {
  console.log('[ai-worker]', ...args);
}

function warn(...args) {
  console.warn('[ai-worker]', ...args);
}

function assertConfig() {
  if (!NODE_TOKEN) {
    throw new Error('AI_NODE_TOKEN is required');
  }
  if (!/^https?:\/\//i.test(API_BASE_URL)) {
    throw new Error(`Invalid AI_NODE_API_URL: ${API_BASE_URL}`);
  }
}

function getDeviceIdStorePath() {
  const configured = String(process.env.AI_WORKER_DEVICE_ID_FILE || '').trim();
  if (configured) return configured;
  const primary = path.join(os.homedir(), '.quavence-ai-worker-device-id');
  if (fs.existsSync(primary)) return primary;
  const legacy = path.join(os.homedir(), '.dimidao-ai-worker-device-id');
  if (fs.existsSync(legacy)) return legacy;
  return primary;
}

function collectHardwareFingerprint() {
  const parts = [];
  try {
    parts.push(`platform:${os.platform()}:${os.arch()}`);
    parts.push(`cpus:${os.cpus()?.[0]?.model || 'unknown'}:${os.cpus()?.length || 0}`);
    parts.push(`mem:${Math.round(os.totalmem() / (1024 * 1024 * 1024))}GB`);
    const nets = os.networkInterfaces();
    const macs = [];
    for (const name of Object.keys(nets || {})) {
      for (const net of nets[name] || []) {
        if (!net.internal && net.mac && net.mac !== '00:00:00:00:00:00') {
          macs.push(net.mac.toLowerCase());
        }
      }
    }
    if (macs.length) {
      parts.push(`macs:${[...new Set(macs)].sort().join(',')}`);
    }
  } catch {
    // fallback
  }
  return crypto.createHash('sha256').update(parts.join('|') || 'fallback_hw').digest('hex');
}

const WORKER_HARDWARE_FINGERPRINT = collectHardwareFingerprint();

function loadOrCreateDeviceId() {
  const fromEnv = String(process.env.AI_WORKER_DEVICE_ID || '').trim();
  if (fromEnv) return fromEnv;

  const storePath = getDeviceIdStorePath();
  try {
    const existing = String(fs.readFileSync(storePath, 'utf8') || '').trim();
    if (/^[0-9a-f-]{36}$/i.test(existing)) {
      return existing;
    }
  } catch {
    // generate below
  }

  const generated = crypto.randomUUID();
  try {
    fs.mkdirSync(path.dirname(storePath), { recursive: true });
    fs.writeFileSync(storePath, `${generated}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch {
    // still use generated id for this session
  }
  return generated;
}

function getKeypairStorePath() {
  const configured = String(process.env.AI_WORKER_KEYPAIR_FILE || '').trim();
  if (configured) return configured;
  return path.join(os.homedir(), '.quavence-worker-keypair.json');
}

function loadOrCreateWorkerKeypair() {
  const storePath = getKeypairStorePath();
  try {
    const raw = fs.readFileSync(storePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (parsed.privateKeyHex && parsed.publicKeyHex && parsed.qvncAddress) {
      return parsed;
    }
  } catch {
    // generate below
  }

  try {
    const ecdh = crypto.createECDH('secp256k1');
    ecdh.generateKeys();
    const privateKeyHex = ecdh.getPrivateKey('hex');
    const publicKeyHex = ecdh.getPublicKey('hex', 'compressed');

    const sha256 = crypto.createHash('sha256').update(Buffer.from(publicKeyHex, 'hex')).digest();
    const ripemd160 = crypto.createHash('ripemd160').update(sha256).digest();
    const withPrefix = Buffer.concat([Buffer.from([0x3f]), ripemd160]);
    const checksum = crypto.createHash('sha256').update(crypto.createHash('sha256').update(withPrefix).digest()).digest().subarray(0, 4);
    const bs58Chars = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

    let num = BigInt('0x' + Buffer.concat([withPrefix, checksum]).toString('hex'));
    let encoded = '';
    while (num > 0n) {
      const rem = Number(num % 58n);
      num = num / 58n;
      encoded = bs58Chars[rem] + encoded;
    }
    for (const byte of Buffer.concat([withPrefix, checksum])) {
      if (byte === 0) encoded = '1' + encoded;
      else break;
    }

    const keyData = { privateKeyHex, publicKeyHex, qvncAddress: encoded };
    try {
      fs.mkdirSync(path.dirname(storePath), { recursive: true });
      fs.writeFileSync(storePath, JSON.stringify(keyData, null, 2), { encoding: 'utf8', mode: 0o600 });
    } catch {}
    return keyData;
  } catch {
    return null;
  }
}

const WORKER_DEVICE_ID = loadOrCreateDeviceId();
const WORKER_KEYPAIR = loadOrCreateWorkerKeypair();
const WORKER_QVNC_ADDRESS = String(process.env.AI_WORKER_QVNC_ADDRESS || WORKER_KEYPAIR?.qvncAddress || '').trim();

function shortDeviceId(deviceId) {
  return String(deviceId || '').slice(0, 8);
}

function emitWorkerStopReason({ code, http = 0, message = '' } = {}) {
  console.error(formatWorkerStopReasonLine({ code, http, message }));
  console.error(JSON.stringify({
    event: 'worker_stop_reason',
    code,
    http,
    message: String(message || '').slice(0, 240),
  }));
}

function classifyResponseError(res) {
  return classifyWorkerApiError({
    status: res?.status,
    error: res?.data?.error,
    reason: res?.data?.reason,
    code: res?.data?.code,
    message: res?.data?.message,
  });
}

function buildHubError(action, res) {
  const error = new Error(apiErrorMessage(action, res));
  error.status = Number(res?.status || 0);
  error.code = res?.data?.code || null;
  error.hubCode = classifyResponseError(res);
  return error;
}

function resolveFatalStopCode(error, res = null) {
  if (error?.hubCode && shouldFatalStopWorker(error.hubCode)) {
    return error.hubCode;
  }
  const fromResponse = res ? classifyResponseError(res) : null;
  if (fromResponse && shouldFatalStopWorker(fromResponse)) {
    return fromResponse;
  }
  const inferred = classifyWorkerApiError({
    status: error?.status,
    error: error?.message,
    code: error?.code,
    message: error?.message,
  });
  return shouldFatalStopWorker(inferred) ? inferred : null;
}

function isFatalHubError(error, res = null) {
  return Boolean(resolveFatalStopCode(error, res));
}

function handleFatalHubError(error, res = null) {
  const code = resolveFatalStopCode(error, res);
  if (!code) return false;
  emitWorkerStopReason({
    code,
    http: Number(error?.status || res?.status || 0),
    message: error?.message || res?.data?.error || res?.data?.message || '',
  });
  return true;
}

let hubAccessSuspendedStop = false;

function isHubAccessSuspendedResponse(res) {
  const status = Number(res?.status);
  if (status !== 403) return false;
  const code = String(res?.data?.code || '').toLowerCase();
  const error = String(res?.data?.error || '').toLowerCase();
  const reason = String(res?.data?.reason || '').toLowerCase();
  return code === 'node_not_active'
    || error.includes('not active')
    || reason.includes('auto_suspend')
    || reason.includes('suspended');
}

function handleHubAccessSuspended(res, action) {
  hubAccessSuspendedStop = true;
  stopRequested = true;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  const reason = String(res?.data?.reason || res?.data?.error || 'Node is not active').trim();
  const message = 'Worker access suspended by Hub policy. Open Workers page or contact admin.';
  warn(`${action} blocked: ${message} (${reason})`);
  emitWorkerStopReason({
    code: 'hub_suspended',
    http: Number(res?.status || 403),
    message: reason || message,
  });
  const error = buildHubError(action, res);
  error.message = `${action} failed (${res.status}): ${message}`;
  error.hubCode = 'hub_suspended';
  throw error;
}

function isWorkerDeviceBindingError(res) {
  const code = String(res?.data?.code || res?.data?.reason || '').trim();
  return [
    'worker_device_id_required',
    'worker_device_conflict',
    'worker_device_binding_active',
    'worker_device_id_invalid',
  ].includes(code);
}

function isTaskLeaseExpiredError(res) {
  const code = String(res?.data?.code || res?.data?.reason || '').trim();
  return code === 'task_lease_expired';
}

function handleTaskLeaseExpired(action, taskId) {
  warn(`Task lease expired before result submission; task will be requeued by Hub. (${action} ${taskId})`);
  return { leaseExpired: true };
}

function handleWorkerDeviceBindingFailure(res, action) {
  const code = String(res?.data?.code || res?.data?.reason || 'worker_device_conflict');
  deviceBindingStop = true;
  stopRequested = true;
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  const message = 'Worker token is bound to another device. Reset binding on Workers page or rotate token.';
  warn(`${action} blocked (${code}): ${message}`);
  emitWorkerStopReason({
    code: 'hub_suspended',
    http: Number(res?.status || 409),
    message: `${code}: ${message}`,
  });
  const error = buildHubError(action, res);
  error.message = `${action} failed (${res.status}): ${message}`;
  error.hubCode = 'hub_suspended';
  throw error;
}

function apiErrorMessage(action, res) {
  const detail = String(res?.data?.error || '').trim();
  const reason = String(res?.data?.reason || '').trim();
  if (detail && reason) return `${action} failed (${res.status}): ${detail} (${reason})`;
  return detail ? `${action} failed (${res.status}): ${detail}` : `${action} failed (${res.status})`;
}

function networkErrorMessage(error) {
  const errorMessage = String(error?.message || 'fetch failed').trim();
  const causeMessage = String(error?.cause?.message || '').trim();
  return causeMessage && causeMessage !== errorMessage
    ? `${errorMessage} (${causeMessage})`
    : errorMessage;
}

function requestJson(method, urlString, headers = {}, body = null, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const url = new URL(urlString);
    const transport = url.protocol === 'https:' ? https : http;
    const payload = body ? JSON.stringify(body) : null;

    const req = transport.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || undefined,
        path: `${url.pathname}${url.search}`,
        method,
        family: 4,
        servername: url.hostname,
        headers: {
          ...headers,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {})
        }
      },
      (res) => {
        let raw = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => {
          raw += chunk;
        });
        res.on('end', () => {
          let data = null;
          try {
            data = raw ? JSON.parse(raw) : null;
          } catch {
            data = null;
          }
          const status = Number(res.statusCode || 0);
          resolve({
            status,
            ok: status >= 200 && status < 300,
            data
          });
        });
      }
    );

    req.setTimeout(timeoutMs, () => {
      req.destroy(new Error('Connect Timeout Error'));
    });
    req.on('error', (error) => reject(error));

    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

async function apiCall(method, pathName, body = null) {
  try {
    return await requestJsonWithRetry(
      requestJson,
      method,
      `${API_BASE_URL}${pathName}`,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${NODE_TOKEN}`,
        'X-AI-Worker-Device-ID': WORKER_DEVICE_ID,
      },
      body,
      { timeoutMs: HUB_REQUEST_TIMEOUT_MS },
    );
  } catch (error) {
    throw new Error(networkErrorMessage(error));
  }
}

function runtimePolicyEnforced(policy = runtimePolicy) {
  return Boolean(policy?.enabled && policy.mode !== 'off');
}

function hasRuntimeAttestation(attestation = runtimeAttestation) {
  const base = Boolean(
    attestation?.provider
    && attestation?.generation_model
    && attestation?.embedding_model,
  );
  if (!runtimePolicyEnforced()) return base;
  return base
    && attestation?.detected_generation_model
    && attestation?.detected_embedding_model;
}

function getOllamaBackoffMs(attempt) {
  return Math.min(2000 * attempt, 8000);
}

async function callOllamaOnce(prompt) {
  const res = await requestJson(
    'POST',
    `${OLLAMA_BASE_URL}/api/generate`,
    { 'Content-Type': 'application/json' },
    {
      model: OLLAMA_MODEL,
      stream: false,
      prompt,
      options: {
        temperature: 0,
        top_p: 1,
        num_predict: 1024
      }
    },
    OLLAMA_TIMEOUT_MS
  ).catch((error) => {
    throw new Error(networkErrorMessage(error));
  });

  const payload = res?.data || {};
  if (!res.ok) {
    const detail = typeof payload === 'object' ? JSON.stringify(payload) : String(payload || '');
    const error = new Error(`Ollama error ${res.status}: ${detail}`);
    error.status = res.status;
    throw error;
  }

  const text = typeof payload?.response === 'string' ? payload.response.trim() : '';
  if (!text) {
    throw new Error('Ollama returned empty response');
  }
  return text;
}

async function callOllama(prompt) {
  let lastError = null;
  for (let attempt = 1; attempt <= OLLAMA_MAX_RETRIES; attempt += 1) {
    try {
      return await callOllamaOnce(prompt);
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt >= OLLAMA_MAX_RETRIES) {
        throw error;
      }
      warn(`ollama request failed, retrying in ${getOllamaBackoffMs(attempt)}ms (attempt=${attempt}/${OLLAMA_MAX_RETRIES}): ${error.message}`);
      await sleep(getOllamaBackoffMs(attempt));
    }
  }
  throw lastError || new Error('Ollama request failed');
}

function normalizeOpenAICompatBaseUrl(rawValue) {
  let base = String(rawValue || '').trim();
  if (!base) return 'http://localhost:1234/v1';
  base = base.replace(/\/+$/, '');
  base = base.replace(/\/chat\/completions$/i, '');
  return base;
}

function normalizeOpenAICompatRoleMode(rawValue) {
  const mode = String(rawValue || 'auto').trim().toLowerCase();
  if (mode === 'system' || mode === 'user_only') return mode;
  return 'auto';
}

function buildOpenAICompatMessages(systemPrompt, userPrompt, useSystemRole) {
  const systemContent = String(systemPrompt || '');
  const userContent = String(userPrompt || '');

  if (useSystemRole) {
    return [
      { role: 'system', content: systemContent },
      { role: 'user', content: userContent }
    ];
  }

  return [
    {
      role: 'user',
      content: systemContent ? `${systemContent}\n\n---\n\n${userContent}` : userContent
    }
  ];
}

function isOpenAICompatRoleError(detailText) {
  const text = String(detailText || '').toLowerCase();
  return (
    text.includes('only user and assistant roles') ||
    text.includes('unsupported role') ||
    text.includes('system role') ||
    text.includes('template') ||
    text.includes('jinja')
  );
}

function isOpenAICompatModelNotFoundError(detailText) {
  const text = String(detailText || '').toLowerCase();
  return (
    text.includes('model_not_found') ||
    text.includes('invalid model identifier') ||
    text.includes('specify a valid downloaded model')
  );
}

function setActiveGenerationModel(modelId, reason = '') {
  const next = String(modelId || '').trim();
  if (!next || next === activeGenerationModel) return false;
  const previous = activeGenerationModel;
  activeGenerationModel = next;
  log(`generation model id resolved to "${next}" (configured "${previous}"${reason ? `, ${reason}` : ''})`);
  return true;
}

/** Ask the endpoint which id it exposes for the configured model. */
async function resolveGenerationModelFromEndpoint(reason = '') {
  if (LLM_PROVIDER !== 'openai_compat') return false;
  try {
    const available = await fetchOpenAICompatModelIds(
      normalizeOpenAICompatBaseUrl(OPENAI_COMPAT_BASE_URL),
      OPENAI_COMPAT_API_KEY,
    );
    const listed = resolveListedModelId(OPENAI_COMPAT_MODEL, available);
    if (!listed) {
      warn(`model "${OPENAI_COMPAT_MODEL}" is not listed by the local endpoint (listed: ${available.join(', ') || 'none'})`);
      return false;
    }
    return setActiveGenerationModel(listed, reason);
  } catch (error) {
    warn(`could not list local models: ${error?.message || String(error)}`);
    return false;
  }
}

async function callOpenAICompatOnce(prompt) {
  const baseUrl = normalizeOpenAICompatBaseUrl(OPENAI_COMPAT_BASE_URL);
  const headers = { 'Content-Type': 'application/json' };
  if (OPENAI_COMPAT_API_KEY) {
    headers.Authorization = `Bearer ${OPENAI_COMPAT_API_KEY}`;
  }

  const userPrompt = String(prompt || '');
  let useSystemRole = OPENAI_COMPAT_ROLE_MODE !== 'user_only';
  let withResponseFormat = true;
  let responseFormatRetryDone = false;
  let roleRetryDone = OPENAI_COMPAT_ROLE_MODE !== 'auto';
  let modelRetryDone = false;

  const buildPayload = () => ({
    model: activeGenerationModel,
    messages: buildOpenAICompatMessages(OPENAI_COMPAT_JSON_SYSTEM_PROMPT, userPrompt, useSystemRole),
    ...(withResponseFormat ? { response_format: { type: 'json_object' } } : {}),
    temperature: 0,
    top_p: 1,
    max_tokens: OPENAI_COMPAT_MAX_TOKENS,
    stream: false
  });

  const callEndpoint = async (payload) => requestJson(
    'POST',
    `${baseUrl}/chat/completions`,
    headers,
    payload,
    OLLAMA_TIMEOUT_MS
  ).catch((error) => {
    throw new Error(networkErrorMessage(error));
  });

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const res = await callEndpoint(buildPayload());

    if (res.ok) {
      const payload = res?.data || {};
      const text = String(payload?.choices?.[0]?.message?.content || '').trim();
      if (!text) {
        throw new Error('OpenAI-compatible endpoint returned empty response');
      }
      return text;
    }

    if (Number(res.status) !== 400) {
      const payload = res?.data || {};
      const detail = typeof payload === 'object' ? JSON.stringify(payload) : String(payload || '');
      const error = new Error(`OpenAI-compatible error ${res.status}: ${detail}`);
      error.status = res.status;
      throw error;
    }

    const detailText = JSON.stringify(res?.data || {}).toLowerCase();

    if (!modelRetryDone && isOpenAICompatModelNotFoundError(detailText)) {
      modelRetryDone = true;
      const rerouted = await resolveGenerationModelFromEndpoint(`rejected by endpoint as "${activeGenerationModel}"`);
      if (rerouted) continue;
    }

    if (!responseFormatRetryDone && (detailText.includes('response_format') || detailText.includes('json_object'))) {
      warn('openai_compat endpoint does not support response_format, retrying without it');
      withResponseFormat = false;
      responseFormatRetryDone = true;
      continue;
    }

    if (!roleRetryDone && useSystemRole && isOpenAICompatRoleError(detailText)) {
      warn('openai_compat endpoint does not support system role, retrying with user-only prompt');
      useSystemRole = false;
      roleRetryDone = true;
      continue;
    }

    const payload = res?.data || {};
    const detail = typeof payload === 'object' ? JSON.stringify(payload) : String(payload || '');
    const error = new Error(`OpenAI-compatible error ${res.status}: ${detail}`);
    error.status = res.status;
    throw error;
  }

  throw new Error('OpenAI-compatible request failed');
}

async function callOpenAICompat(prompt) {
  let lastError = null;
  for (let attempt = 1; attempt <= OLLAMA_MAX_RETRIES; attempt += 1) {
    try {
      return await callOpenAICompatOnce(prompt);
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt >= OLLAMA_MAX_RETRIES) {
        throw error;
      }
      warn(`openai_compat request failed, retrying in ${getOllamaBackoffMs(attempt)}ms (attempt=${attempt}/${OLLAMA_MAX_RETRIES}): ${error.message}`);
      await sleep(getOllamaBackoffMs(attempt));
    }
  }
  throw lastError || new Error('openai_compat request failed');
}

async function callLlm(prompt) {
  if (LLM_PROVIDER === 'openai_compat') {
    return callOpenAICompat(prompt);
  }
  return callOllama(prompt);
}

function parseJsonCandidate(text, fallback = {}) {
  const fenced = text.match(/```json\s*([\s\S]*?)```/i);
  const rawCandidate = (fenced ? fenced[1] : text || '').trim();
  const candidate = extractLikelyJsonObject(rawCandidate) || rawCandidate;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch {
    return fallback;
  }
}

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

function normalizeStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value.map((item) => String(item).trim()).filter(Boolean).slice(0, 10);
}

function normalizeStringArrayForSubmit(value, maxItems = 20, maxLength = 280) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => String(item || '').trim())
    .filter(Boolean)
    .map((item) => item.slice(0, maxLength))
    .slice(0, maxItems);
}

function normalizeRiskFlags(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const code = String(item?.code || '').trim().toUpperCase();
      const severity = String(item?.severity || '').trim().toLowerCase();
      const category = String(item?.category || '').trim().toLowerCase();
      const confidence = Number(item?.confidence);
      const evidence = Array.isArray(item?.evidence)
        ? item.evidence
          .map((entry) => ({
            quote: String(entry?.quote || '').trim().slice(0, 320),
            section: String(entry?.section || '').trim().slice(0, 120) || undefined
          }))
          .filter((entry) => entry.quote.length > 0)
          .slice(0, 4)
        : [];
      return {
        code,
        title: String(item?.title || '').trim().slice(0, 120) || code,
        severity: RISK_SEVERITIES.has(severity) ? severity : 'medium',
        category: RISK_CATEGORIES.has(category) ? category : 'missing_information',
        confidence: Number.isFinite(confidence) ? Math.max(0, Math.min(1, confidence)) : 0.5,
        description: String(item?.description || '').trim().slice(0, 260),
        why_it_matters: String(item?.why_it_matters || '').trim().slice(0, 240),
        evidence,
        missing_data: normalizeStringArrayForSubmit(item?.missing_data, 6, 120),
        suggested_question: String(item?.suggested_question || '').trim().slice(0, 220)
      };
    })
    .filter((item) => item.code && RISK_FLAG_CODES.has(item.code))
    .filter((item) => item.evidence.length > 0)
    .map((item) => ({
      code: item.code,
      title: item.title,
      severity: item.severity,
      category: item.category,
      confidence: item.confidence,
      description: item.description,
      why_it_matters: item.why_it_matters,
      evidence: item.evidence,
      missing_data: item.missing_data,
      suggested_question: item.suggested_question
    }))
    .slice(0, 10);
}

function normalizeHistoricalSimilarProposals(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => {
      const similarity = Number(item?.similarity);
      const rawOutcome = String(item?.outcome || '').toLowerCase();
      return {
        proposal_id: String(item?.proposal_id || '').trim(),
        similarity: Number.isFinite(similarity) ? Math.max(0, Math.min(1, similarity)) : 0,
        outcome: ['passed', 'failed', 'unknown'].includes(rawOutcome) ? rawOutcome : 'unknown'
      };
    })
    .filter((item) => item.proposal_id)
    .slice(0, 20);
}

function isValidParsedForPromptKey(promptKey, parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;

  if (promptKey === SUMMARY_PROMPT_KEY) {
    return typeof parsed.summary === 'string' || Array.isArray(parsed.positive_factors) || Array.isArray(parsed.recommendations);
  }

  if (promptKey === RISK_PROMPT_KEY) {
    return (
      typeof parsed.risk_level === 'string' ||
      typeof parsed.confidence === 'string' ||
      Array.isArray(parsed.risk_flags) ||
      Array.isArray(parsed.questions_to_author) ||
      Array.isArray(parsed.evidence_gaps)
    );
  }

  if (promptKey === HISTORICAL_PROMPT_KEY) {
    return Array.isArray(parsed.similar_proposals);
  }

  if (promptKey === BOUNTY_SCREEN_PROMPT_KEY) {
    const recommendation = String(parsed.recommendation || '').trim().toLowerCase();
    return (
      typeof parsed.summary === 'string'
      && (typeof parsed.pass === 'boolean' || parsed.pass === 'true' || parsed.pass === 'false')
      && ['needs_review', 'likely_complete', 'insufficient_proof'].includes(recommendation)
    );
  }

  if (promptKey === BOUNTY_CONSULTANT_PROMPT_KEY) {
    return typeof parsed.assistantMessage === 'string' && parsed.assistantMessage.trim().length > 0;
  }

  if (promptKey === BOUNTY_COMPOSER_PROMPT_KEY) {
    return typeof parsed.assistantMessage === 'string' && parsed.assistantMessage.trim().length > 0;
  }

  if (promptKey === RAG_IDLE_PROMPT_KEY) {
    return (
      typeof parsed === 'object'
      && parsed !== null
      && (
        'question' in parsed ||
        'answer' in parsed ||
        'primary_topic' in parsed ||
        'coherence_score' in parsed ||
        'completeness_score' in parsed ||
        'clarity_score' in parsed ||
        'assessment' in parsed
      )
    );
  }

  return true;
}

function buildRiskRepairPrompt(sourcePrompt, brokenOutput) {
  return [
    'You repair governance-risk output into strict JSON.',
    'Return ONLY a valid JSON object with keys:',
    'risk_level, confidence, risk_flags, questions_to_author, evidence_gaps.',
    'Each risk_flags item must include: code, title, severity, category, confidence, description, why_it_matters, evidence[], missing_data[], suggested_question.',
    'Use ONLY facts from SOURCE_PROMPT and keep exact evidence quotes.',
    'If no valid evidence quote exists for a risk, drop that risk.',
    '',
    'SOURCE_PROMPT:',
    String(sourcePrompt || ''),
    '',
    'BROKEN_MODEL_OUTPUT:',
    String(brokenOutput || '')
  ].join('\n');
}

async function recoverRiskParsed(sourcePrompt, brokenOutput) {
  try {
    const repairedText = await callLlm(buildRiskRepairPrompt(sourcePrompt, brokenOutput));
    const repaired = parseJsonCandidate(repairedText, {});
    if (isValidParsedForPromptKey(RISK_PROMPT_KEY, repaired)) {
      return repaired;
    }
  } catch (error) {
    warn(`risk repair failed: ${error.message}`);
  }
  return {
    risk_level: 'medium',
    confidence: 'low',
    risk_flags: [],
    questions_to_author: [],
    evidence_gaps: []
  };
}

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

function makeIdempotencyKey() {
  if (typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  return crypto.randomBytes(16).toString('hex');
}

function filterConsultantProvenancedLines(lines, maxItems = 8) {
  if (!Array.isArray(lines)) return [];
  return lines
    .map((item) => {
      if (!item || typeof item !== 'object') return null;
      const text = String(item.text || item.value || '').trim().slice(0, 400);
      const sourceCheckIds = Array.isArray(item.sourceCheckIds || item.source_check_ids)
        ? (item.sourceCheckIds || item.source_check_ids)
          .map((id) => String(id || '').trim())
          .filter(Boolean)
        : [];
      if (!text || !sourceCheckIds.length) return null;
      return { text, sourceCheckIds };
    })
    .filter(Boolean)
    .slice(0, maxItems);
}

function normalizeConsultantTurnForSubmit(payload) {
  const semanticFlags = normalizeStringArrayForSubmit(payload.semanticFlags || payload.semantic_flags, 8, 64)
    .map((flag) => String(flag).trim().toLowerCase())
    .filter((flag) => CONSULTANT_SEMANTIC_FLAGS.has(flag));
  const revisionDeltaSummary = String(payload.revisionDeltaSummary || payload.revision_delta_summary || '')
    .trim()
    .slice(0, 1200);
  return {
    assistantMessage: String(payload.assistantMessage || payload.assistant_message || '').trim().slice(0, 4000),
    semanticFlags,
    gaps: Array.isArray(payload.gaps) ? payload.gaps.slice(0, 12) : [],
    followUpChips: Array.isArray(payload.followUpChips || payload.follow_up_chips)
      ? (payload.followUpChips || payload.follow_up_chips).slice(0, 6)
      : [],
    requestChangeDraft: filterConsultantProvenancedLines(
      payload.requestChangeDraft || payload.request_change_draft,
      8,
    ),
    requestChangeDraftGrouped: Array.isArray(payload.requestChangeDraftGrouped || payload.request_change_draft_grouped)
      ? (payload.requestChangeDraftGrouped || payload.request_change_draft_grouped).slice(0, 4)
      : [],
    notesPatch: filterConsultantProvenancedLines(payload.notesPatch || payload.notes_patch, 8),
    suggestedQuestions: normalizeStringArrayForSubmit(
      payload.suggestedQuestions || payload.suggested_questions,
      8,
      280,
    ),
    ...(revisionDeltaSummary ? { revisionDeltaSummary } : {}),
  };
}

/** Pass-through of hub composer turn (already parsed/retried by runComposerLlmTurn). */
function normalizeComposerTurnForSubmit(payload) {
  const assistantMessage = String(payload?.assistantMessage || payload?.assistant_message || '').trim();
  if (!assistantMessage) {
    throw new Error('composer_empty_assistant_message');
  }
  return {
    mode: String(payload?.mode || '').trim().toLowerCase() === 'guidance' ? 'guidance' : 'draft',
    assistantMessage,
    draftPatch: payload?.draftPatch && typeof payload.draftPatch === 'object' ? payload.draftPatch : {},
    followUpChips: Array.isArray(payload?.followUpChips)
      ? payload.followUpChips
      : (Array.isArray(payload?.follow_up_chips) ? payload.follow_up_chips : []),
    ...(payload?.meta && typeof payload.meta === 'object' ? { meta: payload.meta } : {}),
  };
}

async function importComposerLlmService() {
  const candidates = [
    // Packaged Electron: service is copied next to the agent inside app.asar
    new URL('./bountyComposerLlmService.js', import.meta.url),
    // Monorepo / unpackaged: repo-root hub service
    new URL('../../src/services/bountyComposerLlmService.js', import.meta.url),
  ];
  let lastError = null;
  for (const serviceUrl of candidates) {
    try {
      return await import(serviceUrl.href);
    } catch (error) {
      lastError = error;
      const message = String(error?.message || error || '');
      const code = String(error?.code || '');
      const missing = code === 'ERR_MODULE_NOT_FOUND' || /Cannot find module/i.test(message);
      if (!missing) throw error;
    }
  }
  throw lastError || new Error('composer_llm_service_unavailable');
}

async function buildComposerTurnViaHubService(payload) {
  const turnInput = payload?.turn_input || payload?.turnInput;
  if (!turnInput || typeof turnInput !== 'object') {
    throw new Error('composer_turn_input_missing');
  }

  const { runComposerLlmTurn } = await importComposerLlmService();
  const turn = await runComposerLlmTurn(turnInput, {
    completeChat: async ({ messages }) => {
      const prompt = (Array.isArray(messages) ? messages : [])
        .map((message) => {
          const role = String(message?.role || 'user').toUpperCase();
          return `${role}:\n${String(message?.content || '').trim()}`;
        })
        .filter((line) => line.replace(/^(SYSTEM|USER|ASSISTANT):\n?/i, '').trim().length > 0)
        .join('\n\n');
      if (!prompt.trim()) {
        throw new Error('composer_empty_chat_messages');
      }
      return callLlm(prompt);
    },
  });
  return normalizeComposerTurnForSubmit(turn);
}

function normalizeResultForSubmit(taskType, resultJson) {
  const payload = resultJson && typeof resultJson === 'object' ? resultJson : {};

  if (taskType === SUMMARY_PROMPT_KEY) {
    const summary = String(payload.summary || '').trim();
    return {
      summary: summary.slice(0, 4000),
      positive_factors: normalizeStringArrayForSubmit(payload.positive_factors, 20, 280),
      recommendations: normalizeStringArrayForSubmit(payload.recommendations, 20, 280)
    };
  }

  if (taskType === RISK_PROMPT_KEY) {
    const riskLevelRaw = String(payload.risk_level || '').trim().toLowerCase();
    const confidenceRaw = String(payload.confidence || '').trim().toLowerCase();
    const riskLevel = ['low', 'medium', 'high'].includes(riskLevelRaw) ? riskLevelRaw : 'medium';
    const confidence = ['low', 'medium', 'high'].includes(confidenceRaw) ? confidenceRaw : 'medium';
    const riskFlags = normalizeRiskFlags(payload.risk_flags);
    return {
      risk_level: riskLevel,
      confidence,
      risk_flags: riskFlags,
      questions_to_author: normalizeStringArrayForSubmit(payload.questions_to_author, 20, 280),
      evidence_gaps: normalizeStringArrayForSubmit(payload.evidence_gaps, 20, 280)
    };
  }

  if (taskType === HISTORICAL_PROMPT_KEY) {
    const similarProposals = Array.isArray(payload.similar_proposals)
      ? payload.similar_proposals
        .map((item) => {
          const proposalId = String(item?.proposal_id || '').trim().slice(0, 128);
          const similarity = Number(item?.similarity);
          const outcomeRaw = String(item?.outcome || '').trim().toLowerCase();
          const outcome = ['passed', 'failed', 'unknown'].includes(outcomeRaw) ? outcomeRaw : 'unknown';
          return {
            proposal_id: proposalId,
            similarity: Number.isFinite(similarity) ? Math.max(0, Math.min(1, similarity)) : 0,
            outcome
          };
        })
        .filter((item) => item.proposal_id.length > 0)
        .slice(0, 30)
      : [];
    return { similar_proposals: similarProposals };
  }

  if (taskType === BOUNTY_SCREEN_PROMPT_KEY) {
    const recommendationRaw = String(payload.recommendation || 'needs_review').trim().toLowerCase();
    const recommendation = ['needs_review', 'likely_complete', 'insufficient_proof'].includes(recommendationRaw)
      ? recommendationRaw
      : 'needs_review';
    const confidenceNum = Number(payload.confidence);
    const confidence = Number.isFinite(confidenceNum)
      ? Math.max(0, Math.min(1, confidenceNum))
      : 0.5;
    return {
      pass: Boolean(payload.pass),
      flags: normalizeStringArrayForSubmit(payload.flags, 12, 64),
      confidence,
      summary: String(payload.summary || '').trim().slice(0, 4000),
      missing: normalizeStringArrayForSubmit(payload.missing, 12, 280),
      suggested_questions: normalizeStringArrayForSubmit(payload.suggested_questions, 12, 280),
      recommendation,
    };
  }

  if (taskType === BOUNTY_CONSULTANT_PROMPT_KEY) {
    return normalizeConsultantTurnForSubmit(payload);
  }

  if (taskType === BOUNTY_COMPOSER_PROMPT_KEY) {
    return normalizeComposerTurnForSubmit(payload);
  }

  if (taskType === RAG_IDLE_PROMPT_KEY) {
    const subtype = String(payload.subtype || '').trim();
    if (subtype === 'qa_pair_gen' || (!subtype && ('question' in payload || 'answer' in payload))) {
      const question = String(payload.question || payload.q || 'What is the key point in this knowledge section?').trim();
      const answer = String(payload.answer || payload.a || 'The section outlines standard protocol parameters and verification procedures.').trim();
      const rawConfidence = Number(payload.confidence);
      const confidence = Number.isFinite(rawConfidence) && rawConfidence >= 0 && rawConfidence <= 1 ? rawConfidence : 0.95;
      return {
        question: question.length >= 5 ? question : 'What is the key point in this knowledge section?',
        answer: answer.length >= 10 ? answer : 'The section outlines standard protocol parameters and verification procedures.',
        confidence,
      };
    }
    if (subtype === 'embed_verify' || (!subtype && 'primary_topic' in payload)) {
      const primaryTopic = String(payload.primary_topic || 'Protocol Architecture').trim();
      const keyConcepts = Array.isArray(payload.key_concepts)
        ? payload.key_concepts.map((k) => String(k).trim()).filter(Boolean).slice(0, 5)
        : ['Quavence Protocol', 'PoUS Verification'];
      const isSelfContained = payload.is_self_contained !== undefined ? Boolean(payload.is_self_contained) : true;
      const rawScore = Number(payload.coherence_score);
      const coherenceScore = Number.isFinite(rawScore) && rawScore >= 0 && rawScore <= 1 ? rawScore : 0.95;
      return {
        primary_topic: primaryTopic || 'Protocol Architecture',
        key_concepts: keyConcepts.length > 0 ? keyConcepts : ['Quavence Protocol', 'PoUS Verification'],
        is_self_contained: isSelfContained,
        coherence_score: coherenceScore,
      };
    }
    if (subtype === 'chunk_coherence' || (!subtype && ('completeness_score' in payload || 'clarity_score' in payload))) {
      const rawCompleteness = Number(payload.completeness_score);
      const rawClarity = Number(payload.clarity_score);
      const completenessScore = Number.isFinite(rawCompleteness) && rawCompleteness >= 0 && rawCompleteness <= 1 ? rawCompleteness : 0.95;
      const clarityScore = Number.isFinite(rawClarity) && rawClarity >= 0 && rawClarity <= 1 ? rawClarity : 0.95;
      const suggestedHeading = String(payload.suggested_heading || 'Protocol Architecture').trim();
      const notes = String(payload.notes || 'Verified chunk integrity.').trim();
      return {
        completeness_score: completenessScore,
        clarity_score: clarityScore,
        suggested_heading: suggestedHeading || 'Protocol Architecture',
        ...(notes ? { notes } : {}),
      };
    }
    return canonicalize(payload);
  }

  return canonicalize(payload);
}

async function buildTaskResult(task) {
  const payload = task?.result_json && typeof task.result_json === 'object' ? task.result_json : {};
  const prompt = String(payload.prompt || '').trim();
  const promptKey = String(payload.prompt_key || task.task_type || '').trim();

  // Composer: run the same hub turn brain with worker LLM as completeChat (retries preserved).
  if (promptKey === BOUNTY_COMPOSER_PROMPT_KEY || task.task_type === BOUNTY_COMPOSER_PROMPT_KEY) {
    return buildComposerTurnViaHubService(payload);
  }

  // RAG Knowledge Base Verification
  if (promptKey === RAG_IDLE_PROMPT_KEY || task.task_type === RAG_IDLE_PROMPT_KEY || payload.rag_idle_task) {
    const chunkTitle = String(payload.chunk?.title || 'Knowledge Chunk');
    const chunkText = String(payload.chunk?.text || '');
    const instructions = String(payload.instructions || 'Analyze the chunk and extract structured assessment.');
    const schemaObj = payload.expected_schema || {};
    const schemaStr = JSON.stringify(schemaObj);

    const ragPrompt = [
      'You are the Quavence Knowledge Base RAG Verification AI Worker.',
      'Analyze the given knowledge base chunk according to instructions and return ONLY a valid JSON object matching the requested schema. Do not include markdown fences, comments, or extra text.',
      '',
      `KNOWLEDGE BASE CHUNK [${chunkTitle}]:`,
      chunkText,
      '',
      'INSTRUCTIONS:',
      instructions,
      '',
      'EXPECTED JSON SCHEMA:',
      schemaStr,
      '',
      'Return JSON matching schema:'
    ].join('\n');

    const modelText = await callLlm(ragPrompt);
    let parsed = parseJsonCandidate(modelText, {});
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      parsed = {};
    }
    return normalizeResultForSubmit(RAG_IDLE_PROMPT_KEY, {
      subtype: payload.subtype,
      ...parsed,
    });
  }

  if (!prompt) {
    return {
      worker_notice: 'No prompt payload found in task.result_json',
      task_type: task.task_type,
      completed_at: new Date().toISOString()
    };
  }

  const modelText = await callLlm(prompt);
  let parsed = parseJsonCandidate(modelText, {});

  if (!isValidParsedForPromptKey(promptKey, parsed)) {
    if (promptKey === RISK_PROMPT_KEY) {
      warn('risk task got non-structured model output, running repair pass');
      parsed = await recoverRiskParsed(prompt, modelText);
    } else {
      throw new Error(`Model returned invalid structured output for ${promptKey}`);
    }
  }

  if (promptKey === SUMMARY_PROMPT_KEY) {
    const fallbackSummary = String(modelText || '').trim().slice(0, 4000);
    return {
      summary: String(parsed.summary || fallbackSummary).trim(),
      positive_factors: normalizeStringArray(parsed.positive_factors),
      recommendations: normalizeStringArray(parsed.recommendations)
    };
  }

  if (promptKey === RISK_PROMPT_KEY) {
    const riskLevelRaw = String(parsed.risk_level || 'medium').toLowerCase();
    const confidenceRaw = String(parsed.confidence || 'medium').toLowerCase();
    const riskLevel = ['low', 'medium', 'high'].includes(riskLevelRaw) ? riskLevelRaw : 'medium';
    const confidence = ['low', 'medium', 'high'].includes(confidenceRaw) ? confidenceRaw : 'medium';

    return {
      risk_level: riskLevel,
      confidence,
      risk_flags: normalizeRiskFlags(parsed.risk_flags),
      questions_to_author: normalizeStringArray(parsed.questions_to_author),
      evidence_gaps: normalizeStringArray(parsed.evidence_gaps)
    };
  }

  if (promptKey === HISTORICAL_PROMPT_KEY) {
    return {
      similar_proposals: normalizeHistoricalSimilarProposals(parsed.similar_proposals)
    };
  }

  if (promptKey === BOUNTY_SCREEN_PROMPT_KEY) {
    const recommendationRaw = String(parsed.recommendation || 'needs_review').trim().toLowerCase();
    const recommendation = ['needs_review', 'likely_complete', 'insufficient_proof'].includes(recommendationRaw)
      ? recommendationRaw
      : 'needs_review';
    const confidenceNum = Number(parsed.confidence);
    const confidence = Number.isFinite(confidenceNum)
      ? Math.max(0, Math.min(1, confidenceNum))
      : 0.5;
    return {
      pass: Boolean(parsed.pass),
      flags: normalizeStringArrayForSubmit(parsed.flags, 12, 64),
      confidence,
      summary: String(parsed.summary || '').trim().slice(0, 4000),
      missing: normalizeStringArrayForSubmit(parsed.missing, 12, 280),
      suggested_questions: normalizeStringArrayForSubmit(parsed.suggested_questions, 12, 280),
      recommendation,
    };
  }

  if (promptKey === BOUNTY_CONSULTANT_PROMPT_KEY) {
    return normalizeConsultantTurnForSubmit(parsed);
  }

  if (promptKey === BOUNTY_COMPOSER_PROMPT_KEY) {
    return normalizeComposerTurnForSubmit(parsed);
  }

  throw new Error(`unsupported_task_type:${promptKey || task.task_type || 'unknown'}`);
}

async function heartbeat() {
  const payload = {};
  if (WORKER_QVNC_ADDRESS) payload.qvnc_address = WORKER_QVNC_ADDRESS;
  if (WORKER_KEYPAIR?.publicKeyHex) payload.worker_pubkey = WORKER_KEYPAIR.publicKeyHex;
  if (WORKER_COUNTRY_CODE) payload.country_code = WORKER_COUNTRY_CODE;
  if (WORKER_COUNTRY_NAME) payload.country_name = WORKER_COUNTRY_NAME;
  if (WORKER_REGION_NAME) payload.region_name = WORKER_REGION_NAME;
  if (WORKER_COUNTRY_CODE || WORKER_COUNTRY_NAME || WORKER_REGION_NAME) {
    payload.geo_source = 'self_reported';
  }
  const res = await apiCall('POST', '/api/ai/nodes/heartbeat', payload);
  if (!res.ok) {
    if (isHubAccessSuspendedResponse(res)) {
      handleHubAccessSuspended(res, 'heartbeat');
    }
    if (isWorkerDeviceBindingError(res)) {
      handleWorkerDeviceBindingFailure(res, 'heartbeat');
    }
    throw buildHubError('heartbeat', res);
  }
}

function markHubRuntimeAttestationRejected(policyVersion = '') {
  hubRuntimeAttestationRejected = true;
  hubRuntimeAttestationRejectedVersion = String(policyVersion || runtimePolicy?.runtime_policy_version || '').trim();
  runtimePolicyBlocked = true;
  runtimePolicyBlockReason = 'Runtime blocked: hub rejected runtime attestation';
}

async function refreshRuntimePolicyState() {
  const previousPolicy = runtimePolicy;
  runtimePolicy = await fetchHubRuntimePolicy(apiCall);
  runtimePolicyFetchedAt = Date.now();

  if (!runtimePolicy) {
    if (previousPolicy?.enabled && previousPolicy.mode !== 'off') {
      runtimePolicyBlocked = true;
      runtimePolicyBlockReason = 'Runtime blocked: could not fetch Hub runtime policy';
      runtimeAttestation = null;
      warn(runtimePolicyBlockReason);
      return false;
    }
    runtimePolicyBlocked = false;
    runtimePolicyBlockReason = hubRuntimeAttestationRejected
      ? 'Runtime blocked: hub rejected runtime attestation'
      : '';
    runtimeAttestation = null;
    return !runtimePolicyBlocked;
  }

  if (!runtimePolicy.enabled || runtimePolicy.mode === 'off') {
    hubRuntimeAttestationRejected = false;
    hubRuntimeAttestationRejectedVersion = '';
    runtimePolicyBlocked = false;
    runtimePolicyBlockReason = '';
    runtimeAttestation = buildRuntimeAttestation(runtimePolicy);
    await resolveGenerationModelFromEndpoint('policy off');
    return true;
  }

  const verification = await verifyLocalRuntimeAgainstPolicy({
    policy: runtimePolicy,
    llmProvider: LLM_PROVIDER,
    baseUrl: normalizeOpenAICompatBaseUrl(OPENAI_COMPAT_BASE_URL),
    apiKey: OPENAI_COMPAT_API_KEY,
  });

  runtimeAttestation = verification.blocked
    ? null
    : (verification.attestation || buildRuntimeAttestation(runtimePolicy));

  if (!verification.blocked) {
    setActiveGenerationModel(verification.detected_generation_model, 'detected on endpoint');
  }

  const policyVersion = String(runtimePolicy.runtime_policy_version || '').trim();
  if (hubRuntimeAttestationRejected) {
    const versionChanged = policyVersion
      && hubRuntimeAttestationRejectedVersion
      && policyVersion !== hubRuntimeAttestationRejectedVersion;
    // Retry when local runtime still looks healthy — hub policy may have softened,
    // or attestation improved (detected ids). Avoid permanent lock until policy bump.
    const canRetryClaim = !verification.blocked && Boolean(verification.attestation);
    if ((versionChanged || canRetryClaim) && !verification.blocked) {
      hubRuntimeAttestationRejected = false;
      hubRuntimeAttestationRejectedVersion = '';
      runtimePolicyBlocked = false;
      runtimePolicyBlockReason = '';
    } else {
      runtimePolicyBlocked = true;
      runtimePolicyBlockReason = 'Runtime blocked: hub rejected runtime attestation';
      if (!verification.blocked) {
        warn(`${runtimePolicyBlockReason} (waiting for Hub policy update or worker restart)`);
      }
      return false;
    }
  }

  runtimePolicyBlocked = Boolean(verification.blocked);
  runtimePolicyBlockReason = verification.reason || '';
  if (runtimePolicyBlocked) {
    warn(runtimePolicyBlockReason);
  }
  return !runtimePolicyBlocked;
}

async function claimTask() {
  if (claimBackoffUntil > Date.now()) {
    return null;
  }
  if (runtimePolicyBlocked) {
    return null;
  }

  if (runtimePolicyEnforced() && !hasRuntimeAttestation()) {
    try {
      const runtimeOk = await refreshRuntimePolicyState();
      if (!runtimeOk || !hasRuntimeAttestation()) {
        return null;
      }
    } catch (error) {
      if (isTransientNetworkError(error)) {
        return null;
      }
      throw error;
    }
  }

  const res = await apiCall('POST', '/api/ai/nodes/tasks/claim', {
    runtime_attestation: runtimeAttestation,
  });

  if (res.status === 503) {
    log('execution disabled by runtime switch');
    return null;
  }

  if (res.status === 429) {
    claimBackoffUntil = Date.now() + Math.max(POLL_INTERVAL_MS * 3, 12000);
    log('Waiting for tasks');
    return null;
  }

  if (res.ok && res.data?.duplicate_blocked) {
    log('Task already completed for this owner; waiting for new tasks');
    return null;
  }

  if (!res.ok) {
    if (res.status === 409 && res.data?.code === 'ai_worker_terms_required') {
      runtimePolicyBlocked = true;
      runtimePolicyBlockReason = 'Accept updated worker terms in the web app.';
      warn(runtimePolicyBlockReason);
      return null;
    }
    if (res.status === 409 && (res.data?.code === 'ai_worker_runtime_policy_mismatch' || res.data?.reason === 'ai_worker_runtime_policy_mismatch')) {
      const mismatchLabels = formatRuntimeMismatchLabels(res.data?.mismatches);
      const mismatchDetail = mismatchLabels.length
        ? ` (${mismatchLabels.join('; ')})`
        : '';
      if (hasRuntimeAttestation()) {
        markHubRuntimeAttestationRejected(runtimeAttestation?.runtime_policy_version);
        // Short backoff so refreshRuntimePolicyState can retry after hub/policy softens.
        claimBackoffUntil = Date.now() + Math.max(POLL_INTERVAL_MS * 5, 30000);
      } else {
        runtimePolicyBlocked = true;
        runtimePolicyBlockReason = 'Runtime blocked: waiting for Hub runtime policy sync';
        warn(runtimePolicyBlockReason);
        return null;
      }
      warn(`${runtimePolicyBlockReason}${mismatchDetail}`);
      return null;
    }
    if (isHubAccessSuspendedResponse(res)) {
      handleHubAccessSuspended(res, 'claim');
    }
    if (isWorkerDeviceBindingError(res)) {
      handleWorkerDeviceBindingFailure(res, 'claim');
    }
    throw buildHubError('claim', res);
  }

  claimBackoffUntil = 0;
  const task = res?.data?.data || null;
  return task;
}

function formatTaskCompletedLogLine(taskId, completionPayload) {
  const reward = completionPayload?.reward;
  const asset = String(reward?.asset || 'QVNC').trim() || 'QVNC';
  const rewardAmount = reward?.amount != null ? String(reward.amount) : '?';
  const usdRaw = reward?.meta?.usd_amount;
  const usd = Number(usdRaw);
  if (Number.isFinite(usd) && usd > 0) {
    return `task completed: ${taskId} (~$${usd.toFixed(4)} USD → ${rewardAmount} ${asset})`;
  }
  if (reward?.amount != null && String(reward.amount).trim() !== '') {
    return `task completed: ${taskId} (${reward.amount} ${asset})`;
  }
  return `task completed: ${taskId}`;
}

async function completeTask(taskId, taskType, claimNonce, resultJson) {
  if (!claimNonce) {
    throw new Error('Missing claim nonce for secure submit');
  }

  const normalizedResult = normalizeResultForSubmit(taskType, resultJson);
  const submitIdempotencyKey = makeIdempotencyKey();
  const submitTimestamp = Math.floor(Date.now() / 1000);
  const submitSignature = buildSubmitSignature(NODE_TOKEN, taskId, claimNonce, submitTimestamp, normalizedResult);

  const res = await apiCall('POST', `/api/ai/nodes/tasks/${encodeURIComponent(taskId)}/complete`, {
    result_json: normalizedResult,
    claim_nonce: claimNonce,
    submit_timestamp: submitTimestamp,
    submit_idempotency_key: submitIdempotencyKey,
    submit_signature: submitSignature,
    runtime_metadata: runtimeAttestation,
    provider: runtimeAttestation?.provider,
    model: runtimeAttestation?.generation_model,
    embedding_model: runtimeAttestation?.embedding_model,
    runtime_policy_version: runtimeAttestation?.runtime_policy_version,
  });
  if (!res.ok) {
    if (res.status === 409 && res.data?.code === 'ai_worker_runtime_policy_mismatch') {
      markHubRuntimeAttestationRejected(runtimeAttestation?.runtime_policy_version);
      runtimePolicyBlockReason = 'Runtime blocked: hub rejected runtime metadata on complete';
      const mismatchLabels = formatRuntimeMismatchLabels(res.data?.mismatches);
      const mismatchDetail = mismatchLabels.length
        ? ` (${mismatchLabels.join('; ')})`
        : '';
      warn(`${runtimePolicyBlockReason}${mismatchDetail}`);
      return { runtimePolicyMismatch: true };
    }
    if (res.status === 409 && res.data?.code === 'ai_worker_duplicate_task_attempt') {
      warn('Task already completed for this owner; waiting for new tasks');
      return { duplicateBlocked: true };
    }
    if (isHubAccessSuspendedResponse(res)) {
      handleHubAccessSuspended(res, 'complete');
    }
    if (isWorkerDeviceBindingError(res)) {
      handleWorkerDeviceBindingFailure(res, 'complete');
    }
    if (isTaskLeaseExpiredError(res)) {
      return handleTaskLeaseExpired('complete', taskId);
    }
    throw buildHubError('complete', res);
  }
  return res?.data?.data || null;
}

function inferFailReasonCode(errorMessage) {
  const message = String(errorMessage || '').trim().toLowerCase();
  if (message.startsWith('unsupported_task_type')) return 'unsupported_task_type';
  if (message.includes('invalid_result')) return 'invalid_result';
  if (message.includes('timeout') || message.includes('etimedout')) return 'timeout';
  if (message.includes('econnrefused') || message.includes('runtime_unavailable')) return 'runtime_unavailable';
  if (
    message.includes('model_unavailable')
    || message.includes('no models loaded')
    || message.includes('lms load')
    || (message.includes('model') && message.includes('unavailable'))
    || (message.includes('model') && message.includes('not loaded'))
  ) {
    return 'model_unavailable';
  }
  if (
    message.includes('provider_error')
    || message.includes('openai-compatible error')
    || message.includes('openai_compat')
    || message.includes('provider')
  ) {
    return 'provider_error';
  }
  return 'unknown';
}

async function failTask(taskId, errorMessage) {
  if (Date.now() < failRateLimitUntil) {
    warn(`fail report skipped while rate-limit cooldown is active for task ${taskId}`);
    return { rateLimited: true };
  }

  const reason_code = inferFailReasonCode(errorMessage);
  const provider = LLM_PROVIDER;
  const model = LLM_PROVIDER === 'openai_compat' ? OPENAI_COMPAT_MODEL : OLLAMA_MODEL;

  const res = await apiCall('POST', `/api/ai/nodes/tasks/${encodeURIComponent(taskId)}/fail`, {
    error_message: String(errorMessage || 'Worker execution failed'),
    reason_code,
    provider,
    model,
  });

  if (res.status === 429) {
    const retryAfter = Number(res?.data?.retry_after_seconds || 15);
    const cooldownMs = Math.max(1000, retryAfter * 1000);
    failRateLimitUntil = Date.now() + cooldownMs;
    warn(`fail endpoint rate-limited for task ${taskId}, cooldown ${retryAfter}s`);
    return { rateLimited: true, retryAfterSeconds: retryAfter };
  }

  if (!res.ok) {
    if (isWorkerDeviceBindingError(res)) {
      handleWorkerDeviceBindingFailure(res, 'fail');
    }
    if (isTaskLeaseExpiredError(res)) {
      return handleTaskLeaseExpired('fail', taskId);
    }
    warn(apiErrorMessage(`fail endpoint for task ${taskId}`, res));
  }
  return { ok: res.ok };
}

async function processTask(task) {
  const taskId = task?.id;
  if (!taskId) return;

  log(`task claimed: ${taskId} (${task.task_type})`);

  const taskType = String(task?.task_type || '').trim().toUpperCase();
  if (!WORKER_EXECUTABLE_TASK_TYPES.has(taskType)) {
    const message = `unsupported_task_type:${taskType || 'unknown'}`;
    await failTask(taskId, message);
    warn(`task failed: ${taskId} -> ${message}`);
    return;
  }

  let lastError = null;

  for (let attempt = 1; attempt <= TASK_EXECUTION_MAX_RETRIES; attempt += 1) {
    try {
      if (runtimePolicy?.enabled && runtimePolicy.mode !== 'off') {
        const runtimeOk = await refreshRuntimePolicyState();
        if (!runtimeOk || runtimePolicyBlocked) {
          const message = runtimePolicyBlockReason || 'runtime policy mismatch';
          warn(`task failed: ${taskId} -> ${message}`);
          await failTask(taskId, message);
          return;
        }
      }

      const resultJson = await buildTaskResult(task);
      const claimNonce = String(task?.claim_nonce || '').trim();
      const completion = await completeTask(taskId, String(task?.task_type || ''), claimNonce, resultJson);
      if (completion?.leaseExpired) {
        return;
      }
      if (completion?.runtimePolicyMismatch) {
        warn(`task complete rejected by hub runtime policy: ${taskId}`);
        return;
      }
      if (completion?.duplicateBlocked) {
        warn(`task already completed for owner; waiting for new tasks: ${taskId}`);
        return;
      }
      log(formatTaskCompletedLogLine(taskId, completion));
      return;
    } catch (error) {
      lastError = error;
      if (!isTransientNetworkError(error) || attempt >= TASK_EXECUTION_MAX_RETRIES) {
        break;
      }
      const retryMs = getNetworkBackoffMs();
      warn(`task transient failure: ${taskId} -> ${error.message}; retrying in ${retryMs}ms (attempt=${attempt}/${TASK_EXECUTION_MAX_RETRIES})`);
      await sleep(retryMs);
    }
  }

  warn(`task failed: ${taskId} -> ${lastError?.message || 'unknown error'}`);
  const failMessage = String(lastError?.message || 'Worker execution failed');
  if (/no models loaded/i.test(failMessage)) {
    warn('hint: load the required model in LM Studio (Developer page or lms load), then keep Local Server running');
  }
  const failResult = await failTask(taskId, failMessage);
  if (failResult?.leaseExpired) {
    return;
  }
}

async function workerLoop() {
  while (!stopRequested) {
    if (deviceBindingStop) {
      break;
    }
    if (hubAccessSuspendedStop) {
      break;
    }
    try {
      const policyMissing = !runtimePolicy;
      const policyStale = policyMissing || (Date.now() - runtimePolicyFetchedAt >= RUNTIME_POLICY_REFRESH_MS);
      const shouldRefreshPolicy = policyStale && (policyMissing || runtimePolicyEnforced());
      if (shouldRefreshPolicy) {
        try {
          await refreshRuntimePolicyState();
        } catch (error) {
          if (isTransientNetworkError(error)) {
            networkErrorStreak += 1;
            const retryMs = getNetworkBackoffMs();
            if (networkErrorStreak === 1 || networkErrorStreak % 5 === 0) {
              warn(`runtime policy unreachable, retrying in ${retryMs}ms (streak=${networkErrorStreak})`);
            }
            await sleep(retryMs);
            continue;
          }
          warn(`runtime policy refresh failed: ${error.message}`);
        }
      }
      const task = await claimTask();
      networkErrorStreak = 0;
      if (task) {
        await processTask(task);
        continue;
      }
    } catch (error) {
      if (isFatalHubError(error)) {
        handleFatalHubError(error);
        process.exit(1);
      }
      if (isTransientNetworkError(error)) {
        networkErrorStreak += 1;
        const retryMs = getNetworkBackoffMs();
        if (networkErrorStreak === 1 || networkErrorStreak % 5 === 0) {
          if (Number(error?.status) === 429) {
            log(`backend rate-limited worker requests, backing off for ${retryMs}ms (streak=${networkErrorStreak})`);
          } else {
            warn(`backend unreachable, retrying in ${retryMs}ms (streak=${networkErrorStreak})`);
          }
        }
        await sleep(retryMs);
        continue;
      }
      warn(`loop error: ${error.message}`);
    }

    await sleep(POLL_INTERVAL_MS);
  }
}

function wireSignals() {
  const shutdown = () => {
    if (stopRequested) return;
    stopRequested = true;
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = null;
    }
    log('shutdown requested');
  };

  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

function isTransientNetworkError(error) {
  if (isHubTransientNetworkError(error)) {
    return true;
  }
  const status = Number(error?.status);
  return status === 429 || status >= 500;
}

function getNetworkBackoffMs() {
  const multiplier = Math.max(1, Math.min(networkErrorStreak, 8));
  return Math.min(POLL_INTERVAL_MS * multiplier, 30000);
}

async function start() {
  assertConfig();
  wireSignals();

  log('starting worker agent');
  log(`Device registered: ${shortDeviceId(WORKER_DEVICE_ID)}`);
  log(`executable_task_types=${[...WORKER_EXECUTABLE_TASK_TYPES].join(',')}`);
  if (LLM_PROVIDER === 'openai_compat') {
    log(
      `api=${API_BASE_URL}, provider=openai_compat, base=${normalizeOpenAICompatBaseUrl(OPENAI_COMPAT_BASE_URL)}, model=${OPENAI_COMPAT_MODEL}`
    );
  } else {
    log(`api=${API_BASE_URL}, provider=ollama, ollama=${OLLAMA_BASE_URL}, model=${OLLAMA_MODEL}`);
  }

  await resolveGenerationModelFromEndpoint('startup');

  try {
    await refreshRuntimePolicyState();
  } catch (error) {
    warn(`runtime policy check failed: ${error.message}`);
  }

  // Do not fail hard on startup when backend is temporarily unavailable.
  // Worker should self-recover once API becomes reachable again.
  try {
    await heartbeat();
  } catch (error) {
    if (isFatalHubError(error)) {
      handleFatalHubError(error);
      throw error;
    }
    warn(`initial heartbeat failed, worker will retry automatically: ${error.message}`);
  }

  heartbeatTimer = setInterval(() => {
    void heartbeat().catch((error) => {
      if (isFatalHubError(error)) {
        handleFatalHubError(error);
        process.exit(1);
        return;
      }
      if (isTransientNetworkError(error)) {
        heartbeatNetworkErrorStreak += 1;
        if (heartbeatNetworkErrorStreak === 1 || heartbeatNetworkErrorStreak % 3 === 0) {
          if (Number(error?.status) === 429) {
            log(`heartbeat temporarily rate-limited, keeping worker alive (streak=${heartbeatNetworkErrorStreak})`);
          } else {
            warn(`heartbeat network issue, waiting for backend recovery (streak=${heartbeatNetworkErrorStreak})`);
          }
        }
        return;
      }
      heartbeatNetworkErrorStreak = 0;
      warn(`heartbeat error: ${error.message}`);
    });
  }, HEARTBEAT_INTERVAL_MS);

  await workerLoop();
}

start().catch((error) => {
  if (isFatalHubError(error)) {
    handleFatalHubError(error);
  } else {
    console.error('[ai-worker] fatal:', error.message);
  }
  process.exit(1);
});

