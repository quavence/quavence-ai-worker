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
    return {
      parameter_size: data?.details?.parameter_size || null,
      quantization_level: data?.details?.quantization_level || null,
      family: data?.details?.family || null,
      format: data?.details?.format || null,
    };
  } catch {
    return null;
  }
}

export function buildRuntimeAttestation(policy, detected = {}) {
  if (!policy) return null;
  const attestation = {
    provider: policy.provider,
    generation_model: policy.generation_model,
    embedding_model: policy.embedding_model,
    runtime_policy_version: policy.runtime_policy_version,
  };
  const detectedGen = String(
    detected.detected_generation_model || detected.generation_model || ''
  ).trim();
  const detectedEmbed = String(
    detected.detected_embedding_model || detected.embedding_model || ''
  ).trim();
  if (detectedGen) attestation.detected_generation_model = detectedGen;
  if (detectedEmbed) attestation.detected_embedding_model = detectedEmbed;
  if (detected.detected_parameter_size) attestation.detected_parameter_size = String(detected.detected_parameter_size).trim();
  if (detected.model_file_size_bytes) attestation.model_file_size_bytes = Number(detected.model_file_size_bytes);
  return attestation;
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
}) {
  if (!policy?.enabled || policy.mode === 'off') {
    return { ok: true, blocked: false, attestation: buildRuntimeAttestation(policy) };
  }

  if (String(llmProvider || '').trim().toLowerCase() !== String(policy.provider || '').trim().toLowerCase()) {
    return {
      ok: false,
      blocked: true,
      reason: `Runtime blocked: provider must be ${policy.provider}`,
      missingGeneration: true,
      missingEmbedding: true,
      runtimePolicyMismatches: [{
        kind: 'provider',
        message: `Provider must be ${policy.provider}`,
        required: policy.provider,
      }],
    };
  }

  let available = [];
  try {
    if (policy.provider === 'openai_compat') {
      available = await fetchOpenAICompatModelIds(baseUrl, apiKey);
    }
  } catch (error) {
    return {
      ok: false,
      blocked: true,
      reason: `Runtime blocked: could not list models (${error?.message || String(error)})`,
      missingGeneration: true,
      missingEmbedding: true,
      runtimePolicyMismatches: [{
        kind: 'offline',
        message: `Could not list models (${error?.message || String(error)})`,
      }],
    };
  }

  const detectedGenerationModel = resolveListedModelId(policy.generation_model, available);
  const detectedEmbeddingModel = resolveListedModelId(policy.embedding_model, available);
  const generationOk = Boolean(detectedGenerationModel);
  const embeddingOk = Boolean(detectedEmbeddingModel);
  if (!generationOk || !embeddingOk) {
    const mismatches = [];
    if (!generationOk) {
      mismatches.push({
        kind: 'generation',
        message: `Load generation model ${policy.generation_model} in LM Studio`,
        required: policy.generation_model,
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
      availableModels: available,
      runtimePolicyMismatches: mismatches,
    };
  }

  return {
    ok: true,
    blocked: false,
    attestation: buildRuntimeAttestation(policy, {
      detected_generation_model: detectedGenerationModel,
      detected_embedding_model: detectedEmbeddingModel,
    }),
    availableModels: available,
    detected_generation_model: detectedGenerationModel,
    detected_embedding_model: detectedEmbeddingModel,
  };
}

export function resolveRequiredEmbeddingModel(policy) {
  return String(policy?.embedding_model || OPENAI_COMPAT_EMBED_MODEL).trim();
}
