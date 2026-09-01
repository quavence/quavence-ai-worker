const fs = require('fs');
const path = require('path');

const DEFAULT_API_URL = 'https://quavence.com';
const HUB_REQUEST_TIMEOUT_MS = Number(process.env.AI_WORKER_HUB_TIMEOUT_MS || 25000);
const HUB_REQUEST_MAX_RETRIES = Number(process.env.AI_WORKER_HUB_REQUEST_RETRIES || 3);
const HUB_REQUEST_RETRY_DELAY_MS = Number(process.env.AI_WORKER_HUB_RETRY_DELAY_MS || 900);

const ALIAS_CATALOG_PATH = path.join(__dirname, '../agent/aiWorkerModelAliases.json');
const ALIAS_LOOKUP = buildAliasLookup(loadAliasCatalog());

function loadAliasCatalog() {
  try {
    return JSON.parse(fs.readFileSync(ALIAS_CATALOG_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function buildAliasLookup(catalog) {
  const lookup = new Map();
  for (const [canonical, aliases] of Object.entries(catalog || {})) {
    const canonicalKey = normalizeModelKey(canonical);
    if (!canonicalKey) continue;
    const set = lookup.get(canonicalKey) || new Set();
    set.add(canonicalKey);
    for (const alias of aliases || []) {
      const aliasKey = normalizeModelKey(alias);
      if (aliasKey) set.add(aliasKey);
    }
    lookup.set(canonicalKey, set);
  }
  return lookup;
}

function normalizeModelKey(value) {
  return String(value || '').trim().toLowerCase();
}

function getModelAliasSet(canonicalId) {
  const key = normalizeModelKey(canonicalId);
  if (!key) return new Set();
  return new Set(ALIAS_LOOKUP.get(key) || [key]);
}

// Keep in sync with src/config/aiWorkerModelAliases.js
const VARIANT_SUFFIX_PATTERNS = [
  /[-.](?:gguf|mlx|safetensors|bin)$/,
  /[-:](?:instruct|it|chat|latest)$/,
  /-(?:q\d+(?:[._][a-z0-9]+)*|iq\d+[a-z0-9_]*|f16|f32|bf16|int4|int8|4bit|8bit)$/,
];

function normalizeModelVariant(value) {
  let key = normalizeModelKey(value);
  if (!key) return '';
  key = key.replace(/^[a-z0-9._-]+\//, '');
  key = key.split('@')[0];

  let changed = true;
  while (changed) {
    changed = false;
    for (const pattern of VARIANT_SUFFIX_PATTERNS) {
      const next = key.replace(pattern, '');
      if (next !== key) {
        key = next;
        changed = true;
      }
    }
  }

  return key;
}

function modelsMatchByPolicy(required, provided, { allowAliases = true } = {}) {
  const req = String(required || '').trim();
  const got = String(provided || '').trim();
  if (!req || !got) return false;
  if (req === got) return true;
  if (!allowAliases) return false;
  const reqKey = normalizeModelKey(req);
  const gotKey = normalizeModelKey(got);
  if (reqKey === gotKey) return true;
  const aliasSet = getModelAliasSet(req);
  if (aliasSet.has(gotKey)) return true;
  const gotVariant = normalizeModelVariant(got);
  if (!gotVariant) return false;
  for (const alias of aliasSet) {
    if (normalizeModelVariant(alias) === gotVariant) return true;
  }
  return false;
}

function normalizeApiUrl(apiUrl) {
  const value = String(apiUrl || DEFAULT_API_URL).trim();
  return value.replace(/\/+$/, '');
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchHubRuntimePolicy(apiUrl = DEFAULT_API_URL) {
  const base = normalizeApiUrl(apiUrl);
  let lastError = null;

  for (let attempt = 1; attempt <= Math.max(1, HUB_REQUEST_MAX_RETRIES); attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), HUB_REQUEST_TIMEOUT_MS);
    try {
      const res = await fetch(`${base}/api/ai/worker/runtime-policy`, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if (!res.ok) return null;
      const payload = await res.json().catch(() => ({}));
      return payload?.data || null;
    } catch (error) {
      lastError = error;
      if (attempt >= HUB_REQUEST_MAX_RETRIES) {
        return null;
      }
      await sleep(HUB_REQUEST_RETRY_DELAY_MS * attempt);
    } finally {
      clearTimeout(timeout);
    }
  }

  if (lastError) {
    return null;
  }
  return null;
}

function applyPolicyToConfig(config, policy) {
  const next = { ...(config || {}) };
  if (!policy?.enabled || policy.mode === 'off') {
    return next;
  }
  next.llmProvider = policy.provider;
  next.genModel = policy.generation_model;
  next.model = policy.generation_model;
  next.embedModel = policy.embedding_model;
  return next;
}

function resolveListedModelId(canonicalId, availableIds) {
  const req = String(canonicalId || '').trim();
  if (!req) return null;
  const ids = Array.isArray(availableIds) ? availableIds : [];
  const exact = ids.find((id) => String(id || '').trim() === req);
  if (exact) return String(exact).trim();
  for (const id of ids) {
    const candidate = String(id || '').trim();
    if (!candidate) continue;
    if (modelsMatchByPolicy(req, candidate)) return candidate;
  }
  return null;
}

function exactModelListed(modelId, availableIds) {
  return Boolean(resolveListedModelId(modelId, availableIds));
}

const RUNTIME_MISMATCH_LABELS = {
  provider_missing: 'Provider not reported',
  provider_mismatch: 'Provider does not match Hub policy',
  generation_model_missing: 'Generation model not reported',
  generation_model_mismatch: 'Generation model does not match Hub policy',
  embedding_model_missing: 'Embedding model not reported',
  embedding_model_mismatch: 'Embedding model does not match Hub policy',
  policy_version_mismatch: 'Runtime policy version is outdated — restart worker after Hub update',
  detected_generation_model_missing: 'LM Studio generation model id not reported',
  detected_generation_model_mismatch: 'LM Studio generation model does not match Hub policy',
  detected_embedding_model_missing: 'LM Studio embedding model id not reported',
  detected_embedding_model_mismatch: 'LM Studio embedding model does not match Hub policy',
  detected_generation_model_changed_since_claim: 'LM Studio generation model changed since claim',
  detected_embedding_model_changed_since_claim: 'LM Studio embedding model changed since claim',
};

function formatRuntimeMismatchLabels(codes) {
  return (Array.isArray(codes) ? codes : [])
    .map((code) => RUNTIME_MISMATCH_LABELS[String(code || '').trim()] || String(code || '').trim())
    .filter(Boolean);
}

function buildRuntimePolicyIssues(policy, { provider, generationOk, embeddingOk, reachable, availableIds } = {}) {
  if (!policy?.enabled || policy.mode === 'off') return [];
  const issues = [];
  if (String(provider || '').trim().toLowerCase() !== String(policy.provider || '').trim().toLowerCase()) {
    issues.push({
      kind: 'provider',
      message: `Provider must be ${policy.provider}`,
      required: policy.provider,
    });
  }
  if (!reachable) {
    issues.push({
      kind: 'offline',
      message: 'Local LM Studio / OpenAI-compatible endpoint is offline',
    });
  }
  if (!generationOk) {
    issues.push({
      kind: 'generation',
      message: `Load generation model ${policy.generation_model} in LM Studio`,
      required: policy.generation_model,
      detected: resolveListedModelId(policy.generation_model, availableIds),
    });
  }
  if (!embeddingOk) {
    issues.push({
      kind: 'embedding',
      message: `Load embedding model ${policy.embedding_model} in LM Studio`,
      required: policy.embedding_model,
      detected: resolveListedModelId(policy.embedding_model, availableIds),
    });
  }
  return issues;
}

function buildRuntimePolicyBlockReason(policy, ctx = {}) {
  const issues = buildRuntimePolicyIssues(policy, ctx);
  if (!issues.length) return '';
  return `Runtime blocked: ${issues.map((item) => item.message).join('; ')}`;
}

function isPolicyEnforced(policy) {
  return Boolean(policy?.enabled && policy.mode !== 'off');
}

module.exports = {
  DEFAULT_API_URL,
  normalizeApiUrl,
  fetchHubRuntimePolicy,
  applyPolicyToConfig,
  exactModelListed,
  resolveListedModelId,
  buildRuntimePolicyIssues,
  buildRuntimePolicyBlockReason,
  formatRuntimeMismatchLabels,
  isPolicyEnforced,
};
