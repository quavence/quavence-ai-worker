const electron = require('electron');
const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  Notification,
  shell,
} = typeof electron === 'object' && electron !== null ? electron : {};
const { mergeLifecycleDefaults, createAppLifecycleManager } = require('./appLifecycle.cjs');
const { isAllowedExternalUrl } = require('./externalUrlAllowlist.cjs');
const { createWorkerStartGate } = require('./workerStartGate.cjs');
const {
  fetchHubRuntimePolicy,
  applyPolicyToConfig,
  isApprovedGenerationModel,
  extractHardwareTier,
  exactModelListed,
  resolveListedModelId,
  buildRuntimePolicyIssues,
  buildRuntimePolicyBlockReason,
  isPolicyEnforced,
} = require('./runtimePolicyShared.cjs');
const {
  HUB_REQUEST_TIMEOUT_MS,
  requestJsonWithRetry,
} = require('./hubRequestShared.cjs');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const crypto = require('crypto');
const { Readable } = require('stream');
const http = require('http');
const https = require('https');
const KEYCHAIN_SERVICE = 'QUAVENCE_AI_WORKER_DESKTOP';
const KEYCHAIN_ACCOUNT = 'worker_node_token';

// Desktop worker talks to Quavence Hub backend and a local LLM (Ollama or OpenAI-compatible e.g. LM Studio).
// Local corporate/dev proxies can cause Electron fetch to timeout on startup.
for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'http_proxy', 'https_proxy', 'ALL_PROXY', 'all_proxy']) {
  process.env[key] = '';
}
process.env.NO_PROXY = [process.env.NO_PROXY, 'localhost,127.0.0.1,::1,quavence.com']
  .filter(Boolean)
  .join(',');

// Reduce noisy Chromium SSL handshake logs in desktop console.
if (app?.commandLine) {
  app.commandLine.appendSwitch('log-level', '3');
  app.commandLine.appendSwitch('disable-logging');
}

let mainWindow = null;
let lifecycle = null;
let workerProcess = null;
let requestWorkerStart = null;
let sessionNodeToken = '';
let workerState = {
  running: false,
  pid: null,
  startedAt: null
};

let runtimePolicyCache = { apiUrl: null, policy: null, fetchedAt: 0 };
const RUNTIME_POLICY_CACHE_MS = 60000;

async function getCachedRuntimePolicy(apiUrl) {
  const normalized = normalizeApiUrl(apiUrl);
  const now = Date.now();
  if (
    runtimePolicyCache.apiUrl === normalized
    && now - runtimePolicyCache.fetchedAt < RUNTIME_POLICY_CACHE_MS
  ) {
    return runtimePolicyCache.policy;
  }
  const policy = await fetchHubRuntimePolicy(normalized);
  runtimePolicyCache = { apiUrl: normalized, policy, fetchedAt: now };
  return policy;
}

function invalidateRuntimePolicyCache() {
  runtimePolicyCache = { apiUrl: null, policy: null, fetchedAt: 0 };
}

const DEFAULT_API_URL = 'https://quavence.com';
const DEFAULT_GEN_MODEL = 'phi3:latest';
const DEFAULT_OPENAI_GEN_MODEL = 'qwen/qwen3-vl-8b';
const DEFAULT_EMBED_MODEL = 'nomic-embed-text';
/** Default when provider is LM Studio / OpenAI-compat and config has no embed id */
const DEFAULT_OPENAI_COMPAT_EMBED_MODEL = 'text-embedding-nomic-embed-text-v2-moe';
const DEFAULT_LLM_PROVIDER = 'ollama';
const DEFAULT_OPENAI_COMPAT_URL = 'http://localhost:1234/v1';
const DEFAULT_OPENAI_COMPAT_ROLE_MODE = 'auto';

const SUPPORTED_GEN_MODEL_ALIASES = new Map([
  ['phi3:latest', new Set([
    'phi3:latest',
    'phi3',
    'microsoft/phi-3-mini-4k-instruct-gguf',
    'phi-3-mini-4k-instruct-gguf'
  ])],
  ['mistral-7b-instruct-v0.3', new Set([
    'mistral-7b-instruct-v0.3',
    'mistral:7b-instruct-v0.3',
    'mistralai/mistral-7b-instruct-v0.3',
    'mistralai/mistral-7b-instruct-v0.3-gguf',
    'mistral-7b-instruct-v0.3-gguf',
    'thebloke/mistral-7b-instruct-v0.3-gguf',
    'mistralai/mistral-7b-instruct-v0.3-q4_k_m',
    'mistral-7b-instruct-v0.3-q4_k_m'
  ])],
  ['mistral:latest', new Set([
    'mistral:latest',
    'mistral',
    'mistral-7b-instruct',
    'mistral-7b-instruct-v0.2',
    'mistralai/mistral-7b-instruct-v0.2',
    'mistralai/mistral-7b-instruct-v0.2-gguf',
    'mistral-7b-instruct-v0.2-gguf',
    'mistralai/mistral-7b-instruct-v0.1',
    'openhermes-2.5-mistral-7b',
    'openhermes2.5-mistral-7b',
    'thebloke/mistral-7b-instruct-v0.2-gguf',
    'thebloke/mistral-7b-instruct-v0.1-gguf'
  ])],
  ['qwen2.5-7b-instruct', new Set([
    'qwen2.5-7b-instruct',
    'qwen2.5-7b-instruct-gguf',
    'qwen/qwen2.5-7b-instruct',
    'qwen/qwen2.5-7b-instruct-gguf',
    'qwen2.5:7b-instruct',
    'qwen2.5:7b'
  ])],
  ['qwen/qwen3-vl-8b', new Set([
    'qwen/qwen3-vl-8b',
    'qwen3-vl-8b',
    'qwen/qwen3-8b',
    'qwen3-8b',
    'qwen/qwen3-vl-8b-instruct',
  ])],
  ['qwen2.5-coder-7b-instruct', new Set([
    'qwen2.5-coder-7b-instruct',
    'qwen2.5-coder-7b-instruct-gguf',
    'qwen/qwen2.5-coder-7b-instruct',
    'qwen/qwen2.5-coder-7b-instruct-gguf'
  ])]
]);

function normalizeModelName(value) {
  return String(value || '').trim().toLowerCase();
}

function getAllowedGenModelsForProvider(provider, policy = null) {
  if (policy && isPolicyEnforced(policy)) {
    const list = [
      policy.generation_model,
      ...(Array.isArray(policy.allowed_generation_models) ? policy.allowed_generation_models : [])
    ].filter(Boolean);
    return new Set(list);
  }
  return new Set();
}

function normalizeGenModelForProvider(provider, value) {
  const normalized = normalizeModelName(value);
  if (!normalized) {
    return provider === 'openai_compat' ? DEFAULT_OPENAI_GEN_MODEL : DEFAULT_GEN_MODEL;
  }

  for (const [canonical, aliases] of SUPPORTED_GEN_MODEL_ALIASES.entries()) {
    if (aliases.has(normalized)) return canonical;
  }

  return normalized;
}

function isSupportedGenModelForProvider(provider, value, policy = null) {
  if (!value || !String(value).trim()) return false;
  if (policy && isPolicyEnforced(policy)) {
    return isApprovedGenerationModel(policy, value);
  }
  return true;
}

function mapSupportedModelFromAvailable(availableModels, preferredValue, provider = 'openai_compat', policy = null) {
  const normalizedPreferred = normalizeModelName(preferredValue);
  const normalizedAvailable = Array.isArray(availableModels)
    ? availableModels.map((item) => String(item || '').trim()).filter(Boolean)
    : [];

  const isApproved = (candidate) => {
    if (!candidate || !String(candidate).trim()) return false;
    if (policy && isPolicyEnforced(policy)) {
      return isApprovedGenerationModel(policy, candidate);
    }
    return true;
  };

  // Prefer exact user-selected model if it is available and supported by policy.
  if (normalizedPreferred) {
    for (const candidate of normalizedAvailable) {
      if (normalizeModelName(candidate) === normalizedPreferred && isApproved(candidate)) {
        return { availableModel: candidate, canonicalModel: candidate };
      }
    }
  }

  // Otherwise find the first available model that is approved.
  for (const candidate of normalizedAvailable) {
    if (isApproved(candidate)) {
      return { availableModel: candidate, canonicalModel: candidate };
    }
  }

  return null;
}

