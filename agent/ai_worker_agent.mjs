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
const OPENAI_COMPAT_MAX_TOKENS = Number(process.env.AI_WORKER_LLM_MAX_TOKENS || 4096);
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
let activeGenerationModel = OPENAI_COMPAT_MODEL;
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

const WORKER_HARDWARE_FINGERPRINT = String(process.env.AI_WORKER_HARDWARE_FINGERPRINT || '').trim() || collectHardwareFingerprint();

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
        'X-AI-Worker-Hardware-Fingerprint': WORKER_HARDWARE_FINGERPRINT,
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

function stripThinkingBlocks(text) {
  const source = String(text || '').trim();
  if (!source) return '';
  return source.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

async function callOllamaOnce(prompt, options = {}) {
  const system = options.systemPrompt || undefined;
  const res = await requestJson(
    'POST',
    `${OLLAMA_BASE_URL}/api/generate`,
    { 'Content-Type': 'application/json' },
    {
      model: OLLAMA_MODEL,
      stream: false,
      prompt,
      ...(system ? { system } : {}),
      options: {
        temperature: options.temperature !== undefined ? options.temperature : 0,
        top_p: 1,
        num_predict: options.max_tokens || 2048,
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
  return stripThinkingBlocks(text);
}

async function callOllama(prompt, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= OLLAMA_MAX_RETRIES; attempt += 1) {
    try {
      return await callOllamaOnce(prompt, options);
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

async function callOpenAICompatOnce(prompt, options = {}) {
  const baseUrl = normalizeOpenAICompatBaseUrl(OPENAI_COMPAT_BASE_URL);
  const headers = { 'Content-Type': 'application/json' };
  if (OPENAI_COMPAT_API_KEY) {
    headers.Authorization = `Bearer ${OPENAI_COMPAT_API_KEY}`;
  }

  const userPrompt = String(prompt || '');
  const systemPrompt = options.systemPrompt || OPENAI_COMPAT_JSON_SYSTEM_PROMPT;
  let useSystemRole = OPENAI_COMPAT_ROLE_MODE !== 'user_only';
  let withResponseFormat = true;
  let responseFormatRetryDone = false;
  let roleRetryDone = OPENAI_COMPAT_ROLE_MODE !== 'auto';
  let modelRetryDone = false;

  const buildPayload = () => ({
    model: activeGenerationModel,
    messages: buildOpenAICompatMessages(systemPrompt, userPrompt, useSystemRole),
    ...(withResponseFormat ? { response_format: { type: 'json_object' } } : {}),
    temperature: options.temperature !== undefined ? options.temperature : 0,
    top_p: 1,
    ...(options.presence_penalty !== undefined ? { presence_penalty: options.presence_penalty } : {}),
    ...(options.frequency_penalty !== undefined ? { frequency_penalty: options.frequency_penalty } : {}),
    max_tokens: options.max_tokens || OPENAI_COMPAT_MAX_TOKENS,
    stream: false,
    enable_thinking: false,
    chat_template_kwargs: { enable_thinking: false }
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
      const choice = payload?.choices?.[0];
      const message = choice?.message || {};
      let text = String(message?.content || '').trim();
      if (!text) {
        if (message.reasoning_content) {
          text = String(message.reasoning_content).trim();
        } else if (message.reasoning) {
          text = String(message.reasoning).trim();
        }
      }
      if (!text) {
        const finishReason = choice?.finish_reason ? ` (finish_reason: ${choice.finish_reason})` : '';
        throw new Error(`OpenAI-compatible endpoint returned empty response${finishReason}`);
      }
      return stripThinkingBlocks(text);
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

async function callOpenAICompat(prompt, options = {}) {
  let lastError = null;
  for (let attempt = 1; attempt <= OLLAMA_MAX_RETRIES; attempt += 1) {
    try {
      return await callOpenAICompatOnce(prompt, options);
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

async function callLlm(prompt, options = {}) {
  if (LLM_PROVIDER === 'openai_compat') {
    return callOpenAICompat(prompt, options);
  }
  return callOllama(prompt, options);
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

function parseJsonCandidate(text, fallback = null) {
  const cleaned = stripThinkingBlocks(text);
  const fenced = cleaned.match(/```json\s*([\s\S]*?)```/i);
  const rawCandidate = (fenced ? fenced[1] : cleaned || '').trim();
  const candidate = extractLikelyJsonObject(rawCandidate) || rawCandidate;
  try {
    const parsed = JSON.parse(candidate);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

/**
 * Universal Dumb Runner: executes pre-assembled prompt received from Hub.
 * The worker is a pure inference relay with zero client-side prompt stitching or schema dicts.
 */
async function executeTask(task) {
  const taskId = task?.id;
  const userPrompt = String(
    task?.prompt ||
    task?.result_json?.prompt ||
    ''
  ).trim();

  const systemPrompt = String(
    task?.system_prompt ||
    task?.result_json?.system_prompt ||
    OPENAI_COMPAT_JSON_SYSTEM_PROMPT
  ).trim();

  if (!userPrompt) {
    warn(`task ${taskId} has no prompt payload; skipping`);
    return {
      worker_notice: 'No prompt payload found in task',
      task_type: task?.task_type,
      completed_at: new Date().toISOString(),
    };
  }

  const modelText = await callLlm(userPrompt, { systemPrompt });
  let parsed = parseJsonCandidate(modelText, null);

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    // Fallback: wrap raw text in summary so Hub's resilient normalizer handles it
    parsed = { summary: String(modelText || '').trim().slice(0, 4000) };
  }

  // Backward compat: pass turn_input if provided
  const turnInput = task?.turn_input || task?.result_json?.turn_input;
  if (turnInput && typeof turnInput === 'object' && !parsed.turn_input) {
    parsed.turn_input = turnInput;
  }

  return parsed;
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

async function heartbeat() {
  const payload = {
    device_id: WORKER_DEVICE_ID,
    hardware_fingerprint: WORKER_HARDWARE_FINGERPRINT,
  };
  if (WORKER_QVNC_ADDRESS) payload.qvnc_address = WORKER_QVNC_ADDRESS;
  if (WORKER_KEYPAIR?.publicKeyHex) payload.worker_pubkey = WORKER_KEYPAIR.publicKeyHex;
  if (WORKER_COUNTRY_CODE) payload.country_code = WORKER_COUNTRY_CODE;
  if (WORKER_COUNTRY_NAME) payload.country_name = WORKER_COUNTRY_NAME;
  if (WORKER_REGION_NAME) payload.region_name = WORKER_REGION_NAME;
  if (WORKER_COUNTRY_CODE || WORKER_COUNTRY_NAME || WORKER_REGION_NAME) {
    payload.geo_source = 'self_reported';
  }
  payload.compute_ready = !runtimePolicyBlocked && Boolean(runtimeAttestation);
  if (!payload.compute_ready) {
    payload.reason = runtimePolicyBlockReason || (runtimeAttestation ? 'Runtime policy blocked' : 'LM Studio or Ollama offline / models not loaded');
    payload.runtime = runtimeAttestation || null;
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
  const previousAttestation = runtimeAttestation;
  const fetchedPolicy = await fetchHubRuntimePolicy(apiCall);
  runtimePolicyFetchedAt = Date.now();

  if (!fetchedPolicy) {
    if (previousPolicy?.enabled && previousPolicy.mode !== 'off') {
      runtimePolicy = previousPolicy;
      if (previousAttestation && !hubRuntimeAttestationRejected) {
        runtimeAttestation = previousAttestation;
        runtimePolicyBlocked = false;
        runtimePolicyBlockReason = '';
        warn('Transient network glitch fetching Hub runtime policy; using cached policy and attestation');
        return true;
      }
      runtimePolicyBlocked = true;
      runtimePolicyBlockReason = 'Runtime blocked: could not fetch Hub runtime policy';
      warn(runtimePolicyBlockReason);
      return false;
    }
    runtimePolicy = null;
    runtimePolicyBlocked = false;
    runtimePolicyBlockReason = hubRuntimeAttestationRejected
      ? 'Runtime blocked: hub rejected runtime attestation'
      : '';
    runtimeAttestation = null;
    return !runtimePolicyBlocked;
  }

  runtimePolicy = fetchedPolicy;

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
    device_id: WORKER_DEVICE_ID,
    hardware_fingerprint: WORKER_HARDWARE_FINGERPRINT,
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
  if (reward?.amount != null && String(reward.amount).trim() !== '') {
    return `task completed: ${taskId} (${rewardAmount} ${asset})`;
  }
  return `task completed: ${taskId}`;
}

async function completeTask(taskId, taskType, claimNonce, resultJson) {
  if (!claimNonce) {
    throw new Error('Missing claim nonce for secure submit');
  }

  const submitIdempotencyKey = makeIdempotencyKey();
  const submitTimestamp = Math.floor(Date.now() / 1000);
  const submitSignature = buildSubmitSignature(NODE_TOKEN, taskId, claimNonce, submitTimestamp, resultJson);

  if (!hasRuntimeAttestation() && runtimePolicy) {
    try {
      const verification = await verifyLocalRuntimeAgainstPolicy({
        policy: runtimePolicy,
        llmProvider: LLM_PROVIDER,
        baseUrl: normalizeOpenAICompatBaseUrl(OPENAI_COMPAT_BASE_URL),
        apiKey: OPENAI_COMPAT_API_KEY,
      });
      if (!verification.blocked && (verification.attestation || buildRuntimeAttestation(runtimePolicy))) {
        runtimeAttestation = verification.attestation || buildRuntimeAttestation(runtimePolicy);
      }
    } catch (err) {
      warn(`Recovery verification failed before submit: ${err?.message || err}`);
    }
  }

  if (runtimePolicyEnforced() && !hasRuntimeAttestation()) {
    warn(`Aborting task completion submit for ${taskId}: runtime attestation is missing, avoiding policy mismatch penalty`);
    throw new Error('runtime_attestation_missing_on_complete');
  }

  const res = await apiCall('POST', `/api/ai/nodes/tasks/${encodeURIComponent(taskId)}/complete`, {
    result_json: resultJson,
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

  const controlSuffix = task.is_control_task ? ' [control]' : '';
  log(`task claimed: ${taskId} (${task.task_type || 'generic'})${controlSuffix}`);

  let lastError = null;

  for (let attempt = 1; attempt <= TASK_EXECUTION_MAX_RETRIES; attempt += 1) {
    try {
      if (runtimePolicy?.enabled && runtimePolicy.mode !== 'off') {
        const policyStale = !runtimePolicyFetchedAt || (Date.now() - runtimePolicyFetchedAt >= RUNTIME_POLICY_REFRESH_MS);
        if (policyStale || !hasRuntimeAttestation()) {
          const runtimeOk = await refreshRuntimePolicyState();
          if (!runtimeOk || runtimePolicyBlocked) {
            const message = runtimePolicyBlockReason || 'runtime policy mismatch';
            warn(`task failed: ${taskId} -> ${message}`);
            await failTask(taskId, message);
            return;
          }
        }
      }

      const resultJson = await executeTask(task);
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
  log('runner_mode=generic_dumb_runner');
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
