import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const OPENAI_COMPAT_EMBED_MODEL = String(
  process.env.AI_WORKER_REQUIRED_EMBEDDING_MODEL || 'text-embedding-nomic-embed-text-v2-moe'
).trim();

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ALIAS_CATALOG_PATH = path.join(__dirname, 'aiWorkerModelAliases.json');
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

export function normalizeModelVariant(value) {
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

export async function fetchHubRuntimePolicy(apiCall) {
  const res = await apiCall('GET', '/api/ai/worker/runtime-policy');
  if (!res.ok) return null;
  return res.data?.data || null;
}

export async function probeOllamaModelDetails(ollamaBaseUrl, modelName) {
  try {
    const url = `${String(ollamaBaseUrl || 'http://localhost:11434').replace(/\/+$/, '')}/api/show`;
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
    });
    if (!res.ok) return null;
    const data = await res.json();
    let numCtx = null;
    const params = String(data?.parameters || '');
    const paramMatch = params.match(/num_ctx\s+(\d+)/i);
    if (paramMatch) {
      numCtx = Number(paramMatch[1]);
    } else if (data?.model_info && typeof data.model_info === 'object') {
      for (const [key, val] of Object.entries(data.model_info)) {
        if (key.endsWith('.context_length') || key === 'context_length') {
          numCtx = Number(val);
          break;
        }
      }
    }
    return {
      parameter_size: data?.details?.parameter_size || null,
      quantization_level: data?.details?.quantization_level || null,
      family: data?.details?.family || null,
      format: data?.details?.format || null,
      num_ctx: Number.isFinite(numCtx) && numCtx > 0 ? numCtx : null,
    };
  } catch {
    return null;
  }
}

export function isApprovedGenerationModel(policy, modelId) {
  if (!modelId || !String(modelId).trim()) return false;
  if (!policy) return false;
  const m = String(modelId).trim();
  const req = String(policy.generation_model || '').trim();
  if (req && modelsMatchByPolicy(req, m)) return true;
  const allowed = Array.isArray(policy.allowed_generation_models) ? policy.allowed_generation_models : [];
  for (const candidate of allowed) {
    const candStr = String(candidate || '').trim();
    if (candStr && modelsMatchByPolicy(candStr, m)) return true;
  }
  return false;
}

export function extractHardwareTier(policy) {
  const val = Number(policy?.hardware_tier || policy?.tier || 1);
  return Number.isFinite(val) && val > 0 ? val : 1;
}

export function buildRuntimeAttestation(policy, detected = {}) {
  if (!policy) return null;
  const detectedGen = String(
    detected.detected_generation_model || detected.generation_model || ''
  ).trim();
  const detectedEmbed = String(
    detected.detected_embedding_model || detected.embedding_model || ''
  ).trim();
  const attestation = {
    provider: policy.provider,
    generation_model: detectedGen || policy.generation_model,
    embedding_model: detectedEmbed || policy.embedding_model,
    runtime_policy_version: policy.runtime_policy_version,
  };
  if (detectedGen) attestation.detected_generation_model = detectedGen;
  if (detectedEmbed) attestation.detected_embedding_model = detectedEmbed;
  if (detected.detected_parameter_size) attestation.detected_parameter_size = String(detected.detected_parameter_size).trim();
  if (detected.model_file_size_bytes) attestation.model_file_size_bytes = Number(detected.model_file_size_bytes);
  const rawCtx = Number(detected.max_context_tokens || detected.num_ctx || 0);
  if (Number.isFinite(rawCtx) && rawCtx > 0) {
    attestation.max_context_tokens = Math.max(512, Math.min(131072, Math.floor(rawCtx)));
  }
  const tier = extractHardwareTier(policy);
  if (tier > 1) {
    attestation.hardware_tier = tier;
  }
  return attestation;
}

const cachedLmStudioContextsByUrl = new Map();
const LM_STUDIO_CONTEXT_CACHE_TTL_MS = 15000;

export function clearLmStudioModelContextsCache() {
  cachedLmStudioContextsByUrl.clear();
}

export async function fetchLmStudioModelContexts(baseUrl, apiKey = '', { bypassCache = false } = {}) {
  const apiBase = String(baseUrl || '').trim().replace(/\/+$/, '').replace(/\/v\d+$/i, '');
  const now = Date.now();
  const cached = cachedLmStudioContextsByUrl.get(apiBase);
  if (!bypassCache && cached && (now - cached.ts < LM_STUDIO_CONTEXT_CACHE_TTL_MS)) {
    return cached.result;
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const headers = { Accept: 'application/json' };
    if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
    const res = await fetch(`${apiBase}/api/v0/models`, { headers, signal: controller.signal });
    if (!res.ok) return { supported: false, modelContextLengths: {} };
    const payload = await res.json().catch(() => null);
    const models = Array.isArray(payload?.data) ? payload.data : [];
    const modelContextLengths = {};
    for (const m of models) {
      const id = String(m?.id || '').trim();
      if (!id) continue;
      // L-2: If loaded_context_length <= 0 or missing, fallback to safe default 8192 tokens.
      // A context value of 0 is never emitted to attestation.
      let ctx = Number(m?.loaded_context_length || m?.max_context_length || 0);
      if (!Number.isFinite(ctx) || ctx <= 0) ctx = 8192;
      modelContextLengths[id] = Math.max(512, Math.min(131072, Math.floor(ctx)));
    }
    const result = { supported: true, modelContextLengths };
    cachedLmStudioContextsByUrl.set(apiBase, { result, ts: now });
    return result;
  } catch {
    return { supported: false, modelContextLengths: {} };
  } finally {
    clearTimeout(timeout);
  }
}