function normalizeApiUrl(apiUrl) {
  const value = String(apiUrl || '').trim();
  if (!value) return DEFAULT_API_URL;

  const legacyLocalUrls = new Set([
    'http://localhost:3002',
    'http://localhost:3002/',
    'https://localhost:3002',
    'https://localhost:3002/',
    'http://127.0.0.1:3002',
    'http://127.0.0.1:3002/',
    'https://127.0.0.1:3002',
    'https://127.0.0.1:3002/'
  ]);

  if (legacyLocalUrls.has(value.toLowerCase())) {
    return DEFAULT_API_URL;
  }

  return value.replace(/\/+$/, '');
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

function migrateConfig(parsed = {}) {
  const provider = parsed?.llmProvider || DEFAULT_LLM_PROVIDER;
  const canonicalGenModel = normalizeGenModelForProvider(
    provider,
    parsed?.genModel || parsed?.model || (provider === 'openai_compat' ? DEFAULT_OPENAI_GEN_MODEL : DEFAULT_GEN_MODEL)
  );
  const normalizedLlmBaseUrl =
    provider === 'openai_compat'
      ? String(parsed?.llmBaseUrl || '').trim() || DEFAULT_OPENAI_COMPAT_URL
      : String(parsed?.llmBaseUrl || '').trim() || DEFAULT_OPENAI_COMPAT_URL;
  const embedKeyInFile = Object.prototype.hasOwnProperty.call(parsed, 'embedModel');
  const embedTrimmed = String(parsed?.embedModel ?? '').trim();
  const embedModelResolved = embedKeyInFile && embedTrimmed === ''
    ? ''
    : embedTrimmed || (provider === 'openai_compat' ? DEFAULT_OPENAI_COMPAT_EMBED_MODEL : DEFAULT_EMBED_MODEL);

  return mergeLifecycleDefaults({
    runtimeMode: 'managed',
    useStoredToken: false,
    llmProvider: provider,
    llmBaseUrl: normalizedLlmBaseUrl,
    llmApiKey: parsed?.llmApiKey || '',
    openAiCompatRoleMode: normalizeOpenAICompatRoleMode(parsed?.openAiCompatRoleMode),
    genModel: canonicalGenModel,
    embedModel: embedModelResolved,
    consents: {
      acceptLocalRuntime: false,
      acceptResourceUsage: false,
      acceptNetworkCalls: false
    },
    ...parsed,
    apiUrl: normalizeApiUrl(parsed?.apiUrl),
    llmProvider: provider,
    llmBaseUrl: normalizedLlmBaseUrl,
    llmApiKey: parsed?.llmApiKey || '',
    model: canonicalGenModel,
    genModel: canonicalGenModel,
    embedModel: embedModelResolved,
    qvncAddress: String(parsed?.qvncAddress || '').trim(),
    token: ''
  });
}

function getConfigPath() {
  return path.join(app.getPath('userData'), 'worker-config.json');
}

const os = require('os');

let cachedGpuTelemetry = null;

function detectLocalGpuHardware() {
  try {
    // 1. Primary: nvidia-smi with bounded 1500ms timeout
    const nvidiaOutput = execFileSync(
      'nvidia-smi',
      ['--query-gpu=name,memory.total,pci.bus_id', '--format=csv,noheader,nounits'],
      {
        timeout: 1500,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );

    const lines = String(nvidiaOutput || '')
      .split(/\r?\n/)
      .map(line => line.trim())
      .filter(Boolean);

    if (lines.length > 0) {
      let totalVram = 0;
      let primaryGpuName = '';
      let primaryPciBus = '';

      for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].split(',').map(p => p.trim());
        const name = parts[0] || 'NVIDIA GPU';
        const vram = parseInt(parts[1], 10) || 0;
        const pci = parts[2] || 'NONE';

        totalVram += vram;
        if (i === 0) {
          primaryGpuName = name;
          primaryPciBus = pci;
        }
      }

      if (totalVram > 0 && primaryPciBus && primaryPciBus !== 'NONE') {
        const gpuDisplayName = lines.length > 1 ? `${lines.length}x ${primaryGpuName}` : primaryGpuName;
        return {
          gpuName: gpuDisplayName,
          vramMb: totalVram,
          pciBusId: primaryPciBus,
        };
      }
    }
  } catch {
    // nvidia-smi unavailable or timed out, attempt OS-specific fallback
  }

  // 2. Secondary fallback for systems without nvidia-smi
  try {
    if (process.platform === 'win32') {
      const wmicOutput = execFileSync(
        'wmic',
        ['path', 'win32_VideoController', 'get', 'Name,AdapterRAM', '/format:csv'],
        {
          timeout: 1500,
          windowsHide: true,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      const rows = String(wmicOutput || '')
        .split(/\r?\n/)
        .map(r => r.trim())
        .filter(Boolean);

      for (const row of rows) {
        const parts = row.split(',').map(p => p.trim());
        if (parts.length >= 3 && parts[1] && parts[2]) {
          const name = parts[2];
          const rawBytes = parseInt(parts[1], 10);
          if (rawBytes > 0) {
            const vramMb = Math.round(rawBytes / (1024 * 1024));
            if (vramMb >= 4096) {
              return {
                gpuName: name,
                vramMb,
                pciBusId: '0000:01:00.0',
              };
            }
          }
        }
      }
    } else if (process.platform === 'linux') {
      const lspciOutput = execFileSync(
        'lspci',
        [],
        {
          timeout: 1500,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'ignore'],
        }
      );
      const vgaLine = String(lspciOutput || '')
        .split('\n')
        .find(l => /vga|3d controller/i.test(l));
      if (vgaLine) {
        const pciMatch = vgaLine.match(/^([0-9a-fA-F:.]+)\s+/);
        const pciBus = pciMatch ? pciMatch[1] : '0000:01:00.0';
        return {
          gpuName: vgaLine.slice(pciMatch ? pciMatch[0].length : 0).trim().slice(0, 128),
          vramMb: 0,
          pciBusId: pciBus,
        };
      }
    }
  } catch {
    // Secondary fallback failed
  }

  // Deterministic fallback for non-GPU / CPU-only machines
  return {
    gpuName: 'NONE',
    vramMb: 0,
    pciBusId: 'NONE',
  };
}

function getCachedGpuTelemetry() {
  if (!cachedGpuTelemetry) {
    cachedGpuTelemetry = detectLocalGpuHardware();
  }
  return cachedGpuTelemetry;
}

function buildHardwareFingerprint(gpuInfo = null) {
  const gpu = gpuInfo || getCachedGpuTelemetry();
  const foundMac = Object.values(os.networkInterfaces() || {})
    .flat()
    .find(iface => iface && !iface.internal && iface.mac && iface.mac !== '00:00:00:00:00:00')
    ?.mac || '';

  const components = [
    os.platform(),
    os.arch(),
    os.cpus()?.[0]?.model || 'unknown',
    String(os.totalmem()),
    foundMac || os.hostname() || 'quavence_node',
    String(gpu?.pciBusId || 'NONE'),
    String(gpu?.vramMb || 0),
    String(gpu?.gpuName || 'NONE'),
  ];

  return crypto
    .createHash('sha256')
    .update(components.join('|'))
    .digest('hex');
}

function readQtWorkerDeviceIdFromRegistry() {
  if (process.platform !== 'win32') return '';
  try {
    const stdout = execFileSync(
      'reg.exe',
      ['query', 'HKCU\\Software\\Quavence\\Quavence-Qt\\AIWorker', '/v', 'deviceId'],
      {
        timeout: 2000,
        windowsHide: true,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }
    );
    const match = stdout.match(/deviceId\s+REG_\w+\s+([^\r\n]+)/i);
    if (match && match[1]) {
      const val = match[1].trim();
      if (/^[0-9a-zA-Z_\-]{6,128}$/.test(val)) {
        return val;
      }
    }
  } catch {
    // quiet fallback on missing key or non-zero exit
  }
  return '';
}

function ensureWorkerDeviceId(config = {}) {
  // On Windows, if Quavence-Qt wallet is installed, always prioritize its deviceId
  // so that desktop worker and Qt wallet share the exact same ID and never conflict on Hub.
  const qtDeviceId = readQtWorkerDeviceIdFromRegistry();
  if (qtDeviceId) {
    return qtDeviceId;
  }

  const existing = String(config?.deviceId || '').trim();
  if (/^qt-worker-[0-9a-zA-Z_\-]{4,120}$/i.test(existing)) return existing;
  if (/^hw-[0-9a-f]{32}$/i.test(existing)) return existing;
  if (/^[0-9a-f-]{36}$/i.test(existing)) return existing;
  if (existing && /^[0-9a-zA-Z_\-]{6,128}$/.test(existing)) return existing;

  return `hw-${buildHardwareFingerprint()}`;
}


function getBundledRuntimeDir() {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, 'runtime');
  }
  return path.join(resolveRepoRoot(), 'worker_desktop', 'runtime');
}

function getRuntimeInstallDir() {
  return path.join(app.getPath('userData'), 'runtime');
}

function getKeytar() {
  try {
    return require('keytar');
  } catch {
    return null;
  }
}

async function getStoredToken() {
  const keytar = getKeytar();
  if (!keytar) return '';
  try {
    const token = await keytar.getPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
    return String(token || '').trim();
  } catch {
    return '';
  }
}

async function setStoredToken(token) {
  const keytar = getKeytar();
  if (!keytar) {
    return false;
  }
  try {
    await keytar.setPassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT, String(token || '').trim());
    return true;
  } catch {
    return false;
  }
}

async function clearStoredToken() {
  const keytar = getKeytar();
  if (!keytar) return false;
  try {
    return await keytar.deletePassword(KEYCHAIN_SERVICE, KEYCHAIN_ACCOUNT);
  } catch {
    return false;
  }
}

async function loadConfig() {
  const storedToken = await getStoredToken();
  const hasStoredToken = Boolean(storedToken);
  try {
    const file = fs.readFileSync(getConfigPath(), 'utf8');
    const parsed = JSON.parse(file);
    const migrated = migrateConfig(parsed);
    const deviceId = ensureWorkerDeviceId(migrated);
    if (deviceId !== migrated.deviceId) {
      migrated.deviceId = deviceId;
      await saveConfig({ ...migrated, token: storedToken || '' });
    }
    return {
      ...migrated,
      deviceId,
      hasStoredToken
    };
  } catch {
    const deviceId = ensureWorkerDeviceId({});
    return mergeLifecycleDefaults({
      apiUrl: DEFAULT_API_URL,
      runtimeMode: 'managed',
      useStoredToken: false,
      token: '',
      deviceId,
      llmProvider: DEFAULT_LLM_PROVIDER,
      llmBaseUrl: DEFAULT_OPENAI_COMPAT_URL,
      llmApiKey: '',
      openAiCompatRoleMode: DEFAULT_OPENAI_COMPAT_ROLE_MODE,
      genModel: DEFAULT_GEN_MODEL,
      embedModel: DEFAULT_EMBED_MODEL,
      countryCode: '',
      countryName: '',
      regionName: '',
      ollamaUrl: 'http://localhost:11434',
      model: DEFAULT_GEN_MODEL,
      heartbeatMs: 45000,
      pollMs: 6000,
      consents: {
        acceptLocalRuntime: false,
        acceptResourceUsage: false,
        acceptNetworkCalls: false
      },
      hasStoredToken
    });
  }
}

async function saveConfig(config) {
  const candidateToken = String(config?.token || '').trim();
  const storedToken = candidateToken ? await setStoredToken(candidateToken) : undefined;
  if (candidateToken) {
    // token is saved only to keychain, never to config file
  }

  // Security: do not persist worker token in plaintext on disk.
  const safeConfig = {
    ...config,
    token: '',
    hasStoredToken: undefined,
    runtimeMode: 'managed' // Default to managed - will attempt auto-install via winget or use system Ollama
  };
  fs.mkdirSync(path.dirname(getConfigPath()), { recursive: true });
  fs.writeFileSync(getConfigPath(), JSON.stringify(safeConfig, null, 2), 'utf8');
  if (lifecycle) {
    const persistedToken = candidateToken ? Boolean(storedToken) : Boolean(await getStoredToken());
    lifecycle.onConfigSaved({ ...safeConfig, hasStoredToken: persistedToken });
  }
  return { storedToken };
}

function readJsonSafe(filePath) {
  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function sha256File(filePath) {
  return new Promise((resolve, reject) => {
    const hash = crypto.createHash('sha256');
    const stream = fs.createReadStream(filePath);
    stream.on('error', reject);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('end', () => resolve(hash.digest('hex')));
  });
}

async function verifySha256IfProvided(filePath, expectedHash) {
  const normalized = String(expectedHash || '').trim().toLowerCase();
  if (!normalized) return true;
  const actual = String(await sha256File(filePath)).toLowerCase();
  return actual === normalized;
}

async function downloadToFile(url, destinationPath) {
  const res = await fetch(url);
  if (!res.ok || !res.body) {
    throw new Error(`Runtime download failed: ${res.status} ${res.statusText}`);
  }
  fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
  const file = fs.createWriteStream(destinationPath);
  await new Promise((resolve, reject) => {
    const readable = Readable.fromWeb(res.body);
    readable.on('error', reject);
    file.on('error', reject);
    file.on('finish', resolve);
    readable.pipe(file);
  });
}

function resolveRuntimeManifest() {
  const filePath = path.join(getBundledRuntimeDir(), 'manifest.json');
  const manifest = readJsonSafe(filePath);
  return {
    filePath,
    manifest
  };
}

function runtimePlatformKey() {
  return `${process.platform}-${process.arch}`;
}

async function ensureBundledRuntimeInstalled() {
  const resolved = resolveRuntimeManifest();
  if (!resolved.manifest) {
    return {
      ok: false,
      error: `Runtime manifest not found: ${resolved.filePath}`
    };
  }

  const runtime = resolved.manifest?.runtime || {};
  const platformEntry = runtime?.platforms?.[runtimePlatformKey()];
  if (!platformEntry) {
    return {
      ok: false,
      error: `Runtime platform is not configured in manifest: ${runtimePlatformKey()}`
    };
  }

  const binaryPath = String(platformEntry.binaryPath || '').trim();
  if (!binaryPath) {
    return { ok: false, error: 'Runtime manifest missing binaryPath' };
  }

  const installRoot = path.join(getRuntimeInstallDir(), String(runtime.name || 'ollama'));
  const installedBinary = path.join(installRoot, binaryPath);
  const source = platformEntry.source || {};
  let sourceKind = String(source.kind || '').trim();
  let sourceSha = String(source.sha256 || '').trim();
  let sourcePath = String(source.path || '').trim();
  let sourceUrl = String(source.url || '').trim();

  // Environment override allows shipping lightweight installer and downloading runtime on first run.
  const envBundleUrl = String(process.env.OLLAMA_BUNDLED_URL || '').trim();
  const envBundleSha = String(process.env.OLLAMA_BUNDLED_SHA256 || '').trim();
  if (envBundleUrl) {
    sourceKind = 'external_url';
    sourceUrl = envBundleUrl;
    sourceSha = envBundleSha || sourceSha;
  }

  if (fs.existsSync(installedBinary)) {
    const validInstalled = await verifySha256IfProvided(installedBinary, sourceSha);
    if (validInstalled) {
      // Also verify DLLs exist
      const libDir = path.join(installRoot, 'lib');
      if (!fs.existsSync(libDir) || !fs.readdirSync(libDir).length) {
        sendLog('warn', 'Bundled runtime DLLs missing, reinstalling');
      } else {
        return { ok: true, executable: installedBinary, installed: false };
      }
    } else {
      sendLog('warn', 'Bundled runtime checksum mismatch, reinstalling runtime');
    }
  }

  fs.mkdirSync(path.dirname(installedBinary), { recursive: true });
  const tempRoot = path.join(getRuntimeInstallDir(), '_tmp');
  fs.mkdirSync(tempRoot, { recursive: true });
  const tempFile = path.join(tempRoot, `${String(runtime.name || 'runtime')}-${Date.now()}.bin`);

  try {
    if (sourceKind === 'bundled_file') {
      if (!sourcePath) {
        return { ok: false, error: 'Runtime manifest missing source.path for bundled_file' };
      }
      const bundledSource = path.join(getBundledRuntimeDir(), sourcePath);
      if (!fs.existsSync(bundledSource)) {
        return { ok: false, error: `Bundled runtime file not found: ${bundledSource}` };
      }
      fs.copyFileSync(bundledSource, tempFile);
    } else if (sourceKind === 'external_url') {
      if (!sourceUrl) {
        return { ok: false, error: 'Runtime manifest missing source.url for external_url' };
      }
      sendLog('info', `Downloading bundled runtime from ${sourceUrl}`);
      await downloadToFile(sourceUrl, tempFile);
    } else {
      return { ok: false, error: `Unsupported runtime source kind: ${sourceKind}` };
    }

    const valid = await verifySha256IfProvided(tempFile, sourceSha);
    if (!valid) {
      return { ok: false, error: 'Runtime checksum verification failed' };
    }

    fs.copyFileSync(tempFile, installedBinary);
    if (process.platform !== 'win32') {
      fs.chmodSync(installedBinary, 0o755);
    }

    // Copy DLLs from bundled runtime to same folder as ollama.exe
    const bundledLibDir = path.join(getBundledRuntimeDir(), 'lib');
    if (fs.existsSync(bundledLibDir)) {
      sendLog('info', 'Copying bundled runtime DLLs...');
      // Copy DLLs to the same directory as the executable
      const files = fs.readdirSync(bundledLibDir);
      for (const file of files) {
        const srcFile = path.join(bundledLibDir, file);
        const destFile = path.join(installRoot, file);
        if (fs.statSync(srcFile).isFile()) {
          fs.copyFileSync(srcFile, destFile);
        }
      }
    }

    return { ok: true, executable: installedBinary, installed: true };
  } catch (error) {
    return {
      ok: false,
      error: error?.message || 'Failed to install bundled runtime'
    };
  } finally {
    try {
      if (fs.existsSync(tempFile)) fs.unlinkSync(tempFile);
    } catch {}
  }
}

async function resolveCommandPath(cmd) {
  const isWin = process.platform === 'win32';
  return new Promise((resolve) => {
    const lookup = spawn(isWin ? 'where' : 'which', [cmd], { windowsHide: true });
    let stdout = '';
    lookup.stdout.on('data', (chunk) => {
      stdout += String(chunk || '');
    });
    lookup.on('error', () => resolve(null));
    lookup.on('close', (code) => {
      if (code !== 0) return resolve(null);
      const first = stdout.split(/\r?\n/).map((s) => s.trim()).filter(Boolean)[0] || null;
      resolve(first);
    });
  });
}

async function installOllamaWindows() {
  const winget = await resolveCommandPath('winget');
  
  // Check for bundled OllamaSetup.exe first
  const bundledInstaller = path.join(process.resourcesPath, 'OllamaSetup.exe');
  if (app.isPackaged && fs.existsSync(bundledInstaller)) {
    sendLog('info', 'Found bundled Ollama installer, launching...');
    return new Promise((resolve) => {
      const child = spawn(bundledInstaller, [], {
        windowsHide: false,
        stdio: 'ignore'
      });
      child.on('error', (error) => {
        sendLog('error', `Failed to launch Ollama installer: ${error.message}`);
        resolve({ ok: false, error: error.message });
      });
      // Ollama installer is interactive, so we assume it will complete successfully
      // Wait a bit for the installer to start
      setTimeout(() => {
        sendLog('info', 'Ollama installer launched - please complete installation');
        resolve({ ok: true, interactive: true });
      }, 3000);
    });
  }

  // Fallback to winget if no bundled installer
  if (!winget) {
    return {
      ok: false,
      error: 'winget is not available on this system and no Ollama installer found'
    };
  }

  sendLog('info', 'Ollama not found. Attempting automatic install via winget...');
  return new Promise((resolve) => {
    const child = spawn(
      winget,
      [
        'install',
        '-e',
        '--id',
        'Ollama.Ollama',
        '--accept-source-agreements',
        '--accept-package-agreements'
      ],
      { windowsHide: true }
    );

    child.stdout.on('data', (chunk) => {
      const line = String(chunk || '').trim();
      if (line) sendLog('info', `[winget] ${line}`);
    });
    child.stderr.on('data', (chunk) => {
      const line = String(chunk || '').trim();
      if (line) sendLog('warn', `[winget] ${line}`);
    });
    child.on('error', (error) => {
      resolve({ ok: false, error: error?.message || 'failed to start winget install' });
    });
    child.on('close', (code) => {
      if (code === 0) {
        sendLog('info', 'Ollama installation completed');
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `winget install exited with code ${code}` });
      }
    });
  });
}