export async function fetchOpenAICompatModelIds(baseUrl, apiKey = '') {
  const normalized = String(baseUrl || '').trim().replace(/\/+$/, '');
  if (!normalized) return [];
  const url = `${normalized}/models`;
  const headers = { Accept: 'application/json' };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(url, { headers });
  if (!res.ok) {
    throw new Error(`OpenAI-compatible models request failed (${res.status})`);
  }
  const payload = await res.json();
  return (payload?.data || [])
    .map((entry) => String(entry?.id || '').trim())
    .filter(Boolean);
}

export function resolveListedModelId(canonicalId, availableIds) {
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

export function exactModelListed(modelId, availableIds) {
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

export function formatRuntimeMismatchLabels(codes) {
  return (Array.isArray(codes) ? codes : [])
    .map((code) => RUNTIME_MISMATCH_LABELS[String(code || '').trim()] || String(code || '').trim())
    .filter(Boolean);
}

export async function verifyLocalRuntimeAgainstPolicy({
  policy,
  llmProvider,
  baseUrl,
  apiKey,
  preferredModel,
}) {
  if (!policy?.enabled || policy.mode === 'off') {
    return { ok: true, blocked: false, attestation: buildRuntimeAttestation(policy) };
  }

  const hardwareTier = extractHardwareTier(policy);

  if (String(llmProvider || '').trim().toLowerCase() !== String(policy.provider || '').trim().toLowerCase()) {
    return {
      ok: false,
      blocked: true,
      reason: `Runtime blocked: provider must be ${policy.provider}`,
      missingGeneration: true,
      missingEmbedding: true,
      hardware_tier: hardwareTier,
      runtimePolicyMismatches: [{
        kind: 'provider',
        message: `Provider must be ${policy.provider}`,
        required: policy.provider,
      }],
    };
  }

  let available = [];
  let modelContexts = {};
  try {
    if (policy.provider === 'openai_compat') {
      const [models, ctxResult] = await Promise.all([
        fetchOpenAICompatModelIds(baseUrl, apiKey),
        fetchLmStudioModelContexts(baseUrl, apiKey).catch(() => ({ supported: false, modelContextLengths: {} })),
      ]);
      available = models;
      modelContexts = ctxResult?.modelContextLengths || {};
    }
  } catch (error) {
    return {
      ok: false,
      blocked: true,
      reason: `Runtime blocked: could not list models (${error?.message || String(error)})`,
      missingGeneration: true,
      missingEmbedding: true,
      hardware_tier: hardwareTier,
      runtimePolicyMismatches: [{
        kind: 'offline',
        message: `Could not list models (${error?.message || String(error)})`,
      }],
    };
  }

  // Pure Dumb Runner & Tier Parity:
  // 1. If preferredModel is provided and approved by policy, check if available
  let detectedGenerationModel = null;
  const preferred = String(preferredModel || '').trim();
  if (preferred && isApprovedGenerationModel(policy, preferred)) {
    detectedGenerationModel = resolveListedModelId(preferred, available);
  }

  // 2. If not detected via preferred, check baseline generation_model
  if (!detectedGenerationModel && policy.generation_model) {
    detectedGenerationModel = resolveListedModelId(policy.generation_model, available);
  }

  // 3. If still not detected, check any allowed model from policy.allowed_generation_models
  if (!detectedGenerationModel && Array.isArray(policy.allowed_generation_models)) {
    for (const candidate of policy.allowed_generation_models) {
      const candStr = String(candidate || '').trim();
      if (!candStr) continue;
      const resolved = resolveListedModelId(candStr, available);
      if (resolved) {
        detectedGenerationModel = resolved;
        break;
      }
    }
  }

  const detectedEmbeddingModel = resolveListedModelId(policy.embedding_model, available);
  const generationOk = Boolean(detectedGenerationModel);
  const embeddingOk = Boolean(detectedEmbeddingModel);
  if (!generationOk || !embeddingOk) {
    const mismatches = [];
    if (!generationOk) {
      const targetModel = preferred && isApprovedGenerationModel(policy, preferred)
        ? preferred
        : policy.generation_model;
      mismatches.push({
        kind: 'generation',
        message: `Load generation model ${targetModel} in LM Studio`,
        required: targetModel,
      });
    }
    if (!embeddingOk) {
      mismatches.push({
        kind: 'embedding',
        message: `Load embedding model ${policy.embedding_model} in LM Studio`,
        required: policy.embedding_model,
      });
    }
    const parts = mismatches.map((item) => item.message);
    return {
      ok: false,
      blocked: true,
      reason: `Runtime blocked: ${parts.join('; ')}`,
      missingGeneration: !generationOk,
      missingEmbedding: !embeddingOk,
      hardware_tier: hardwareTier,
      availableModels: available,
      runtimePolicyMismatches: mismatches,
    };
  }

  let activeContext = 8192;
  if (detectedGenerationModel && modelContexts[detectedGenerationModel]) {
    activeContext = modelContexts[detectedGenerationModel];
  }

  return {
    ok: true,
    blocked: false,
    hardware_tier: hardwareTier,
    attestation: buildRuntimeAttestation(policy, {
      detected_generation_model: detectedGenerationModel,
      detected_embedding_model: detectedEmbeddingModel,
      max_context_tokens: activeContext,
    }),
    availableModels: available,
    detected_generation_model: detectedGenerationModel,
    detected_embedding_model: detectedEmbeddingModel,
    max_context_tokens: activeContext,
    modelContextLengths: modelContexts,
  };
}

export function resolveRequiredEmbeddingModel(policy) {
  return String(policy?.embedding_model || OPENAI_COMPAT_EMBED_MODEL).trim();
}