async function resolveOllamaExecutable(config) {
  const candidates = [];
  const runtimeMode = String(config?.runtimeMode || 'managed');
  const envPath = String(process.env.OLLAMA_EXECUTABLE || '').trim();
  if (envPath) candidates.push(envPath);

  if (runtimeMode === 'bundled') {
    candidates.push(path.join(getRuntimeInstallDir(), 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama'));
    // Check bundled portable ollama in resources
    const bundledPortable = path.join(process.resourcesPath, 'runtime', 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama');
    if (app.isPackaged && fs.existsSync(bundledPortable)) {
      candidates.push(bundledPortable);
    }
    candidates.push(path.join(getBundledRuntimeDir(), 'ollama', process.platform === 'win32' ? 'ollama.exe' : 'ollama'));
  }

  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || '';
    const programFiles = process.env.ProgramFiles || '';
    if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'Ollama', 'ollama.exe'));
    if (programFiles) candidates.push(path.join(programFiles, 'Ollama', 'ollama.exe'));
  } else {
    candidates.push('/usr/local/bin/ollama', '/usr/bin/ollama');
  }

  for (const candidate of candidates) {
    if (candidate && fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const commandPath = await resolveCommandPath('ollama');
  return commandPath || null;
}

async function waitForOllamaReady(baseUrl, timeoutMs = 60000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // eslint-disable-next-line no-await-in-loop
    const ok = await checkOllamaReachable(baseUrl);
    if (ok) return true;
    // eslint-disable-next-line no-await-in-loop
    await new Promise((resolve) => setTimeout(resolve, 1500));
  }
  return false;
}

async function ensureOllamaRunning(config) {
  const baseUrl = String(config?.ollamaUrl || '').trim();
  if (await checkOllamaReachable(baseUrl)) {
    return { status: 'already_running' };
  }

  let executable = await resolveOllamaExecutable(config);
  if (!executable) {
    const mode = String(config?.runtimeMode || 'managed');
    if (process.platform === 'win32' && (mode === 'managed' || mode === 'bundled')) {
      const installResult = await installOllamaWindows();
      if (!installResult.ok) {
        return {
          status: 'missing_executable',
          error: `Ollama executable not found and auto-install failed: ${installResult.error}`
        };
      }
      executable = await resolveOllamaExecutable(config);
    }

    if (!executable) {
      return {
        status: 'missing_executable',
        error: 'Ollama executable not found after auto-install. Restart app and run Prepare Runtime again.'
      };
    }
  }

  sendLog('info', `Starting Ollama runtime: ${executable}`);
  const child = spawn(executable, ['serve'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true
  });
  child.unref();

  const ready = await waitForOllamaReady(baseUrl);
  if (!ready) {
    return {
      status: 'start_timeout',
      error: 'Ollama did not become ready in time'
    };
  }
  return { status: 'started', executable };
}

const OLLAMA_MODEL_NAME_REGEX = /^[a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?$/;
const SHELL_METACHARS_REGEX = /[&;|`$]/;

function validateOllamaModelName(rawModel) {
  const model = String(rawModel || '').trim();
  if (!model) {
    return { ok: false, error: 'Model name cannot be empty' };
  }
  if (model.startsWith('-')) {
    return {
      ok: false,
      error: `Invalid model name "${model}": leading hyphens are strictly rejected to prevent CLI argument injection`
    };
  }
  if (SHELL_METACHARS_REGEX.test(model)) {
    return {
      ok: false,
      error: `Invalid model name "${model}": shell metacharacters are forbidden`
    };
  }
  if (!OLLAMA_MODEL_NAME_REGEX.test(model)) {
    return {
      ok: false,
      error: `Invalid model name "${model}": must match strict regex ^[a-zA-Z0-9_.-]+(:[a-zA-Z0-9_.-]+)?$`
    };
  }
  return { ok: true, model };
}

async function pullModelWithProgress(config, executable) {
  const validation = validateOllamaModelName(config.model);
  if (!validation.ok) {
    sendLog('error', `[ollama pull rejected] ${validation.error}`);
    return { ok: false, error: validation.error };
  }
  const targetModel = validation.model;

  return new Promise((resolve) => {
    sendLog('info', `Pulling model ${targetModel} (this can take several minutes)...`);
    const stripAnsi = (value) =>
      String(value || '')
        .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, '')
        .replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, ' ');
    const normalizePullLine = (chunk) =>
      stripAnsi(chunk)
        .replace(/[^\x20-\x7E\u00A0-\u024F\u0400-\u04FF]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
    let lastStdoutLine = '';
    let lastStderrLine = '';
    let lastStdoutAt = 0;
    let lastStderrAt = 0;

    const child = spawn(executable, ['pull', targetModel], {
      windowsHide: true
    });

    child.stdout.on('data', (chunk) => {
      const line = normalizePullLine(chunk);
      const now = Date.now();
      if (line && (line !== lastStdoutLine || now - lastStdoutAt > 1200)) {
        lastStdoutLine = line;
        lastStdoutAt = now;
        sendLog('info', `[ollama pull] ${line}`);
      }
    });
    child.stderr.on('data', (chunk) => {
      const line = normalizePullLine(chunk);
      const now = Date.now();
      if (line && (line !== lastStderrLine || now - lastStderrAt > 1200)) {
        lastStderrLine = line;
        lastStderrAt = now;
        sendLog('warn', `[ollama pull] ${line}`);
      }
    });
    child.on('error', (error) => {
      resolve({ ok: false, error: error.message || 'failed to start ollama pull' });
    });
    child.on('close', (code) => {
      if (code === 0) {
        sendLog('info', `Model ${config.model} is ready`);
        resolve({ ok: true });
      } else {
        resolve({ ok: false, error: `ollama pull exited with code ${code}` });
      }
    });
  });
}

function safeSendToRenderer(channel, payload) {
  try {
    if (!mainWindow || mainWindow.isDestroyed()) return;
    const wc = mainWindow.webContents;
    if (!wc || wc.isDestroyed()) return;
    wc.send(channel, payload);
  } catch {}
}

function sendDebugLog(message) {
  sendLog('debug', message);
}

function sendLog(level, message) {
  if (lifecycle) lifecycle.noteWorkerLogHint(message);
  safeSendToRenderer('worker:log', {
    ts: new Date().toISOString(),
    level,
    message
  });
}

function sendStatus() {
  safeSendToRenderer('worker:status', workerState);
}

function resolveRepoRoot() {
  return path.resolve(__dirname, '..', '..');
}

function resolveWorkerScript() {
  if (app.isPackaged) {
    // Use app.getAppPath() for files inside asar
    return path.join(app.getAppPath(), 'agent', 'ai_worker_agent.mjs');
  }
  return path.join(resolveRepoRoot(), 'worker_desktop', 'agent', 'ai_worker_agent.mjs');
}

async function sendStandbyBeacon(config = null, reason = 'Worker stopped by user') {
  let conf = config;
  if (!conf) {
    try {
      conf = await loadConfig();
    } catch {
      conf = {};
    }
  }
  const apiUrl = String(conf?.apiUrl || '').trim() || 'https://quavence.com';
  const token = await resolveNodeToken(conf);
  const gpu = getCachedGpuTelemetry();
  const fingerprint = String(buildHardwareFingerprint(gpu)).trim();
  const deviceId = String(conf?.deviceId || '').trim() || ensureWorkerDeviceId(conf);

  if (!apiUrl || !token || !deviceId) {
    return;
  }

  sendLog('info', '[SYS] AI Worker stopped. Sending standby notification to Hub...');
  try {
    const res = await requestJson(
      'POST',
      `${apiUrl}/api/ai/nodes/heartbeat`,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
        'X-AI-Worker-Device-ID': deviceId,
        'X-AI-Worker-Hardware-Fingerprint': fingerprint,
        'X-AI-Worker-GPU-Model': gpu.gpuName,
        'X-AI-Worker-GPU-VRAM': String(gpu.vramMb),
        'X-AI-Worker-GPU-PCI-Bus': gpu.pciBusId,
      },
      {
        device_id: deviceId,
        hardware_fingerprint: fingerprint,
        gpu_name: gpu.gpuName,
        vram_mb: gpu.vramMb,
        gpu_pci_bus_id: gpu.pciBusId,
        compute_ready: false,
        reason,
      },
      2500
    );
    if (res?.ok) {
      sendLog('info', '[HUB] Hub notified: Node switched to standby mode.');
    } else {
      const errMessage = res?.data?.error || res?.data?.message || `HTTP ${res?.status || 'unknown'}`;
      sendLog('warn', '[HUB] Standby notification failed: ' + errMessage);
    }
  } catch (err) {
    sendLog('warn', '[HUB] Standby notification failed: ' + err.message);
  }
}

function stopWorkerInternal() {
  const tokenForBeacon = sessionNodeToken;
  sessionNodeToken = '';
  if (lifecycle) lifecycle.onWorkerStoppedByUser();
  void (async () => {
    try {
      const cfg = await loadConfig().catch(() => ({}));
      if (tokenForBeacon && !cfg.token) {
        cfg.token = tokenForBeacon;
      }
      await sendStandbyBeacon(cfg, 'Worker stopped by user');
    } catch {}
  })();
  if (!workerProcess) return;
  try {
    workerProcess.kill('SIGTERM');
  } catch {}
}

async function checkOllamaReachable(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const url = `${String(baseUrl || '').replace(/\/+$/, '')}/api/tags`;
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

function normalizeOpenAICompatBaseUrl(baseUrl) {
  let value = String(baseUrl || '').trim();
  if (!value) return DEFAULT_OPENAI_COMPAT_URL;
  value = value.replace(/\/+$/, '');
  value = value.replace(/\/chat\/completions$/i, '');
  return value;
}

function normalizeOpenAICompatRoleMode(rawValue) {
  const mode = String(rawValue || DEFAULT_OPENAI_COMPAT_ROLE_MODE).trim().toLowerCase();
  if (mode === 'system' || mode === 'user_only') return mode;
  return 'auto';
}

async function checkOpenAICompatReachable(baseUrl, apiKey = '') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const normalizedBase = normalizeOpenAICompatBaseUrl(baseUrl);
    const headers = {};
    if (String(apiKey || '').trim()) {
      headers.Authorization = `Bearer ${String(apiKey || '').trim()}`;
    }
    const res = await fetch(`${normalizedBase}/models`, { method: 'GET', headers, signal: controller.signal });
    return res.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

const MODEL_MIN_PARAMS = {
  'qwen/qwen3-vl-8b': '7B',
  'mistral-7b-instruct-v0.3': '7B',
  'qwen2.5-7b-instruct': '7B',
  'qwen2.5-coder-7b-instruct': '7B',
  'phi3:latest': '3B',
  'text-embedding-nomic-embed-text-v2-moe': '0.4B',
  'nomic-embed-text': '0.1B',
};

async function probeOllamaModelDetails(baseUrl, modelName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 4000);
  try {
    const res = await fetch(`${String(baseUrl || '').replace(/\/+$/, '')}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: modelName }),
      signal: controller.signal,
    });
    if (!res.ok) return null;
    const payload = await res.json().catch(() => null);
    return {
      parameter_size: payload?.details?.parameter_size || null,
      family: payload?.details?.family || null,
      format: payload?.details?.format || null,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function validateModelSize(canonicalModel, details) {
  const minSize = MODEL_MIN_PARAMS[canonicalModel];
  if (!minSize || !details?.parameter_size) return { ok: true, warning: 'size_unchecked' };
  
  const rawReported = String(details.parameter_size).trim();
  const match = rawReported.match(/^([\d.,]+)\s*([bmkBMK])?$/);
  if (!match) {
    return { ok: true, warning: 'size_format_unknown', parameter_size: rawReported };
  }

  const cleanNumStr = match[1].replace(',', '.');
  const reportedNum = parseFloat(cleanNumStr);
  if (!Number.isFinite(reportedNum)) {
    return { ok: true, warning: 'size_format_unknown', parameter_size: rawReported };
  }

  const unit = (match[2] || 'B').toUpperCase();
  let reportedInBillions = reportedNum;
  if (unit === 'M') reportedInBillions = reportedNum / 1000;
  if (unit === 'K') reportedInBillions = reportedNum / 1000000;

  const expectedMatch = String(minSize).trim().match(/^([\d.,]+)\s*([bmkBMK])?$/);
  const expectedNum = expectedMatch ? parseFloat(expectedMatch[1].replace(',', '.')) : parseFloat(minSize);
  const expectedUnit = (expectedMatch?.[2] || 'B').toUpperCase();
  let expectedInBillions = expectedNum;
  if (expectedUnit === 'M') expectedInBillions = expectedNum / 1000;

  if (reportedInBillions < expectedInBillions * 0.7) {
    return {
      ok: false,
      reason: `Model size too small: reported ${rawReported}, expected >= ${minSize}`
    };
  }
  return { ok: true, parameter_size: rawReported };
}

async function checkModelAvailable(baseUrl, modelName) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const url = `${String(baseUrl || '').replace(/\/+$/, '')}/api/tags`;
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return false;
    const payload = await res.json().catch(() => ({}));
    const models = Array.isArray(payload?.models) ? payload.models : [];
    const normalized = String(modelName || '').trim().toLowerCase();
    if (!normalized) return false;
    const accepted = new Set([normalized]);
    if (!normalized.includes(':')) {
      accepted.add(`${normalized}:latest`);
    }
    const nameFound = models.some((m) => accepted.has(String(m?.name || '').trim().toLowerCase()));
    if (!nameFound) return false;

    // Verify model parameter size via /api/show to prevent model downgrade spoofing
    const details = await probeOllamaModelDetails(baseUrl, modelName);
    if (details) {
      const canonical = normalizeGenModelForProvider('ollama', modelName);
      const sizeCheck = validateModelSize(canonical, details);
      if (!sizeCheck.ok) {
        sendLog('warn', `[model-probe] ${sizeCheck.reason}`);
        return false;
      }
      if (sizeCheck.warning === 'size_unchecked') {
        sendLog('warn', `[model-probe] size not verifiable for ${modelName} - Ollama /api/show returned no parameter_size`);
      }
    }
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAvailableModels(baseUrl) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const url = `${String(baseUrl || '').replace(/\/+$/, '')}/api/tags`;
    const res = await fetch(url, { method: 'GET', signal: controller.signal });
    if (!res.ok) return [];
    const payload = await res.json().catch(() => ({}));
    const models = Array.isArray(payload?.models) ? payload.models : [];
    return models
      .map((m) => String(m?.name || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchOpenAICompatModels(baseUrl, apiKey = '') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const normalizedBase = normalizeOpenAICompatBaseUrl(baseUrl);
    const headers = {};
    if (String(apiKey || '').trim()) {
      headers.Authorization = `Bearer ${String(apiKey || '').trim()}`;
    }
    const res = await fetch(`${normalizedBase}/models`, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) return [];
    const payload = await res.json().catch(() => ({}));
    const models = Array.isArray(payload?.data) ? payload.data : [];
    return models
      .map((m) => String(m?.id || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  } finally {
    clearTimeout(timeout);
  }
}

// LM Studio's OpenAI-compatible /v1/models lists downloaded models, not loaded ones.
// Its native /api/v0/models exposes per-model `state`, which is the only way to know
// whether inference will actually work without JIT loading.
async function fetchLmStudioLoadedModels(baseUrl, apiKey = '') {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 3500);
  try {
    const apiBase = normalizeOpenAICompatBaseUrl(baseUrl).replace(/\/v\d+$/i, '');
    const headers = {};
    if (String(apiKey || '').trim()) {
      headers.Authorization = `Bearer ${String(apiKey || '').trim()}`;
    }
    const res = await fetch(`${apiBase}/api/v0/models`, { method: 'GET', headers, signal: controller.signal });
    if (!res.ok) return { supported: false, loaded: [], modelContextLengths: {} };
    const payload = await res.json().catch(() => null);
    const models = Array.isArray(payload?.data) ? payload.data : null;
    if (!models) return { supported: false, loaded: [], modelContextLengths: {} };
    const hasState = models.some((m) => typeof m?.state === 'string');
    if (!hasState) return { supported: false, loaded: [], modelContextLengths: {} };
    const modelContextLengths = {};
    for (const m of models) {
      const id = String(m?.id || '').trim();
      if (!id) continue;
      let ctx = Number(m?.loaded_context_length || m?.max_context_length || 0);
      if (!Number.isFinite(ctx) || ctx <= 0) ctx = 8192;
      modelContextLengths[id] = Math.max(512, Math.min(131072, Math.floor(ctx)));
    }
    const loaded = models
      .filter((m) => String(m?.state || '').trim().toLowerCase() === 'loaded')
      .map((m) => String(m?.id || '').trim())
      .filter(Boolean)
      .sort((a, b) => a.localeCompare(b));
    return { supported: true, loaded, modelContextLengths };
  } catch {
    return { supported: false, loaded: [], modelContextLengths: {} };
  } finally {
    clearTimeout(timeout);
  }
}

function isOpenAICompatModelListed(availableModels, modelId) {
  const wanted = String(modelId || '').trim();
  if (!wanted || !Array.isArray(availableModels)) return false;
  const lower = wanted.toLowerCase();
  return availableModels.some((m) => {
    const id = String(m || '').trim();
    return id === wanted || id.toLowerCase() === lower;
  });
}

async function checkRuntime(config) {
  const policy = await getCachedRuntimePolicy(config?.apiUrl);
  const effectiveConfig = applyPolicyToConfig(config || {}, policy);
  const policyActive = isPolicyEnforced(policy);
  const hardwareTier = extractHardwareTier(policy);
  const provider = String(effectiveConfig?.llmProvider || DEFAULT_LLM_PROVIDER).trim().toLowerCase();
  const allowedModels = getAllowedGenModelsForProvider(provider, policy);
  if (provider === 'openai_compat') {
    const llmBaseUrl = normalizeOpenAICompatBaseUrl(effectiveConfig?.llmBaseUrl || DEFAULT_OPENAI_COMPAT_URL);
    const llmApiKey = String(effectiveConfig?.llmApiKey || '').trim();
    const userPreferredGen = String(effectiveConfig?.genModel || effectiveConfig?.model || '').trim();
    let genModel;
    if (policyActive) {
      if (userPreferredGen && isApprovedGenerationModel(policy, userPreferredGen)) {
        genModel = userPreferredGen;
      } else {
        genModel = String(policy.generation_model || '').trim();
      }
    } else {
      genModel = normalizeGenModelForProvider(provider, userPreferredGen || DEFAULT_OPENAI_GEN_MODEL);
    }
    const embedModel = policyActive
      ? String(policy.embedding_model || '').trim()
      : String(effectiveConfig?.embedModel || '').trim();
    const reachable = await checkOpenAICompatReachable(llmBaseUrl, llmApiKey);
    const availableModels = reachable ? await fetchOpenAICompatModels(llmBaseUrl, llmApiKey) : [];
    const selectedSupported = policyActive
      ? isApprovedGenerationModel(policy, genModel)
      : isSupportedGenModelForProvider(provider, genModel, policy);
    const mapped = mapSupportedModelFromAvailable(availableModels, userPreferredGen, provider, policy);

    // Resolve detected model on endpoint
    let detectedGenerationModel = null;
    if (policyActive) {
      if (genModel) {
        detectedGenerationModel = resolveListedModelId(genModel, availableModels);
      }
      if (!detectedGenerationModel && policy.generation_model) {
        detectedGenerationModel = resolveListedModelId(policy.generation_model, availableModels);
      }
      if (!detectedGenerationModel && Array.isArray(policy.allowed_generation_models)) {
        for (const candidate of policy.allowed_generation_models) {
          detectedGenerationModel = resolveListedModelId(candidate, availableModels);
          if (detectedGenerationModel) {
            genModel = candidate;
            break;
          }
        }
      }
    } else {
      detectedGenerationModel = resolveListedModelId(genModel, availableModels);
    }

    const generationModelListed = policyActive
      ? Boolean(detectedGenerationModel)
      : Boolean(selectedSupported && mapped && mapped.canonicalModel === genModel);
    const embeddingModelListed = policyActive
      ? exactModelListed(embedModel, availableModels)
      : (!embedModel
        ? true
        : Boolean(reachable && isOpenAICompatModelListed(availableModels, embedModel)));

    const loadState = reachable
      ? await fetchLmStudioLoadedModels(llmBaseUrl, llmApiKey)
      : { supported: false, loaded: [], modelContextLengths: {} };
    const isLoaded = (canonicalId) => {
      if (!loadState.supported) return true;
      const listedId = resolveListedModelId(canonicalId, availableModels) || String(canonicalId || '').trim();
      return isOpenAICompatModelListed(loadState.loaded, listedId);
    };
    const activeGenTarget = detectedGenerationModel || genModel;
    const generationModelAvailable = generationModelListed && isLoaded(activeGenTarget);
    const embeddingModelAvailable = embeddingModelListed && (!embedModel || isLoaded(embedModel));
    const generationModelDownloadedNotLoaded = generationModelListed && !generationModelAvailable;
    const embeddingModelDownloadedNotLoaded = Boolean(embedModel) && embeddingModelListed && !embeddingModelAvailable;
    const modelAvailable = generationModelAvailable;
    const policyAllowed = policyActive
      ? Boolean(generationModelAvailable && embeddingModelAvailable)
      : selectedSupported;
    const runtimePolicyBlockReason = policyActive
      ? buildRuntimePolicyBlockReason(policy, {
        provider: config?.llmProvider || effectiveConfig?.llmProvider,
        generationOk: generationModelAvailable,
        embeddingOk: embeddingModelAvailable,
        reachable,
        availableIds: availableModels,
        activeGenModel: activeGenTarget,
      })
      : '';
    const runtimePolicyBlocked = Boolean(runtimePolicyBlockReason);
    const runtimePolicyMismatches = policyActive
      ? buildRuntimePolicyIssues(policy, {
        provider: config?.llmProvider || effectiveConfig?.llmProvider,
        generationOk: generationModelAvailable,
        embeddingOk: embeddingModelAvailable,
        reachable,
        availableIds: availableModels,
        activeGenModel: activeGenTarget,
      })
      : [];
    const detectedEmbeddingModel = policyActive
      ? resolveListedModelId(embedModel, availableModels)
      : null;

    let maxContextTokens = 8192;
    if (loadState.supported && loadState.modelContextLengths) {
      const mappedId = activeGenTarget;
      if (loadState.modelContextLengths[mappedId]) {
        maxContextTokens = loadState.modelContextLengths[mappedId];
      }
    }

    return {
      provider,
      mode: 'external',
      llmBaseUrl,
      model: genModel,
      genModel,
      embedModel,
      hardware_tier: hardwareTier,
      hardwareTier,
      ollamaReachable: false,
      modelAvailable,
      generationModelAvailable: modelAvailable,
      embeddingModelAvailable,
      openaiCompatReachable: reachable,
      policyAllowed,
      runtimePolicy: policy,
      runtimePolicyBlocked,
      runtimePolicyBlockReason,
      runtimePolicyMismatches,
      detectedGenerationModel,
      detectedEmbeddingModel,
      maxContextTokens,
      modelContextLengths: loadState.modelContextLengths || {},
      policyEnforced: policyActive,
      requiredGenerationModel: policyActive ? policy.generation_model : null,
      requiredEmbeddingModel: policyActive ? policy.embedding_model : null,
      allowedGenerationModels: policyActive ? Array.from(allowedModels) : [],
      detectedModels: availableModels,
      modelLoadStateKnown: loadState.supported,
      loadedModels: loadState.loaded,
      generationModelDownloadedNotLoaded,
      embeddingModelDownloadedNotLoaded,
      ready: Boolean(reachable && policyAllowed && modelAvailable && embeddingModelAvailable && !runtimePolicyBlocked),
      requirements: {
        openaiCompatReachable: 'OpenAI-compatible endpoint is reachable',
        generationModelAvailable: policyActive
          ? `Required generation model ${genModel} must be loaded in LM Studio`
          : 'Generation model is available on endpoint',
        embeddingModelAvailable: policyActive
          ? `Required embedding model ${embedModel} must be loaded in LM Studio`
          : (embedModel
            ? 'Embedding model is listed on OpenAI-compatible /models (load it in LM Studio if missing)'
            : 'Embedding model optional; set to match RAG GI_RAG_EMBED_MODEL when using local embeddings'),
        policyAllowed: policyActive
          ? `Hub policy (Tier ${hardwareTier}) requires ${policy.generation_model} (or approved tier models) + ${policy.embedding_model}`
          : `Allowed models: ${Array.from(allowedModels).join(', ')}`
      }
    };
  }

  const mode = String(effectiveConfig?.runtimeMode || 'managed');
  const ollamaUrl = String(effectiveConfig?.ollamaUrl || '').trim();
  const genModel = normalizeGenModelForProvider(provider, effectiveConfig?.genModel || effectiveConfig?.model || DEFAULT_GEN_MODEL);
  const embedModel = String(effectiveConfig?.embedModel || '').trim();
  const ollamaReachable = await checkOllamaReachable(ollamaUrl);
  const generationModelAvailable = ollamaReachable ? await checkModelAvailable(ollamaUrl, genModel) : false;
  const embeddingModelAvailable = embedModel
    ? (ollamaReachable ? await checkModelAvailable(ollamaUrl, embedModel) : false)
    : true;
  const runtimePolicyBlockReason = policyActive
    ? buildRuntimePolicyBlockReason(policy, {
      provider,
      generationOk: generationModelAvailable,
      embeddingOk: embeddingModelAvailable,
      reachable: ollamaReachable,
    })
    : '';
  const runtimePolicyBlocked = Boolean(runtimePolicyBlockReason);

  return {
    mode,
    ollamaUrl,
    model: genModel,
    genModel,
    embedModel,
    ollamaReachable,
    modelAvailable: generationModelAvailable,
    generationModelAvailable,
    embeddingModelAvailable,
    policyAllowed: policyActive ? false : isSupportedGenModelForProvider(provider, genModel),
    runtimePolicy: policy,
    runtimePolicyBlocked,
    runtimePolicyBlockReason,
    policyEnforced: policyActive,
    ready: Boolean(
      !runtimePolicyBlocked
      && ollamaReachable
      && generationModelAvailable
      && embeddingModelAvailable
      && (policyActive ? false : isSupportedGenModelForProvider(provider, genModel))
    ),
    requirements: {
      ollamaReachable: 'Ollama service is reachable',
      generationModelAvailable: 'Generation model is installed in Ollama',
      embeddingModelAvailable: 'Embedding model is installed in Ollama',
      policyAllowed: policyActive
        ? `Hub policy requires ${policy.provider} provider`
        : `Allowed models: ${Array.from(allowedModels).join(', ')}`
    }
  };
}

async function fetchWorkerOverview(config) {
  const apiUrl = String(config?.apiUrl || '').trim();
  let token = await resolveNodeToken(config);
  
  if (!apiUrl || !token) {
    return { ok: false, error: 'API URL and token are required' };
  }

  try {
    const res = await requestJsonWithRetry(
      requestJson,
      'GET',
      `${apiUrl}/api/ai/nodes/self/overview`,
      {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${token}`,
      },
      null,
      { timeoutMs: HUB_REQUEST_TIMEOUT_MS },
    );

    if (!res.ok) {
      let errorMessage = `API error: ${res.status}`;
      if (res.data?.error) {
        errorMessage = `${errorMessage} - ${String(res.data.error)}`;
      }
      return {
        ok: false,
        error: errorMessage,
        status: res.status,
        code: res.data?.code || null,
        reason: res.data?.reason || null,
        message: res.data?.message || res.data?.error || null,
        suspension: res.data?.suspension || null,
        rateLimited: res.status === 429,
      };
    }

    return { ok: true, data: res.data?.data || null };
  } catch (error) {
    const causeMessage = String(error?.cause?.message || '').trim();
    const errorMessage = String(error?.message || 'request failed').trim();
    const details = causeMessage && causeMessage !== errorMessage
      ? `${errorMessage} (${causeMessage})`
      : errorMessage;
    return { ok: false, error: `Network error: ${details}` };
  }
}

async function resolveNodeToken(config) {
  const useStored = config?.useStoredToken || false;
  let token = useStored ? await getStoredToken() : String(config?.token || '').trim();
  if (!token) token = await getStoredToken();
  if (!token) token = String(sessionNodeToken || '').trim();
  return String(token || '').trim();
}

async function prepareRuntime(config) {
  const provider = String(config?.llmProvider || DEFAULT_LLM_PROVIDER).trim().toLowerCase();
  if (provider === 'openai_compat') {
    const runtime = await checkRuntime(config || {});
    if (!runtime.openaiCompatReachable) {
      return {
        ok: false,
        runtime,
        reason: 'LM Studio local server is not reachable. Open LM Studio → Developer → Start server, then retry.'
      };
    }
    if (!runtime.generationModelAvailable) {
      return {
        ok: false,
        runtime,
        reason: runtime.generationModelDownloadedNotLoaded
          ? `Generation model "${runtime.genModel}" is downloaded but not loaded. Load it in LM Studio (Developer page or: lms load ${runtime.genModel}), then retry.`
          : `Generation model "${runtime.genModel}" is not loaded. In LM Studio load it (Developer page or: lms load ${runtime.genModel}), then retry.`
      };
    }
    if (!runtime.embeddingModelAvailable) {
      return {
        ok: false,
        runtime,
        reason: runtime.embeddingModelDownloadedNotLoaded
          ? `Embedding model "${runtime.embedModel}" is downloaded but not loaded. Load it in LM Studio (or: lms load ${runtime.embedModel}), then retry.`
          : `Embedding model "${runtime.embedModel}" is not loaded. Load it in LM Studio or clear the embedding field, then retry.`
      };
    }
    sendLog('info', 'Runtime check passed');
    return { ok: true, runtime };
  }

  // First check if Ollama is already running
  const ollamaUrl = String(config?.ollamaUrl || '').trim();
  const ollamaReachable = await checkOllamaReachable(ollamaUrl);
  
  // If Ollama is already running and model is available, skip bundled runtime preparation
  if (ollamaReachable) {
    const genModel = String(config?.genModel || config?.model || '').trim();
    const embedModel = String(config?.embedModel || '').trim();
    const generationModelAvailable = await checkModelAvailable(ollamaUrl, genModel);
    const embeddingModelAvailable = embedModel ? await checkModelAvailable(ollamaUrl, embedModel) : true;
    if (generationModelAvailable && embeddingModelAvailable) {
      sendLog('info', 'Ollama is already running and model is available - skipping bundled runtime');
      sendLog('info', 'Runtime check passed');
      return {
        ok: true,
        runtime: {
          mode: 'external',
          ollamaUrl,
          model: genModel,
          genModel,
          embedModel,
          ollamaReachable: true,
          modelAvailable: true,
          generationModelAvailable: true,
          embeddingModelAvailable: true,
          ready: true
        }
      };
    }
  }
  
  const runtimeMode = String(config?.runtimeMode || 'managed');
  if (runtimeMode === 'bundled') {
    sendLog('info', 'Preparing bundled runtime...');
    const installResult = await ensureBundledRuntimeInstalled();
    if (!installResult.ok) {
      return {
        ok: false,
        reason: installResult.error || 'Bundled runtime installation failed'
      };
    }
    if (installResult.installed) {
      sendLog('info', 'Bundled runtime installed');
    } else {
      sendLog('info', 'Bundled runtime already installed');
    }
  }

  let ollamaBootstrap = null;
  if (runtimeMode === 'managed' || runtimeMode === 'bundled') {
    ollamaBootstrap = await ensureOllamaRunning(config);
    if (ollamaBootstrap?.error) {
      return {
        ok: false,
        reason: ollamaBootstrap.error
      };
    }
  }

  let runtime = await checkRuntime(config);
  if (!runtime.ollamaReachable) {
    return {
      ok: false,
      reason: 'Ollama is not reachable. Install/start Ollama and verify URL.'
    };
  }

  const missingModels = [
    runtime.generationModelAvailable ? null : runtime.genModel,
    runtime.embeddingModelAvailable ? null : runtime.embedModel
  ].filter(Boolean);

  if (missingModels.length > 0 && (runtimeMode === 'managed' || runtimeMode === 'bundled')) {
    const executable = await resolveOllamaExecutable(config);
    if (!executable) {
      return {
        ok: false,
        reason: 'Ollama executable not found for automatic model pull'
      };
    }
    for (const modelName of missingModels) {
      const pullResult = await pullModelWithProgress({ ...config, model: modelName }, executable);
      if (!pullResult.ok) {
        return {
          ok: false,
          reason: pullResult.error || `Failed to pull model ${modelName}`
        };
      }
    }
    runtime = await checkRuntime(config);
  }

  if (!runtime.generationModelAvailable) {
    return {
      ok: false,
      reason: `Generation model "${runtime.genModel}" is not installed`
    };
  }

  if (!runtime.embeddingModelAvailable) {
    return {
      ok: false,
      reason: `Embedding model "${runtime.embedModel}" is not installed`
    };
  }

  sendLog('info', 'Runtime check passed');
  return {
    ok: true,
    runtime: {
      ...runtime,
      bootstrap: ollamaBootstrap
    }
  };
}

async function spawnWorkerProcess(config) {
  sendLog('info', 'Starting worker');
  const policy = await getCachedRuntimePolicy(config?.apiUrl);
  const effectiveConfig = applyPolicyToConfig(config || {}, policy);
  const policyActive = isPolicyEnforced(policy);
  const hardwareTier = extractHardwareTier(policy);

  const runtimeToken =
    String(config?.token || '').trim() ||
    (config?.useStoredToken ? await getStoredToken() : '');
  if (!runtimeToken) {
    throw new Error('Worker token is required');
  }

  const qvncAddress = String(config?.qvncAddress || '').trim();
  if (!qvncAddress) {
    throw new Error('Native Quavence payout address (S...) is required. Please set it in the App tab.');
  }
  if (!qvncAddress.startsWith('S') || qvncAddress.length < 26 || qvncAddress.length > 35) {
    throw new Error('Invalid Quavence payout address format (must start with S, 26-35 chars)');
  }
  const llmProvider = String(effectiveConfig?.llmProvider || DEFAULT_LLM_PROVIDER).trim().toLowerCase();
  const userGenModel = String(effectiveConfig?.genModel || effectiveConfig?.model || '').trim();
  let genModel;
  if (policyActive) {
    if (userGenModel && isApprovedGenerationModel(policy, userGenModel)) {
      genModel = userGenModel;
    } else {
      genModel = String(policy.generation_model || '').trim();
    }
  } else {
    genModel = normalizeGenModelForProvider(
      llmProvider,
      userGenModel || (llmProvider === 'openai_compat' ? DEFAULT_OPENAI_GEN_MODEL : DEFAULT_GEN_MODEL)
    );
  }
  if (!genModel) {
    throw new Error('Generation model is required (example: phi3:latest)');
  }
  if (policyActive && !isApprovedGenerationModel(policy, genModel)) {
    throw new Error(`Unsupported generation model. Allowed: ${Array.from(getAllowedGenModelsForProvider(llmProvider, policy)).join(', ')}`);
  }
  const embedModel = policyActive
    ? String(policy.embedding_model || '').trim()
    : String(effectiveConfig?.embedModel || '').trim();

  const workerScript = resolveWorkerScript();
  if (!fs.existsSync(workerScript)) {
    throw new Error(`Worker script not found: ${workerScript}`);
  }

  // Requests must carry the id the endpoint itself exposes; policy/canonical ids are for attestation.
  let endpointGenModel = genModel;
  let workerMaxContext = 8192;

  if (llmProvider === 'openai_compat') {
    const llmBaseUrl = normalizeOpenAICompatBaseUrl(effectiveConfig?.llmBaseUrl || DEFAULT_OPENAI_COMPAT_URL);
    const llmApiKey = String(effectiveConfig?.llmApiKey || '').trim();
    const endpointOk = await checkOpenAICompatReachable(llmBaseUrl, llmApiKey);
    if (!endpointOk) {
      throw new Error('OpenAI-compatible endpoint is not reachable. Run "Prepare Runtime" first.');
    }
    const availableModels = await fetchOpenAICompatModels(llmBaseUrl, llmApiKey);
    let targetGenId = resolveListedModelId(genModel, availableModels);
    if (!targetGenId && policyActive && Array.isArray(policy.allowed_generation_models)) {
      for (const candidate of policy.allowed_generation_models) {
        targetGenId = resolveListedModelId(candidate, availableModels);
        if (targetGenId) {
          genModel = candidate;
          break;
        }
      }
    }

    if (policyActive) {
      if (!targetGenId) {
        throw new Error(`Required generation model "${genModel}" (or approved tier models) is not loaded in LM Studio.`);
      }
      if (embedModel && !exactModelListed(embedModel, availableModels)) {
        throw new Error(`Required embedding model "${embedModel}" is not loaded in LM Studio.`);
      }
    } else {
      const selected = mapSupportedModelFromAvailable(availableModels, effectiveConfig?.genModel || effectiveConfig?.model || '', llmProvider, policy);
      if (!selected || selected.canonicalModel !== genModel) {
        throw new Error(`Generation model "${genModel}" is not available on endpoint. Check LM Studio loaded model.`);
      }
      if (embedModel && !isOpenAICompatModelListed(availableModels, embedModel)) {
        throw new Error(`Embedding model "${embedModel}" is not listed on endpoint. Load it in LM Studio or clear the field.`);
      }
    }

    endpointGenModel = targetGenId || genModel;
    if (endpointGenModel !== genModel) {
      sendLog('info', `LM Studio exposes generation model as "${endpointGenModel}" (policy id "${genModel}")`);
    }

    const loadState = await fetchLmStudioLoadedModels(llmBaseUrl, llmApiKey);
    if (loadState.supported && loadState.modelContextLengths) {
      if (loadState.modelContextLengths[endpointGenModel]) {
        workerMaxContext = loadState.modelContextLengths[endpointGenModel];
      } else if (loadState.modelContextLengths[genModel]) {
        workerMaxContext = loadState.modelContextLengths[genModel];
      }
    }
  } else {
    if (!config.ollamaUrl || !String(config.ollamaUrl).trim()) {
      throw new Error('Ollama URL is required (default: http://localhost:11434)');
    }
    if (!embedModel) {
      throw new Error('Embedding model is required (example: nomic-embed-text)');
    }
    const ollamaOk = await checkOllamaReachable(config.ollamaUrl);
    if (!ollamaOk) {
      throw new Error('Ollama is not reachable. Run "Prepare Runtime" first.');
    }
    const genModelOk = await checkModelAvailable(config.ollamaUrl, genModel);
    if (!genModelOk) {
      throw new Error(`Generation model "${genModel}" is not ready. Run "Prepare Runtime" first.`);
    }
    const embedModelOk = await checkModelAvailable(config.ollamaUrl, embedModel);
    if (!embedModelOk) {
      throw new Error(`Embedding model "${embedModel}" is not ready. Run "Prepare Runtime" first.`);
    }
  }

  sessionNodeToken = runtimeToken;
  sendLog('info', `Starting worker [Hardware Tier: ${hardwareTier}] with model "${genModel}"`);

  const childEnv = {
    ...process.env,
    HTTP_PROXY: '',
    HTTPS_PROXY: '',
    http_proxy: '',
    https_proxy: '',
    ALL_PROXY: '',
    all_proxy: '',
    NO_PROXY: [process.env.NO_PROXY, 'localhost,127.0.0.1,::1,quavence.com'].filter(Boolean).join(','),
    ELECTRON_RUN_AS_NODE: '1',
    AI_NODE_API_URL: String(config.apiUrl || '').trim(),
    AI_NODE_TOKEN: runtimeToken,
    AI_WORKER_DEVICE_ID: String(config.deviceId || ensureWorkerDeviceId(config)).trim(),
    AI_WORKER_HARDWARE_FINGERPRINT: String(buildHardwareFingerprint(getCachedGpuTelemetry())).trim(),
    AI_WORKER_GPU_MODEL: String(getCachedGpuTelemetry().gpuName || 'NONE'),
    AI_WORKER_GPU_VRAM: String(getCachedGpuTelemetry().vramMb || 0),
    AI_WORKER_GPU_PCI_BUS: String(getCachedGpuTelemetry().pciBusId || 'NONE'),
    AI_WORKER_DEVICE_ID_FILE: path.join(app.getPath('userData'), 'ai-worker-device-id'),
    AI_WORKER_COUNTRY_CODE: String(config.countryCode || '').trim(),
    AI_WORKER_COUNTRY_NAME: String(config.countryName || '').trim(),
    AI_WORKER_REGION_NAME: String(config.regionName || '').trim(),
    AI_WORKER_LLM_PROVIDER: llmProvider,
    AI_WORKER_LLM_BASE_URL: normalizeOpenAICompatBaseUrl(config?.llmBaseUrl || DEFAULT_OPENAI_COMPAT_URL),
    AI_WORKER_LLM_MODEL: endpointGenModel,
    AI_WORKER_HARDWARE_TIER: String(hardwareTier),
    AI_WORKER_PREFERRED_GEN_MODEL: genModel,
    AI_WORKER_LLM_MAX_CONTEXT_TOKENS: String(workerMaxContext || 8192),
    AI_WORKER_LLM_API_KEY: String(config?.llmApiKey || '').trim(),
    AI_WORKER_OPENAI_COMPAT_ROLE_MODE: normalizeOpenAICompatRoleMode(config?.openAiCompatRoleMode),
    AI_WORKER_QVNC_ADDRESS: String(config?.qvncAddress || '').trim(),
    OLLAMA_BASE_URL: String(config.ollamaUrl || '').trim(),
    OLLAMA_MODEL: genModel,
    OLLAMA_GEN_MODEL: genModel,
    OLLAMA_EMBED_MODEL: embedModel,
    AI_WORKER_HEARTBEAT_INTERVAL_MS: String(config.heartbeatMs || 45000),
    AI_WORKER_POLL_INTERVAL_MS: String(config.pollMs || 6000),
    AI_WORKER_RUNTIME_POLICY_REFRESH_MS: String(process.env.AI_WORKER_RUNTIME_POLICY_REFRESH_MS || 60000),
  };

  workerProcess = spawn(process.execPath, [workerScript], {
    cwd: resolveRepoRoot(),
    env: childEnv,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  workerState = {
    running: true,
    pid: workerProcess.pid || null,
    startedAt: new Date().toISOString()
  };
  sendStatus();
  if (lifecycle) lifecycle.onWorkerStarted();
  sendLog('info', `Worker started (pid=${workerState.pid || 'n/a'})`);

  workerProcess.stdout.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (text) sendLog('info', text);
  });

  workerProcess.stderr.on('data', (chunk) => {
    const text = String(chunk || '').trim();
    if (!text) return;
    const level = /\bfatal\b/i.test(text) ? 'error' : 'warn';
    sendLog(level, text);
  });

  workerProcess.on('exit', (code, signal) => {
    sendLog('warn', `Worker stopped (code=${code}, signal=${signal || 'none'})`);
    sessionNodeToken = '';
    workerProcess = null;
    workerState = {
      running: false,
      pid: null,
      startedAt: null
    };
    sendStatus();
    if (lifecycle) {
      void lifecycle.onWorkerProcessExit(code, signal);
    }
  });
}

async function startWorker(config) {
  if (!requestWorkerStart) {
    requestWorkerStart = createWorkerStartGate({
      isRunning: () => Boolean(workerProcess || workerState?.running),
      startImpl: spawnWorkerProcess,
      onDebugLog: sendDebugLog,
    });
  }
  return requestWorkerStart(config || {});
}

function resolveAppIconPath() {
  const assetsRoot = app.isPackaged
    ? path.join(process.resourcesPath, 'assets')
    : path.join(__dirname, '..', 'assets');
  const icoPath = path.join(assetsRoot, 'app.ico');
  const pngPath = path.join(assetsRoot, 'app-icon.png');
  if (process.platform === 'win32' && fs.existsSync(icoPath)) {
    return icoPath;
  }
  if (fs.existsSync(pngPath)) return pngPath;
  if (fs.existsSync(icoPath)) return icoPath;
  return null;
}

function createWindow() {
  const iconPath = resolveAppIconPath();
  const isWin = process.platform === 'win32';
  mainWindow = new BrowserWindow({
    width: 1360,
    height: 800,
    minWidth: 1280,
    minHeight: 760,
    center: true,
    useContentSize: true,
    autoHideMenuBar: true,
    backgroundColor: '#0f1116',
    title: 'Quavence Worker',
    ...(isWin
      ? {
          titleBarStyle: 'hidden',
        }
      : {}),
    ...(iconPath ? { icon: iconPath } : {}),
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    }
  });

  // Strict Content-Security-Policy (CSP)
  mainWindow.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          "default-src 'self'; script-src 'self'; connect-src 'self' https://quavence.com https://*.quavence.com http://localhost:* http://127.0.0.1:*; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:;"
        ]
      }
    });
  });

  // Hide native menu bar to keep app-like UI surface.
  // On Windows/Linux it can still be toggled with Alt if needed.
  mainWindow.setMenuBarVisibility(false);
  mainWindow.setTitle('Quavence Worker');
  mainWindow.on('close', (event) => {
    if (!lifecycle || lifecycle.getIsQuitting()) return;
    const action = lifecycle.handleWindowCloseSync(event);
    if (action === 'hide' || action === 'quit') {
      void lifecycle.finalizeWindowClose(action);
    }
  });
  mainWindow.on('closed', () => {
    mainWindow = null;
  });
  mainWindow.on('maximize', () => {
    mainWindow?.webContents.send('window:state', { maximized: true });
  });
  mainWindow.on('unmaximize', () => {
    mainWindow?.webContents.send('window:state', { maximized: false });
  });

  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (isAllowedExternalUrl(url)) {
      void shell.openExternal(String(url));
    }
    return { action: 'deny' };
  });

  mainWindow.webContents.on('will-navigate', (event, navigationUrl) => {
    const parsed = String(navigationUrl || '').trim();
    if (parsed.startsWith('file://') || parsed.startsWith('http://localhost') || parsed.startsWith('http://127.0.0.1')) {
      return;
    }
    event.preventDefault();
    if (isAllowedExternalUrl(parsed)) {
      void shell.openExternal(parsed);
    }
  });

  const devServerUrl = process.env.ELECTRON_START_URL;
  if (!app.isPackaged && devServerUrl) {
    mainWindow.loadURL(devServerUrl);
    return;
  }

  mainWindow.loadFile(path.join(__dirname, '..', 'dist-renderer', 'index.html'));
}

function initLifecycleManager() {
  lifecycle = createAppLifecycleManager({
    app,
    Tray,
    Menu,
    nativeImage,
    Notification,
    getMainWindow: () => mainWindow,
    loadConfig,
    saveConfig,
    clearStoredToken,
    startWorker,
    stopWorkerInternal,
    sendStandbyBeacon,
    prepareRuntime,
    checkRuntime,
    fetchWorkerOverview,
    getStoredToken,
    getWorkerState: () => workerState,
    sendLog,
    safeSendToRenderer,
  });
}

function registerIpcHandlers() {
  ipcMain.handle('config:load', async () => loadConfig());
  ipcMain.handle('config:save', async (_event, config) => {
    const result = await saveConfig(config);
    return { ok: true, ...result };
  });
  ipcMain.handle('token:clear', async () => {
    await clearStoredToken();
    return { ok: true };
  });
  ipcMain.handle('runtime:check', async (_event, config) => {
    const runtime = await checkRuntime(config || {});
    return { ok: true, data: runtime };
  });
  ipcMain.handle('runtime:policy', async (_event, config) => {
    invalidateRuntimePolicyCache();
    const policy = await getCachedRuntimePolicy(config?.apiUrl);
    return { ok: true, data: policy };
  });
  ipcMain.handle('runtime:models', async (_event, config) => {
    const policy = await getCachedRuntimePolicy(config?.apiUrl);
    const effectiveConfig = applyPolicyToConfig(config || {}, policy);
    const provider = String(effectiveConfig?.llmProvider || DEFAULT_LLM_PROVIDER).trim().toLowerCase();
    let models = [];
    if (provider === 'openai_compat') {
      const llmBaseUrl = normalizeOpenAICompatBaseUrl(effectiveConfig?.llmBaseUrl || DEFAULT_OPENAI_COMPAT_URL);
      const llmApiKey = String(effectiveConfig?.llmApiKey || '').trim();
      if (!llmBaseUrl) return { ok: true, data: { generation: [], raw: [] } };
      models = await fetchOpenAICompatModels(llmBaseUrl, llmApiKey);
    } else {
      const ollamaUrl = String(effectiveConfig?.ollamaUrl || '').trim();
      if (!ollamaUrl) return { ok: true, data: { generation: [], raw: [] } };
      models = await fetchAvailableModels(ollamaUrl);
    }
    const hardwareTier = extractHardwareTier(policy);
    if (isPolicyEnforced(policy)) {
      const allowedList = [
        policy.generation_model,
        ...(Array.isArray(policy.allowed_generation_models) ? policy.allowed_generation_models : [])
      ].filter((m) => Boolean(m && String(m).trim()));
      const uniqueAllowed = Array.from(new Set(allowedList));
      return {
        ok: true,
        data: {
          generation: uniqueAllowed,
          raw: models || [],
          policyEnforced: true,
          hardware_tier: hardwareTier,
        },
      };
    }
    const allowedModels = (models || []).filter((name) => isSupportedGenModelForProvider(provider, name, policy));
    return {
      ok: true,
      data: {
        generation: allowedModels,
        raw: models || [],
        hardware_tier: hardwareTier,
      },
    };
  });
  ipcMain.handle('runtime:prepare', async (_event, payload) => {
    const result = await prepareRuntime(payload?.config || {});
    return result;
  });

  ipcMain.handle('worker:start', async (_event, config) => startWorker(config || {}));

  ipcMain.handle('worker:stop', async () => {
    stopWorkerInternal();
    return { ok: true };
  });

  ipcMain.handle('worker:status', async () => workerState);

  ipcMain.handle('worker:overview', async (_event, config) => {
    const result = await fetchWorkerOverview(config || {});
    return result;
  });

  ipcMain.handle('app:quit', async () => {
    if (lifecycle) {
      await lifecycle.quitAppFully();
    } else {
      try {
        await sendStandbyBeacon(null, 'Worker stopped by user');
      } catch {}
      stopWorkerInternal();
      app?.quit?.();
    }
    return { ok: true };
  });

  ipcMain.handle('app:show-window', async () => {
    lifecycle?.showMainWindow();
    return { ok: true };
  });

  ipcMain.handle('app:get-info', async () => ({
    name: app?.getName ? app.getName() : 'Quavence AI Worker',
    version: app?.getVersion ? app.getVersion() : '1.1.0',
    electronVersion: process.versions.electron || '',
    platform: process.platform,
  }));

  ipcMain.handle('window:minimize', async () => {
    mainWindow?.minimize();
    return { ok: true };
  });

  ipcMain.handle('window:maximize-toggle', async () => {
    if (!mainWindow) return { ok: false, maximized: false };
    if (mainWindow.isMaximized()) mainWindow.unmaximize();
    else mainWindow.maximize();
    return { ok: true, maximized: mainWindow.isMaximized() };
  });

  ipcMain.handle('window:close', async () => {
    mainWindow?.close();
    return { ok: true };
  });

  ipcMain.handle('window:is-maximized', async () => ({
    maximized: Boolean(mainWindow?.isMaximized()),
  }));

  ipcMain.handle('shell:open-external', async (_event, url) => {
    const target = String(url || '').trim();
    if (!isAllowedExternalUrl(target)) {
      return { ok: false, error: 'url_not_allowed' };
    }
    if (shell?.openExternal) {
      await shell.openExternal(target);
    }
    return { ok: true };
  });

  ipcMain.handle('app:update-tray-status', async (_event, payload) => {
    lifecycle?.setTrayHubStatus(payload?.hubState || 'unchecked');
    return { ok: true };
  });

  ipcMain.handle('app:get-tray-status', async () => {
    if (lifecycle?.getTrayStatus) {
      return lifecycle.getTrayStatus();
    }
    return {
      available: false,
      active: false,
      initialized: false,
      resolvedPath: '',
      iconExists: false,
      unavailableReason: 'Lifecycle not initialized',
      minimizeToTrayOnClose: true,
      launchAtStartup: false,
      startWorkerOnLaunch: false,
    };
  });
}

let standbyBeaconSentOnQuit = false;

if (app?.whenReady) {
  app.whenReady().then(async () => {
    initLifecycleManager();
    registerIpcHandlers();
    createWindow();
    try {
      await lifecycle.init();
    } catch (error) {
      sendLog('error', `Lifecycle init failed: ${error?.message || String(error)}`);
    }
  });
}

if (app?.on) {
  app.on('before-quit', (event) => {
    if (lifecycle) lifecycle.setQuitting(true);
    if (!standbyBeaconSentOnQuit && (workerProcess || workerState?.running || sessionNodeToken)) {
      event.preventDefault();
      standbyBeaconSentOnQuit = true;
      void (async () => {
        try {
          await sendStandbyBeacon(null, 'Worker stopped by user');
        } finally {
          stopWorkerInternal();
          app.quit();
        }
      })();
    }
  });

  app.on('window-all-closed', () => {
    if (lifecycle?.getIsQuitting()) return;
    // Keep app alive in tray; worker continues unless explicitly quit.
  });
}

if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    readQtWorkerDeviceIdFromRegistry,
    ensureWorkerDeviceId,
    sendStandbyBeacon,
    stopWorkerInternal,
    validateOllamaModelName,
  };
}

