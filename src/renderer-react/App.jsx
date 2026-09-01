import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildActivityFeed,
  buildWorkerProtectionRows,
  classifyLogFilter,
  resolveTasksDoneToday,
  deriveWorkerUiState,
  formatProviderLabel,
  formatTaskTypeLabel,
  formatQvncSettlementAmount,
  formatUsdRewardValue,
  hubStateLabel,
  inferHubStateFromLogLine,
  isHubAccessBlocked,
  isRuntimeConfigDirty,
  normalizeRewardAssetLabel,
  resolveWorkerProtectionBadge,
  truncateModelName,
  pickRuntimeConfig,
  shouldRefreshOverviewOnLogLine,
  resolveOverviewHubState,
  resolveDashboardAmbientState,
  parseProgressEvent,
} from './workerUiHelpers.js';
import {
  APP_BUILD_DATE,
  APP_DISPLAY_NAME,
  APP_VERSION_FALLBACK,
  WORKER_RELEASE_NOTES_URL,
} from './appBuildInfo.js';
import appLogoUrl from '../../assets/app-48.png';

const DEFAULT_CONFIG = {
  apiUrl: 'https://quavence.com',
  runtimeMode: 'managed',
  useStoredToken: false,
  onboardingCompleted: false,
  token: '',
  llmProvider: 'ollama',
  llmBaseUrl: 'http://localhost:1234/v1',
  llmApiKey: '',
  openAiCompatRoleMode: 'auto',
  genModel: 'qwen/qwen3-vl-8b',
  embedModel: 'nomic-embed-text',
  countryCode: '',
  countryName: '',
  regionName: '',
  ollamaUrl: 'http://localhost:11434',
  model: 'qwen/qwen3-vl-8b',
  heartbeatMs: 45000,
  pollMs: 6000,
  consents: {
    acceptLocalRuntime: false,
    acceptResourceUsage: false,
    acceptNetworkCalls: false
  },
  launchAtStartup: false,
  startWorkerOnLaunch: false,
  minimizeToTrayOnClose: true,
  showCloseToTrayHint: true,
  developerMode: false,
};
const OVERVIEW_REFRESH_MS = 45000;
const RUNTIME_REVALIDATE_MS = 12000;
const DEFAULT_REWARD_ASSET = 'QVNC';
const ALLOWED_GEN_MODELS_BY_PROVIDER = {
  ollama: ['phi3:latest'],
  openai_compat: ['qwen/qwen3-vl-8b', 'mistral-7b-instruct-v0.3', 'mistral:latest', 'phi3:latest', 'qwen2.5-7b-instruct', 'qwen2.5-coder-7b-instruct']
};

function getAllowedModelsForProvider(provider) {
  return ALLOWED_GEN_MODELS_BY_PROVIDER[String(provider || 'ollama').trim().toLowerCase()] || ALLOWED_GEN_MODELS_BY_PROVIDER.ollama;
}

function mergeConfigWithRuntimePolicy(baseConfig, policy) {
  const next = { ...(baseConfig || {}) };
  if (!policy?.enabled || policy.mode === 'off') return next;
  next.llmProvider = policy.provider;
  next.genModel = policy.generation_model;
  next.model = policy.generation_model;
  next.embedModel = policy.embedding_model;
  if (policy.provider === 'openai_compat') {
    const current = String(next.llmBaseUrl || '').trim();
    if (!current || current.includes(':11434')) {
      next.llmBaseUrl = 'http://localhost:1234/v1';
    }
  }
  return next;
}

function isRuntimePolicyEnforced(policy) {
  return Boolean(policy?.enabled && policy.mode !== 'off');
}

function isOpenAiCompatProvider(provider) {
  return String(provider || 'ollama').trim().toLowerCase() === 'openai_compat';
}

function staticFallbackEmbedModel(provider) {
  return isOpenAiCompatProvider(provider)
    ? 'text-embedding-nomic-embed-text-v2-moe'
    : 'nomic-embed-text';
}

function looksLikeEmbeddingModelId(id) {
  return /embed|embedding|nomic-embed|^e5|bge-|text-embedding/i.test(String(id || ''));
}

function PowerButtonSpinner() {
  return (
    <svg className="power-icon power-icon-spinner" viewBox="0 0 24 24" aria-hidden="true">
      <circle cx="12" cy="12" r="9" fill="none" stroke="currentColor" strokeWidth="2.5" opacity="0.25" />
      <path d="M21 12a9 9 0 0 0-9-9" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" />
    </svg>
  );
}

function PowerButtonIcon({ running, canStart, actionTarget }) {
  if (running) {
    return (
      <svg className="power-icon" viewBox="0 0 24 24" aria-hidden="true">
        <rect x="4" y="4" width="16" height="16" rx="2.5" fill="currentColor" />
      </svg>
    );
  }
  if (canStart) {
    return (
      <svg className="power-icon power-icon-play" viewBox="0 0 24 24" aria-hidden="true">
        <path d="M7 4v16l14-9L7 4z" fill="currentColor" />
      </svg>
    );
  }
  if (actionTarget === 'app-token' || actionTarget === 'token') {
    return (
      <svg className="power-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M9 3h6a1 1 0 0 1 1 1v1h2a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V7a2 2 0 0 1 2-2h2V4a1 1 0 0 1 1-1zm1 2v1h4V5h-4zM6 9v10h12V9H6zm3 2h6v2H9v-2zm0 4h6v2H9v-2z"
        />
      </svg>
    );
  }
  if (actionTarget === 'runtime') {
    return (
      <svg className="power-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M12 15.5A3.5 3.5 0 0 1 8.5 12 3.5 3.5 0 0 1 12 8.5a3.5 3.5 0 0 1 3.5 3.5 3.5 3.5 0 0 1-3.5 3.5zm7.43-2.3.95-.55a1 1 0 0 0 .37-1.36l-.95-1.65a6.9 6.9 0 0 0 0-2.28l.95-1.65a1 1 0 0 0-.37-1.36l-.95-.55a7 7 0 0 0-1.97-1.14l-.15-1.09A1 1 0 0 0 14.9 2h-1.8a1 1 0 0 0-.99.84l-.15 1.09a7 7 0 0 0-1.97 1.14l-.95.55a1 1 0 0 0-.37 1.36l.95 1.65a6.9 6.9 0 0 0 0 2.28l-.95 1.65a1 1 0 0 0 .37 1.36l.95.55a7 7 0 0 0 1.97 1.14l.15 1.09c.1.46.5.8.99.8h1.8c.49 0 .89-.34.99-.8l.15-1.09a7 7 0 0 0 1.97-1.14z"
        />
      </svg>
    );
  }
  if (actionTarget === 'open-external' || actionTarget === 'worker-page' || actionTarget === 'hub-suspended') {
    return (
      <svg className="power-icon" viewBox="0 0 24 24" aria-hidden="true">
        <path
          fill="currentColor"
          d="M14 3h7v7h-2V6.41l-7.79 7.79-1.41-1.41L17.59 5H14V3zM5 5h6V3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-6h-2v6H5V5z"
        />
      </svg>
    );
  }
  return (
    <svg className="power-icon power-icon-play" viewBox="0 0 24 24" aria-hidden="true">
      <path d="M7 4v16l14-9L7 4z" fill="currentColor" />
    </svg>
  );
}

/** Prefer a dedicated embed model; avoid picking the same id as generation when possible */
function pickDefaultEmbedModelId(candidateIds, generationModelId) {
  const ids = Array.isArray(candidateIds) ? candidateIds.map((s) => String(s || '').trim()).filter(Boolean) : [];
  if (!ids.length) return '';
  const gen = String(generationModelId || '').trim().toLowerCase();
  const byHeuristic = ids.find((id) => looksLikeEmbeddingModelId(id));
  if (byHeuristic) return byHeuristic;
  const notGen = ids.find((id) => String(id).trim().toLowerCase() !== gen);
  if (notGen) return notGen;
  return ids[0];
}

function buildEmbedModelOptionIds(provider, idsFromServer) {
  const sorted = [...new Set((idsFromServer || []).map((s) => String(s || '').trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b)
  );
  if (sorted.length) return sorted;
  return [staticFallbackEmbedModel(provider)];
}

function nowTime() {
  return new Date().toLocaleTimeString();
}

function formatLog(level, message) {
  return `[${nowTime()}] ${String(level || 'info').toUpperCase()} ${String(message || '')}`;
}

function formatStartedAt(value) {
  if (!value) return '-';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return String(value);
  return date.toLocaleString(undefined, {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  });
}

function resolveWorkerRewardAsset(overview) {
  return normalizeRewardAssetLabel(overview?.rewards?.asset, DEFAULT_REWARD_ASSET);
}

function CustomSelect({ value, options, onChange, id }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef(null);

  useEffect(() => {
    const onDocMouseDown = (event) => {
      if (!rootRef.current) return;
      if (!rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', onDocMouseDown);
    return () => document.removeEventListener('mousedown', onDocMouseDown);
  }, []);

  const selected = options.find((o) => o.value === value) || (value ? { value, label: value } : options[0]);

  return (
    <div className="custom-select" ref={rootRef} id={id}>
      <button
        type="button"
        className="custom-select-trigger"
        onClick={() => setOpen((s) => !s)}
      >
        <span>{selected?.label || String(value || '')}</span>
        <span className="custom-select-caret">v</span>
      </button>
      {open ? (
        <div className="custom-select-menu">
          {options.map((option) => (
            <button
              key={option.value}
              type="button"
              className={`custom-select-option ${option.value === value ? 'is-active' : ''}`}
              onClick={() => {
                onChange(option.value);
                setOpen(false);
              }}
            >
              {option.label}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export default function App() {
  const logsRef = useRef(null);

  const api = useMemo(() => window.workerDesktop || null, []);
  const [config, setConfig] = useState(DEFAULT_CONFIG);
  const [hasStoredToken, setHasStoredToken] = useState(false);
  const [bootstrapping, setBootstrapping] = useState(true);
  const [runtimeCheck, setRuntimeCheck] = useState(null);
  const [status, setStatus] = useState({ running: false, pid: null, startedAt: null });
  const [logs, setLogs] = useState([]);
  const [workerOverview, setWorkerOverview] = useState(null);
  const [availableModels, setAvailableModels] = useState([]);
  const [endpointRawModels, setEndpointRawModels] = useState([]);
  const [runtimePolicy, setRuntimePolicy] = useState(null);
  const [showDetectedModels, setShowDetectedModels] = useState(false);
  const [modelsLoading, setModelsLoading] = useState(false);
  const [logSourceFilter, setLogSourceFilter] = useState('all');
  const [showOnboarding, setShowOnboarding] = useState(false);
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [onboardingAnchorRect, setOnboardingAnchorRect] = useState(null);
  const [activeSection, setActiveSection] = useState('dashboard');
  const [uiVariant, setUiVariant] = useState('classic');
  const [hubState, setHubState] = useState('unchecked');
  const [lastHubSuccessAt, setLastHubSuccessAt] = useState(null);
  const [tokenReplaceMode, setTokenReplaceMode] = useState(false);
  const [focusTokenCard, setFocusTokenCard] = useState(false);
  const tokenCardRef = useRef(null);
  const [savedRuntimeConfig, setSavedRuntimeConfig] = useState(() => pickRuntimeConfig(DEFAULT_CONFIG));
  const [runtimeSavedNotice, setRuntimeSavedNotice] = useState(false);
  const [toasts, setToasts] = useState([]);
  const [trayStatus, setTrayStatus] = useState(null);
  const [appInfo, setAppInfo] = useState({ version: APP_VERSION_FALLBACK });
  const [startPending, setStartPending] = useState(false);
  const [startPhase, setStartPhase] = useState(null);
  const overviewRateLimitLogRef = useRef(0);
  const hubFailureStreakRef = useRef(0);
  const startInFlightRef = useRef(false);
  const overviewLoadInFlightRef = useRef(false);
  const lastOverviewRefreshTaskRef = useRef(null);
  const toastTimersRef = useRef(new Map());
  const toastDedupeRef = useRef(new Map());
  const toastedTaskIdsRef = useRef(new Set());
  const prevHubStateRef = useRef('unchecked');
  const logsLenForToastRef = useRef(0);
  const toastLogsSeededRef = useRef(false);
  const configRef = useRef(config);
  const runtimeRevalidateInFlightRef = useRef(false);
  const [appVisible, setAppVisible] = useState(() => (
    typeof document === 'undefined' ? true : !document.hidden
  ));

  const dismissToast = useCallback((id) => {
    setToasts((prev) => prev.filter((toast) => toast.id !== id));
    const state = toastTimersRef.current.get(id);
    if (state?.timer) window.clearTimeout(state.timer);
    toastTimersRef.current.delete(id);
  }, []);

  const scheduleToastDismiss = useCallback((id, remainingMs) => {
    const prev = toastTimersRef.current.get(id);
    if (prev?.timer) window.clearTimeout(prev.timer);
    const startedAt = Date.now();
    const timer = window.setTimeout(() => dismissToast(id), remainingMs);
    toastTimersRef.current.set(id, { timer, remainingMs, startedAt });
  }, [dismissToast]);

  const pauseToastTimer = useCallback((id) => {
    const state = toastTimersRef.current.get(id);
    if (!state?.timer) return;
    window.clearTimeout(state.timer);
    const elapsed = Date.now() - state.startedAt;
    const remainingMs = Math.max(3000, state.remainingMs - elapsed);
    toastTimersRef.current.set(id, { timer: null, remainingMs, startedAt: 0 });
  }, []);

  const resumeToastTimer = useCallback((id) => {
    const state = toastTimersRef.current.get(id);
    if (!state || state.timer) return;
    scheduleToastDismiss(id, state.remainingMs || 12000);
  }, [scheduleToastDismiss]);

  const pushToast = useCallback((toast) => {
    const dedupeKey = String(toast.dedupeKey || toast.text || '').trim();
    if (dedupeKey) {
      const lastAt = toastDedupeRef.current.get(dedupeKey) || 0;
      if (Date.now() - lastAt < 8000) return;
      toastDedupeRef.current.set(dedupeKey, Date.now());
    }
    const id = `toast-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`;
    const durationMs = toast.durationMs ?? (
      toast.tone === 'good' ? 14000
        : toast.tone === 'bad' || toast.tone === 'warn' ? 12000
          : 10000
    );
    const entry = {
      id,
      tone: toast.tone || 'neutral',
      text: String(toast.text || '').trim(),
      actionLabel: toast.actionLabel || null,
      actionKey: toast.actionKey || null,
      dedupeKey,
    };
    if (!entry.text) return;
    setToasts((prev) => {
      const withoutSame = dedupeKey
        ? prev.filter((item) => item.dedupeKey !== dedupeKey)
        : prev;
      return [...withoutSame, entry].slice(-3);
    });
    scheduleToastDismiss(id, durationMs);
  }, [scheduleToastDismiss]);

  const onboardingSteps = [
    {
      title: 'Step 1: Check Runtime',
      body: 'Click "Check Runtime" to verify local AI runtime and model are ready. Worker cannot process tasks until runtime is available.'
    },
    {
      title: 'Step 2: Paste Worker Token',
      body: 'Paste your node_token from the web Worker page. This token authorizes heartbeat, task claim, and task submit.'
    },
    {
      title: 'Step 3: Start Worker',
      body: 'Click "Start Worker" to launch the agent. Once running, it will poll tasks and execute them automatically.'
    },
    {
      title: 'Step 4: Verify Status',
      body: 'Confirm the dashboard shows Running, then watch Recent activity for task claimed and completed events.'
    }
  ];

  const getOnboardingAnchorId = (step) => {
    if (step === 0) return 'tour-check-runtime';
    if (step === 1) return 'tour-token';
    return 'tour-power';
  };

  const addLog = (level, message) => {
    const line = formatLog(level, message);
    setLogs((prev) => {
      const next = [...prev, line];
      return next.length > 2000 ? next.slice(next.length - 2000) : next;
    });
  };

  const updateConfig = (key, value) => {
    setConfig((prev) => ({ ...prev, [key]: value }));
  };

  const handleSave = async ({ runtimeOnly = false } = {}) => {
    if (!api) return;
    const nextConfig = {
      ...config,
      apiUrl: 'https://quavence.com',
      useStoredToken: hasStoredToken || config.useStoredToken
    };
    const result = await api.saveConfig(nextConfig);
    if (String(config.token || '').trim()) {
      setConfig((prev) => ({ ...prev, token: '' }));
      setHasStoredToken(Boolean(result?.storedToken));
      setTokenReplaceMode(false);
      setHubState('unchecked');
      hubFailureStreakRef.current = 0;
      if (!result?.storedToken) {
        addLog('warn', 'Secure token storage unavailable; token was not persisted');
      }
    }
    if (runtimeOnly || !String(config.token || '').trim()) {
      setSavedRuntimeConfig(pickRuntimeConfig(nextConfig));
      setRuntimeSavedNotice(true);
      window.setTimeout(() => setRuntimeSavedNotice(false), 2500);
    }
    addLog('info', runtimeOnly ? 'Runtime settings saved' : 'Config saved');
  };

  const handleForgetToken = async () => {
    if (!api) return;
    await api.clearStoredToken();
    setHasStoredToken(false);
    setConfig((prev) => ({ ...prev, token: '', useStoredToken: false }));
    setTokenReplaceMode(false);
    setHubState('unchecked');
    hubFailureStreakRef.current = 0;
    setWorkerOverview(null);
    if (status?.running) {
      await api.stopWorker();
    }
    addLog('warn', 'Saved worker token removed from this device');
  };

  const completeOnboarding = async () => {
    setShowOnboarding(false);
    setOnboardingStep(0);
    if (!api) return;
    try {
      const nextConfig = { ...config, onboardingCompleted: true };
      setConfig(nextConfig);
      await api.saveConfig(nextConfig);
    } catch (error) {
      addLog('warn', `Failed to persist onboarding flag: ${error?.message || String(error)}`);
    }
  };

  const handleStart = async () => {
    if (startInFlightRef.current || startPending || status?.running) return;

    const trimmedAddress = String(config.qvncAddress || '').trim();
    if (!trimmedAddress || !trimmedAddress.startsWith('S') || trimmedAddress.length < 26) {
      addLog('error', 'Start blocked: Native Quavence payout address is required. Please set it in the App tab.');
      setActiveSection('app');
      return;
    }

    startInFlightRef.current = true;
    try {
      if (!api) return;
      setStartPending(true);
      setStartPhase('checking_runtime');

      let useStoredToken = hasStoredToken || config.useStoredToken;
      if (String(config.token || '').trim()) {
        const saveResult = await api.saveConfig({
          ...config,
          apiUrl: 'https://quavence.com',
          useStoredToken: true,
        });
        useStoredToken = Boolean(saveResult?.storedToken) || useStoredToken;
        setHasStoredToken(useStoredToken);
        setConfig((prev) => ({ ...prev, token: '', useStoredToken }));
        setTokenReplaceMode(false);
        setHubState('unchecked');
        hubFailureStreakRef.current = 0;
      }
      let nextConfig = {
        ...config,
        apiUrl: 'https://quavence.com',
        useStoredToken,
        token: '',
      };
      const policy = await loadRuntimePolicy(nextConfig);
      if (policy) {
        nextConfig = mergeConfigWithRuntimePolicy(nextConfig, policy);
        setConfig(nextConfig);
      }

      const prepared = await api.prepareRuntime({
        config: nextConfig
      });
      if (!prepared?.ok) {
        if (prepared?.runtime) setRuntimeCheck(prepared.runtime);
        addLog('error', prepared?.reason || 'Runtime preparation failed');
        setStartPending(false);
        setStartPhase(null);
        startInFlightRef.current = false;
        return;
      }
      setRuntimeCheck(prepared.runtime || null);

      setStartPhase('starting_worker');
      const result = await api.saveConfig(nextConfig);
      const startResult = await api.startWorker(nextConfig);
      if (startResult?.alreadyRunning) {
        setStartPending(false);
        setStartPhase(null);
        startInFlightRef.current = false;
      }
      if (String(config.token || '').trim()) {
        setConfig((prev) => ({ ...prev, token: '' }));
        setHasStoredToken(Boolean(result?.storedToken));
        if (!result?.storedToken) {
          addLog('warn', 'Started with session token only (not stored in keychain)');
        }
      }
    } catch (error) {
      addLog('error', error?.message || String(error));
      setStartPending(false);
      setStartPhase(null);
      startInFlightRef.current = false;
    }
  };

  const loadRuntimePolicy = async (nextConfig) => {
    if (!api?.getRuntimePolicy) return null;
    const result = await api.getRuntimePolicy({ apiUrl: nextConfig?.apiUrl || DEFAULT_CONFIG.apiUrl });
    const policy = result?.data || null;
    setRuntimePolicy(policy);
    return policy;
  };

  const handleCheckRuntime = async () => {
    if (!api) return;
    const result = await api.checkRuntime(config);
    setRuntimeCheck(result?.data || null);
    if (String(config?.llmProvider || 'ollama') === 'openai_compat') {
      addLog(
        'info',
        `Runtime check: openai_compat=${result?.data?.openaiCompatReachable ? 'ok' : 'fail'}, gen=${result?.data?.generationModelAvailable ? 'ok' : 'fail'}, embed=${result?.data?.embeddingModelAvailable ? 'ok' : 'fail'}`
      );
    } else {
      addLog(
        'info',
        `Runtime check: ollama=${result?.data?.ollamaReachable ? 'ok' : 'fail'}, gen=${result?.data?.generationModelAvailable ? 'ok' : 'fail'}, embed=${result?.data?.embeddingModelAvailable ? 'ok' : 'fail'}`
      );
    }
  };

  const handleStop = async () => {
    if (!api) return;
    await api.stopWorker();
    addLog('warn', 'Stop requested');
  };

  const handleToggleAppSetting = async (key) => {
    const current = config[key];
    const nextValue = key === 'minimizeToTrayOnClose' || key === 'showCloseToTrayHint'
      ? current === false
      : !current;
    const nextConfig = { ...config, [key]: nextValue };
    setConfig(nextConfig);
    if (key === 'developerMode' && !nextValue && activeSection === 'debug') {
      setActiveSection('dashboard');
    }
    if (!api) return;
    await api.saveConfig({
      ...nextConfig,
      apiUrl: 'https://quavence.com',
      useStoredToken: hasStoredToken || config.useStoredToken,
      token: '',
    });
    addLog('info', 'App settings saved');
  };

  const handleQuit = async () => {
    if (!api) return;
    await api.quitApp();
  };

  const handleShowTutorial = () => {
    setOnboardingStep(0);
    setShowOnboarding(true);
  };

  const loadRuntimeModels = async () => {
    if (!api) return;
    setModelsLoading(true);
    try {
      const result = await api.getRuntimeModels(config);
      const payload = result?.data;
      const generation = Array.isArray(payload?.generation)
        ? payload.generation
        : Array.isArray(payload)
          ? payload
          : [];
      const raw = Array.isArray(payload?.raw) ? payload.raw : generation;
      setAvailableModels(generation);
      setEndpointRawModels(raw);
    } catch {
      setAvailableModels([]);
      setEndpointRawModels([]);
    } finally {
      setModelsLoading(false);
    }
  };

  const loadWorkerOverview = async () => {
    if (!api || overviewLoadInFlightRef.current) return;
    overviewLoadInFlightRef.current = true;
    try {
      const result = await api.getWorkerOverview(config);
      const hubUpdate = resolveOverviewHubState(result, hubFailureStreakRef.current);
      hubFailureStreakRef.current = hubUpdate.failureStreak;
      setHubState(hubUpdate.hubState);

      if (result?.ok) {
        setWorkerOverview(result.data || null);
        setLastHubSuccessAt(new Date());
        return;
      }

      if (hubUpdate.hubState === 'token_invalid' || isHubAccessBlocked(hubUpdate.hubState)) {
        setWorkerOverview(result?.ok ? result.data || null : null);
      }

      if (result?.rateLimited || String(result?.error || '').includes('429')) {
        const now = Date.now();
        if (now - overviewRateLimitLogRef.current > 5 * 60 * 1000) {
          overviewRateLimitLogRef.current = now;
          addLog('info', 'Overview temporarily rate-limited; worker status will refresh later');
        }
        return;
      }

      addLog('warn', `Overview failed: ${result?.error}`);
    } catch (error) {
      const hubUpdate = resolveOverviewHubState({ ok: false, error: error?.message }, hubFailureStreakRef.current);
      hubFailureStreakRef.current = hubUpdate.failureStreak;
      setHubState(hubUpdate.hubState);
      addLog('error', `Overview error: ${error?.message}`);
    } finally {
      overviewLoadInFlightRef.current = false;
    }
  };

  useEffect(() => {
    if (!api) {
      setBootstrapping(false);
      return;
    }

    let mounted = true;

    (async () => {
      try {
        const loadedConfig = await api.loadConfig();
        let mergedConfig = null;
        if (mounted && loadedConfig) {
          mergedConfig = {
            ...DEFAULT_CONFIG,
            ...loadedConfig,
            apiUrl: 'https://quavence.com',
            useStoredToken: Boolean(loadedConfig?.hasStoredToken) || Boolean(loadedConfig?.useStoredToken)
          };
          setConfig(mergedConfig);
          setHasStoredToken(Boolean(loadedConfig?.hasStoredToken));
          const policy = await loadRuntimePolicy(mergedConfig);
          if (policy) {
            mergedConfig = mergeConfigWithRuntimePolicy(mergedConfig, policy);
            if (mounted) setConfig(mergedConfig);
          }
          setSavedRuntimeConfig(pickRuntimeConfig(mergedConfig));
          if (!loadedConfig?.onboardingCompleted) {
            setShowOnboarding(true);
          }
          const runtimeResult = await api.checkRuntime(mergedConfig);
          if (mounted) {
            setRuntimeCheck(runtimeResult?.data || null);
          }
          if (runtimeResult?.data?.ollamaReachable || runtimeResult?.data?.openaiCompatReachable) {
            void loadRuntimeModels();
          }
        }
        const workerStatus = await api.getStatus();
        if (mounted && workerStatus) {
          setStatus(workerStatus);
          if (workerStatus.running || mergedConfig?.hasStoredToken) {
            loadWorkerOverview();
          }
        }
      } catch (error) {
        addLog('error', error?.message || String(error));
      } finally {
        if (mounted) setBootstrapping(false);
      }
    })();

    const unsubscribeLog = api.onLog((payload) => {
      addLog(payload?.level || 'info', payload?.message || '');
    });

    const unsubscribeStatus = api.onStatus((payload) => {
      setStatus(payload || { running: false, pid: null, startedAt: null });
      // Reload overview when worker status changes
      if (payload?.running) {
        loadWorkerOverview();
      }
    });

    return () => {
      mounted = false;
      if (typeof unsubscribeLog === 'function') unsubscribeLog();
      if (typeof unsubscribeStatus === 'function') unsubscribeStatus();
    };
  }, [api]);

  useEffect(() => {
    if (status?.running) {
      setStartPending(false);
      setStartPhase(null);
      startInFlightRef.current = false;
      return;
    }
    lastOverviewRefreshTaskRef.current = null;
  }, [status?.running]);

  useEffect(() => {
    if (!api || !status?.running || !appVisible) {
      return;
    }
    void loadWorkerOverview();
    const overviewInterval = setInterval(() => {
      void loadWorkerOverview();
    }, OVERVIEW_REFRESH_MS);
    return () => clearInterval(overviewInterval);
  }, [api, status?.running, appVisible, config.apiUrl, config.useStoredToken, config.token]);

  useEffect(() => {
    configRef.current = config;
  }, [config]);

  useEffect(() => {
    if (!api?.checkRuntime || status?.running || !appVisible) return;
    const revalidate = async () => {
      if (runtimeRevalidateInFlightRef.current) return;
      runtimeRevalidateInFlightRef.current = true;
      try {
        const result = await api.checkRuntime(configRef.current);
        if (result?.data) setRuntimeCheck(result.data);
      } catch {
        // silent: manual "Check runtime" surfaces details
      } finally {
        runtimeRevalidateInFlightRef.current = false;
      }
    };
    const runtimeInterval = setInterval(() => { void revalidate(); }, RUNTIME_REVALIDATE_MS);
    return () => clearInterval(runtimeInterval);
  }, [api, status?.running, appVisible]);

  useEffect(() => {
    const onVisibilityChange = () => {
      setAppVisible(!document.hidden);
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => document.removeEventListener('visibilitychange', onVisibilityChange);
  }, []);

  useEffect(() => {
    if (!logs.length || !status?.running) return;
    const latest = logs[logs.length - 1];
    const refreshDecision = shouldRefreshOverviewOnLogLine(latest, lastOverviewRefreshTaskRef.current);
    if (!refreshDecision.refresh) return;
    lastOverviewRefreshTaskRef.current = refreshDecision.taskId;
    void loadWorkerOverview();
  }, [logs, status?.running]);

  useEffect(() => {
    if (!logs.length) return;
    const latest = logs[logs.length - 1];
    const inferred = inferHubStateFromLogLine(latest);
    if (!inferred) return;
    if (inferred === 'online') {
      setHubState('online');
      hubFailureStreakRef.current = 0;
      return;
    }
    if (inferred === 'token_invalid') {
      setHubState('token_invalid');
      hubFailureStreakRef.current = 0;
      return;
    }
    if (
      inferred === 'hub_suspended'
      || String(inferred || '').startsWith('hub_suspended_')
      || inferred === 'terms_required'
      || inferred === 'runtime_blocked'
    ) {
      setHubState(inferred === 'runtime_blocked' ? 'hub_suspended_runtime_policy' : inferred);
      hubFailureStreakRef.current = 0;
      return;
    }
    if (inferred === 'duplicate_blocked' || inferred === 'waiting' || inferred === 'throttled') {
      if (status?.running) {
        setHubState(inferred);
      }
      return;
    }
    if (inferred === 'retrying' && (hubState === 'online' || hubState === 'waiting')) {
      setHubState('retrying');
    }
  }, [logs, hubState, status?.running]);

  useEffect(() => {
    if (hubState !== 'token_invalid' || !status?.running || !api) return;
    void (async () => {
      await api.stopWorker();
      addLog('warn', 'Worker stopped because token is invalid');
    })();
  }, [hubState, status?.running, api]);

  useEffect(() => {
    const hubSuspended = hubState === 'hub_suspended' || String(hubState || '').startsWith('hub_suspended_');
    if (!hubSuspended || !status?.running || !api) return;
    void (async () => {
      await api.stopWorker();
      const reason = workerOverview?.suspension?.reason || 'Hub suspended worker access';
      addLog('warn', `Worker stopped: ${reason}`);
    })();
  }, [hubState, workerOverview?.suspension?.reason, status?.running, api]);

  useEffect(() => {
    if (hubState !== 'terms_required' || !status?.running || !api) return;
    void (async () => {
      await api.stopWorker();
      addLog('warn', 'Worker stopped: accept updated worker terms in the web app');
    })();
  }, [hubState, status?.running, api]);

  useEffect(() => {
    if (!logsRef.current) return;
    logsRef.current.scrollTop = logsRef.current.scrollHeight;
  }, [logSourceFilter, logs]);

  useEffect(() => {
    if (!api) return;
    if (String(config?.llmProvider || 'ollama') === 'openai_compat' && !config.llmBaseUrl) return;
    if (String(config?.llmProvider || 'ollama') !== 'openai_compat' && !config.ollamaUrl) return;
    const timer = setTimeout(() => {
      void loadRuntimeModels();
    }, 500);
    return () => clearTimeout(timer);
  }, [api, config.ollamaUrl, config.llmBaseUrl, config.llmProvider, config.llmApiKey]);

  useEffect(() => {
    if (!api?.updateTrayHubStatus) return;
    void api.updateTrayHubStatus({ hubState });
  }, [api, hubState]);

  useEffect(() => {
    if (!api?.showWindow || hubState !== 'token_invalid') return;
    void api.showWindow();
  }, [api, hubState]);

  useEffect(() => {
    if (!api?.onCloseToTrayHint) return;
    const unsubscribe = api.onCloseToTrayHint((payload) => {
      const message = String(payload?.message || 'Quavence AI Worker is still running in the tray.');
      pushToast({
        tone: 'neutral',
        text: message,
        dedupeKey: 'close-to-tray',
        durationMs: 10000,
      });
      addLog('info', message);
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [api, pushToast]);

  useEffect(() => {
    if (!api?.onLifecycleEvent) return;
    const unsubscribe = api.onLifecycleEvent((payload) => {
      if (payload?.type !== 'worker_fatal') return;
      if (payload?.reason === 'invalid_token') {
        setHubState('token_invalid');
        void api.showWindow?.();
        return;
      }
      if (payload?.reason === 'hub_suspended') {
        setHubState('hub_suspended');
        void api.showWindow?.();
        return;
      }
      if (payload?.reason === 'terms_required') {
        setHubState('terms_required');
        void api.showWindow?.();
        return;
      }
      if (payload?.reason === 'runtime') {
        pushToast({
          tone: 'warn',
          text: 'Worker stopped: runtime issue. Check approved models and endpoint.',
          actionLabel: 'Open Runtime',
          actionKey: 'runtime',
          dedupeKey: 'runtime_stop',
        });
        void api.showWindow?.();
        return;
      }
      if (payload?.reason === 'crashed') {
        pushToast({
          tone: 'warn',
          text: 'Worker stopped after repeated retries. Review activity or Debug logs.',
          actionLabel: 'Activity',
          actionKey: 'activity',
          dedupeKey: 'worker_crashed',
        });
        void api.showWindow?.();
      }
    });
    return () => {
      if (typeof unsubscribe === 'function') unsubscribe();
    };
  }, [api, pushToast]);

  useEffect(() => {
    const prev = prevHubStateRef.current;
    if (prev === hubState) return;
    prevHubStateRef.current = hubState;

    if (hubState === 'token_invalid') {
      pushToast({
        tone: 'bad',
        text: 'Worker token is invalid. Replace it to reconnect.',
        actionLabel: 'Replace token',
        actionKey: 'replace-token',
        dedupeKey: 'token_invalid',
      });
      return;
    }

    if (hubState === 'terms_required') {
      pushToast({
        tone: 'warn',
        text: 'Accept updated worker terms to continue earning.',
        actionLabel: 'Open Worker page',
        actionKey: 'worker-page',
        dedupeKey: 'terms_required',
      });
      return;
    }

    if (hubState === 'hub_suspended_runtime_policy') {
      pushToast({
        tone: 'warn',
        text: 'Runtime blocked by Hub policy. Fix approved models to continue.',
        actionLabel: 'Open Runtime',
        actionKey: 'runtime',
        dedupeKey: 'runtime_blocked',
      });
      return;
    }

    if (hubState === 'hub_suspended' || String(hubState || '').startsWith('hub_suspended_')) {
      pushToast({
        tone: 'bad',
        text: workerOverview?.suspension?.reason || 'Hub suspended worker access.',
        actionLabel: 'Open Worker page',
        actionKey: 'worker-page',
        dedupeKey: 'hub_suspended',
      });
    }
  }, [hubState, workerOverview?.suspension?.reason, pushToast]);

  const openAppTokenCard = useCallback(({ replace = false } = {}) => {
    setActiveSection('app');
    setTokenReplaceMode(replace);
    setFocusTokenCard(true);
  }, []);

  const handleToastAction = useCallback((actionKey) => {
    if (actionKey === 'replace-token') {
      openAppTokenCard({ replace: true });
      return;
    }
    if (actionKey === 'runtime') {
      setActiveSection('runtime');
      return;
    }
    if (actionKey === 'activity') {
      setActiveSection('activity');
      return;
    }
    if (actionKey === 'worker-page') {
      const url = `${String(config.apiUrl || DEFAULT_CONFIG.apiUrl).replace(/\/+$/, '')}/worker`;
      void api?.openExternal?.(url);
    }
  }, [api, config.apiUrl, openAppTokenCard]);

  useEffect(() => {
    if (!focusTokenCard || activeSection !== 'app') return undefined;
    const timer = window.setTimeout(() => {
      tokenCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
      if (tokenReplaceMode || !hasStoredToken) {
        document.getElementById('token')?.focus?.();
      }
      setFocusTokenCard(false);
    }, 80);
    return () => window.clearTimeout(timer);
  }, [focusTokenCard, activeSection, tokenReplaceMode, hasStoredToken]);

  useEffect(() => {
    if (!showOnboarding) return;
    if (onboardingStep === 1) {
      setActiveSection('app');
      setTokenReplaceMode(!hasStoredToken);
    } else if (onboardingStep === 0) {
      setActiveSection('runtime');
    } else if (onboardingStep >= 2) {
      setActiveSection('dashboard');
    }
  }, [showOnboarding, onboardingStep, hasStoredToken]);

  useEffect(() => {
    if (!api?.getTrayStatus) return;
    if (activeSection !== 'app' && activeSection !== 'debug') return;
    void (async () => {
      try {
        const status = await api.getTrayStatus();
        setTrayStatus(status || null);
      } catch {
        setTrayStatus(null);
      }
    })();
  }, [api, activeSection]);

  useEffect(() => {
    if (!api?.getAppInfo) return;
    void api.getAppInfo().then((info) => {
      if (info) {
        setAppInfo((prev) => ({ ...prev, ...info }));
      }
    }).catch(() => {});
  }, [api]);

  const [windowMaximized, setWindowMaximized] = useState(false);
  useEffect(() => {
    if (!api?.windowIsMaximized) return undefined;
    void api.windowIsMaximized().then((result) => {
      setWindowMaximized(Boolean(result?.maximized));
    }).catch(() => {});
    if (!api.onWindowState) return undefined;
    return api.onWindowState((payload) => {
      setWindowMaximized(Boolean(payload?.maximized));
    });
  }, [api]);

  const showWindowControls = appInfo.platform === 'win32' || (!appInfo.platform && typeof navigator !== 'undefined' && /Windows/i.test(navigator.userAgent));

  const statusText = status?.running ? 'Running' : 'Stopped';
  const hasTokenInput = Boolean(String(config.token || '').trim());
  const hasUsableToken = hasTokenInput || hasStoredToken;
  const workerPageUrl = `${String(config.apiUrl || DEFAULT_CONFIG.apiUrl).replace(/\/+$/, '')}/worker`;
  const hubEndpoint = config.apiUrl || DEFAULT_CONFIG.apiUrl;
  const hubHost = useMemo(() => {
    try {
      return new URL(hubEndpoint).host;
    } catch {
      return String(hubEndpoint || '').replace(/^https?:\/\//, '');
    }
  }, [hubEndpoint]);
  const appVersionLabel = appInfo.version || APP_VERSION_FALLBACK;
  const appBuildLabel = APP_BUILD_DATE === 'dev' ? ' (dev)' : ` (build ${APP_BUILD_DATE})`;
  const hubSuspension = workerOverview?.suspension || null;

  const openExternalUrl = useCallback(async (url) => {
    const target = String(url || workerPageUrl).trim();
    if (!target) return;
    if (api?.openExternal) {
      await api.openExternal(target);
      return;
    }
    window.open(target, '_blank', 'noopener,noreferrer');
  }, [api, workerPageUrl]);

  const providerLabel = formatProviderLabel(config.llmProvider);
  const embedReady = isOpenAiCompatProvider(config.llmProvider)
    ? Boolean(runtimeCheck?.embeddingModelAvailable ?? runtimeCheck?.generationModelAvailable)
    : Boolean(runtimeCheck?.embeddingModelAvailable);
  const modelReady = Boolean(runtimeCheck?.generationModelAvailable)
    && !runtimeCheck?.runtimePolicyBlocked
    && embedReady;
  const runtimeReachableForStart = isOpenAiCompatProvider(config.llmProvider)
    ? Boolean(runtimeCheck?.openaiCompatReachable)
    : Boolean(runtimeCheck?.ollamaReachable);

  const hasUsableAddress = Boolean(String(config.qvncAddress || '').trim())
    && String(config.qvncAddress).trim().startsWith('S')
    && String(config.qvncAddress).trim().length >= 26;

  const canStart = Boolean(hasUsableToken)
    && Boolean(hasUsableAddress)
    && !isHubAccessBlocked(hubState)
    && !status?.running
    && !startPending
    && Boolean(runtimeCheck)
    && runtimeReachableForStart
    && modelReady;
  const canSaveToken = hasTokenInput && !status?.running;
  const isLastOnboardingStep = onboardingStep >= onboardingSteps.length - 1;
  const filteredLogs = useMemo(() => {
    return logs.filter((line) => classifyLogFilter(line, logSourceFilter));
  }, [logs, logSourceFilter]);

  const rewardAsset = useMemo(
    () => resolveWorkerRewardAsset(workerOverview),
    [workerOverview]
  );
  const policyEnforced = isRuntimePolicyEnforced(runtimePolicy);
  const providerAllowedModels = useMemo(
    () => (policyEnforced
      ? [runtimePolicy.generation_model].filter(Boolean)
      : getAllowedModelsForProvider(config.llmProvider || 'ollama')),
    [config.llmProvider, policyEnforced, runtimePolicy]
  );
  const selectedGenModel = String(config.genModel || config.model || '').trim();
  const effectiveGenModel = providerAllowedModels.includes(selectedGenModel)
    ? selectedGenModel
    : providerAllowedModels[0];

  useEffect(() => {
    if (policyEnforced) return;
    if (selectedGenModel && providerAllowedModels.includes(selectedGenModel)) return;
    const fallbackModel = providerAllowedModels[0];
    if (!fallbackModel) return;
    updateConfig('genModel', fallbackModel);
    updateConfig('model', fallbackModel);
  }, [selectedGenModel, providerAllowedModels, policyEnforced]);

  const embedOptionIds = useMemo(
    () => (policyEnforced
      ? [runtimePolicy.embedding_model].filter(Boolean)
      : buildEmbedModelOptionIds(config.llmProvider || 'ollama', endpointRawModels)),
    [config.llmProvider, endpointRawModels, policyEnforced, runtimePolicy]
  );

  const selectedEmbedModel = String(config.embedModel || '').trim();
  const effectiveEmbedModel = useMemo(() => {
    if (embedOptionIds.includes(selectedEmbedModel)) return selectedEmbedModel;
    return pickDefaultEmbedModelId(embedOptionIds, effectiveGenModel) || embedOptionIds[0] || '';
  }, [embedOptionIds, selectedEmbedModel, effectiveGenModel]);

  useEffect(() => {
    if (policyEnforced) return;
    if (!effectiveEmbedModel) return;
    if (selectedEmbedModel === effectiveEmbedModel) return;
    updateConfig('embedModel', effectiveEmbedModel);
  }, [effectiveEmbedModel, selectedEmbedModel, policyEnforced]);

  const currentTask = useMemo(() => {
    const done = new Set();
    for (let i = logs.length - 1; i >= 0; i -= 1) {
      const line = String(logs[i] || '');
      const completed = line.match(/task completed:\s*([a-f0-9-]+)/i);
      if (completed) {
        done.add(completed[1]);
        continue;
      }
      const failed = line.match(/task failed:\s*([a-f0-9-]+)/i);
      if (failed) {
        done.add(failed[1]);
        continue;
      }
      const claimed = line.match(/task claimed:\s*([a-f0-9-]+)\s*\(([^)]+)\)/i);
      if (claimed && !done.has(claimed[1])) {
        return { id: claimed[1], type: claimed[2] };
      }
    }
    return null;
  }, [logs]);

  useEffect(() => {
    if (!toastLogsSeededRef.current) {
      toastLogsSeededRef.current = true;
      logsLenForToastRef.current = logs.length;
      return;
    }
    if (!logs.length) {
      logsLenForToastRef.current = 0;
      return;
    }
    if (logs.length < logsLenForToastRef.current) {
      logsLenForToastRef.current = logs.length;
      return;
    }
    if (logs.length === logsLenForToastRef.current) return;
    const newLines = logs.slice(logsLenForToastRef.current);
    logsLenForToastRef.current = logs.length;
    for (const line of newLines) {
      const parsed = parseProgressEvent(line);
      if (parsed?.kind !== 'task_completed') continue;
      const taskId = String(parsed.taskId || parsed.label || '').trim();
      if (!taskId || toastedTaskIdsRef.current.has(taskId)) continue;
      toastedTaskIdsRef.current.add(taskId);
      if (toastedTaskIdsRef.current.size > 80) {
        toastedTaskIdsRef.current = new Set([...toastedTaskIdsRef.current].slice(-40));
      }
      pushToast({
        tone: 'good',
        text: parsed.label || 'Task completed',
        actionLabel: 'Activity',
        actionKey: 'activity',
        dedupeKey: `task-completed-${taskId}`,
        durationMs: 14000,
      });
    }
  }, [logs, pushToast]);

  useEffect(() => {
    if (!showOnboarding) {
      setOnboardingAnchorRect(null);
      return;
    }

    const updateAnchorRect = () => {
      const anchorId = getOnboardingAnchorId(onboardingStep);
      const el = document.getElementById(anchorId);
      if (!el) {
        setOnboardingAnchorRect(null);
        return;
      }
      const rect = el.getBoundingClientRect();
      setOnboardingAnchorRect({
        top: rect.top,
        left: rect.left,
        width: rect.width,
        height: rect.height,
        right: rect.right,
        bottom: rect.bottom
      });
    };

    updateAnchorRect();
    window.addEventListener('resize', updateAnchorRect);
    window.addEventListener('scroll', updateAnchorRect, true);
    return () => {
      window.removeEventListener('resize', updateAnchorRect);
      window.removeEventListener('scroll', updateAnchorRect, true);
    };
  }, [showOnboarding, onboardingStep]);

  const getOnboardingPopoverStyle = () => {
    const viewportPadding = 16;
    const estimatedWidth = 460;
    const estimatedHeight = 220;
    const gap = 12;

    if (!onboardingAnchorRect) {
      return {
        top: '50%',
        left: '50%',
        transform: 'translate(-50%, -50%)'
      };
    }

    const vw = window.innerWidth || 1360;
    const vh = window.innerHeight || 860;

    let left = onboardingAnchorRect.left;
    let top = onboardingAnchorRect.bottom + gap;

    if (left + estimatedWidth > vw - viewportPadding) {
      left = Math.max(viewportPadding, vw - estimatedWidth - viewportPadding);
    }
    if (top + estimatedHeight > vh - viewportPadding) {
      top = Math.max(viewportPadding, onboardingAnchorRect.top - estimatedHeight - gap);
    }

    return {
      top: `${top}px`,
      left: `${left}px`
    };
  };

  const uiState = useMemo(
    () =>
      deriveWorkerUiState({
        hasUsableToken,
        hasUsableAddress,
        runtimeCheck,
        llmProvider: config.llmProvider,
        status,
        currentTask,
        logs,
        hubState,
        suspension: hubSuspension,
        workerPageUrl,
        startPending,
        startPhase,
        bootstrapping,
      }),
    [hasUsableToken, hasUsableAddress, runtimeCheck, config.llmProvider, status, currentTask, logs, hubState, hubSuspension, workerPageUrl, startPending, startPhase, bootstrapping]
  );
  const dashboardAmbientState = useMemo(
    () => resolveDashboardAmbientState({
      uiState,
      startPending,
      currentTask,
      status,
    }),
    [uiState, startPending, currentTask, status],
  );
  const todayTasks = useMemo(
    () => resolveTasksDoneToday(workerOverview, logs),
    [workerOverview, logs],
  );
  const pousBoostPercent = useMemo(() => {
    if (!status?.running) return 0;
    if (todayTasks >= 10) return 50;
    if (todayTasks >= 5) return 35;
    if (todayTasks >= 1) return 20;
    return 0;
  }, [status?.running, todayTasks]);
  const totalTasks = workerOverview?.tasks?.done ?? 0;
  const accruedTotal = workerOverview?.rewards?.accrued_amount ?? 0;
  const heldTotal = workerOverview?.rewards?.accrued_held_amount ?? 0;
  const rejectedTotal = workerOverview?.rewards?.accrued_rejected_amount ?? 0;
  const showAccruedBreakdown = Number(heldTotal) > 0 || Number(rejectedTotal) > 0;
  const paidTotal = workerOverview?.rewards?.paid_amount ?? 0;
  const pendingPayouts = workerOverview?.payouts?.pending ?? 0;
  const detectedModels = runtimeCheck?.detectedModels?.length
    ? runtimeCheck.detectedModels
    : endpointRawModels;
  const powerBtnLabel = startPending
    ? 'STARTING'
    : uiState.phase === 'initializing'
      ? ''
    : status?.running
      ? 'STOP'
      : canStart
        ? 'START'
        : uiState.actionTarget === 'app-token' || uiState.actionTarget === 'token'
          ? (uiState.phase === 'token_invalid' ? 'REPLACE TOKEN' : 'PASTE TOKEN')
          : uiState.actionTarget === 'runtime'
            ? 'FIX RUNTIME'
            : uiState.actionLabel
              ? String(uiState.actionLabel).toUpperCase()
              : '';
  const protectionRows = useMemo(
    () =>
      buildWorkerProtectionRows({
        overview: workerOverview,
        hasStoredToken,
        hasUsableToken,
        localDeviceId: config.deviceId,
      }),
    [workerOverview, hasStoredToken, hasUsableToken, config.deviceId]
  );
  const protectionBadge = useMemo(
    () => resolveWorkerProtectionBadge(workerOverview, protectionRows),
    [workerOverview, protectionRows]
  );
  const shortDeviceId = config.deviceId
    ? `${String(config.deviceId).slice(0, 8)}…`
    : '—';
  const runtimeConfigDirty = useMemo(
    () => isRuntimeConfigDirty(savedRuntimeConfig, config),
    [savedRuntimeConfig, config]
  );
  const runtimeReadyLabel = !runtimeCheck
    ? 'Runtime unchecked'
    : !runtimeReachableForStart
      ? `${providerLabel} offline`
      : modelReady
        ? `${providerLabel} ready`
        : 'Model not loaded';
  const lastHubContactLabel = lastHubSuccessAt
    ? lastHubSuccessAt.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
    : '—';
  const powerStatusLine = startPending
    ? (startPhase === 'starting_worker' ? 'Starting worker...' : 'Checking runtime...')
    : uiState.phase === 'running_active' && currentTask
      ? 'Processing task pipeline'
      : uiState.phase === 'running_idle'
        ? 'Waiting for tasks'
        : uiState.phase === 'ready'
          ? 'Ready to earn'
          : uiState.subtitle;
  const nextActionLine = startPending
    ? 'Next action: starting worker'
    : status?.running
    ? (currentTask
      ? `Next action: complete ${currentTask.type}`
      : `Next action: keep ${providerLabel} running`)
    : (!hasUsableToken
      ? 'Next action: paste worker token'
      : !modelReady
        ? ''
        : 'Next action: start worker');

  const activityContext = useMemo(() => ({
    hubState,
    statusRunning: Boolean(status?.running),
    currentTask,
    lastHubContactLabel,
  }), [hubState, status?.running, currentTask, lastHubContactLabel]);

  const activityFeed = useMemo(
    () => buildActivityFeed(logs, { includeRuntime: false, limit: 6, context: activityContext }),
    [logs, activityContext]
  );
  const activityFeedFull = useMemo(
    () => buildActivityFeed(logs, { includeRuntime: false, limit: 20, context: activityContext }),
    [logs, activityContext]
  );

  const copyDeviceId = async () => {
    if (!config.deviceId) return;
    try {
      await navigator.clipboard.writeText(String(config.deviceId));
      addLog('info', 'Device id copied');
    } catch {
      addLog('warn', 'Could not copy device id');
    }
  };

  const copyPayoutAddress = async () => {
    if (!config.qvncAddress) return;
    try {
      await navigator.clipboard.writeText(String(config.qvncAddress));
      addLog('info', 'Payout address copied');
    } catch {
      addLog('warn', 'Could not copy address');
    }
  };

  const copyRuntimeModelId = async (modelId, label = 'Model id') => {
    const value = String(modelId || '').trim();
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
      addLog('info', `${label} copied`);
    } catch {
      addLog('warn', `Could not copy ${label.toLowerCase()}`);
    }
  };

  const workerSetupGuideUrl = `${String(config.apiUrl || DEFAULT_CONFIG.apiUrl).replace(/\/+$/, '')}/docs/worker-onboarding#lm-studio-and-models`;

  const handlePowerClick = () => {
    if (startPending || startInFlightRef.current) return;
    if (status?.running) {
      void handleStop();
      return;
    }
    if (canStart && uiState.actionTarget === 'start') {
      void handleStart();
      return;
    }
    if (uiState.actionTarget === 'open-external') {
      void openExternalUrl(uiState.externalUrl || workerPageUrl);
      return;
    }
    if (uiState.actionTarget === 'hub-suspended' || uiState.actionTarget === 'worker-page') {
      void openExternalUrl(uiState.externalUrl || workerPageUrl);
      return;
    }
    if (uiState.actionTarget === 'app-token') {
      openAppTokenCard({ replace: uiState.phase === 'token_invalid' || hasStoredToken });
      return;
    }
    if (uiState.actionTarget === 'app-address') {
      setActiveSection('app');
      return;
    }
    if (uiState.actionTarget === 'token') {
      openAppTokenCard({ replace: uiState.phase === 'token_invalid' || hasStoredToken });
      return;
    }
    if (uiState.actionTarget === 'runtime') setActiveSection('runtime');
    else if (uiState.actionTarget === 'activity') setActiveSection('activity');
  };

  const developerMode = Boolean(config.developerMode);
  const navItems = [
    { id: 'dashboard', label: 'Dashboard' },
    { id: 'runtime', label: 'Runtime' },
    { id: 'app', label: 'App' },
    { id: 'activity', label: 'Activity' },
    ...(developerMode ? [{ id: 'debug', label: 'Debug' }] : []),
  ];

  const runtimeForm = (
    <div className="runtime-layout">
      <section className="panel-block runtime-col">
        <div className="panel-block-head">
          <h2>{policyEnforced ? 'Approved runtime' : 'Model'}</h2>
          <p>
            {policyEnforced
              ? (runtimePolicy?.label || 'Hub-approved local runtime models are required for rewards.')
              : 'Select generation and embedding models for task execution.'}
          </p>
        </div>
        {policyEnforced ? (
          <div className="field-grid">
            <div className="runtime-policy-row">
              <span className="runtime-policy-label">Provider</span>
              <span className="runtime-policy-value">{formatProviderLabel(runtimePolicy?.provider)}</span>
              <span className={`rail-badge ${String(config.llmProvider || '') === runtimePolicy?.provider ? 'is-ok' : 'is-bad'}`}>
                {String(config.llmProvider || '') === runtimePolicy?.provider ? 'Required' : 'Mismatch'}
              </span>
            </div>
            <div className="runtime-policy-row">
              <span className="runtime-policy-label">Generation</span>
              <span className="runtime-policy-value" title={runtimePolicy?.generation_model}>{runtimePolicy?.generation_model}</span>
              <button
                type="button"
                className="btn-link runtime-copy-btn"
                onClick={() => void copyRuntimeModelId(runtimePolicy?.generation_model, 'Generation model id')}
              >
                Copy
              </button>
              <span className={`rail-badge ${runtimeCheck?.generationModelAvailable ? 'is-ok' : 'is-bad'}`}>
                {runtimeCheck?.generationModelAvailable ? 'Detected' : 'Missing'}
              </span>
            </div>
            {runtimeCheck?.detectedGenerationModel
              && runtimeCheck.detectedGenerationModel !== runtimePolicy?.generation_model ? (
              <p className="hint">Detected as: {runtimeCheck.detectedGenerationModel}</p>
            ) : null}
            <div className="runtime-policy-row">
              <span className="runtime-policy-label">Embedding</span>
              <span className="runtime-policy-value" title={runtimePolicy?.embedding_model}>{runtimePolicy?.embedding_model}</span>
              <button
                type="button"
                className="btn-link runtime-copy-btn"
                onClick={() => void copyRuntimeModelId(runtimePolicy?.embedding_model, 'Embedding model id')}
              >
                Copy
              </button>
              <span className={`rail-badge ${runtimeCheck?.embeddingModelAvailable ? 'is-ok' : 'is-bad'}`}>
                {runtimeCheck?.embeddingModelAvailable ? 'Detected' : 'Missing'}
              </span>
            </div>
            {runtimeCheck?.detectedEmbeddingModel
              && runtimeCheck.detectedEmbeddingModel !== runtimePolicy?.embedding_model ? (
              <p className="hint">Detected as: {runtimeCheck.detectedEmbeddingModel}</p>
            ) : null}
            {runtimePolicy?.runtime_policy_version ? (
              <p className="hint">Policy version: {runtimePolicy.runtime_policy_version} · mode: {runtimePolicy.mode}</p>
            ) : null}
          </div>
        ) : (
          <div className="field-grid">
            <div>
              <label htmlFor="llmProvider">LLM provider</label>
              <CustomSelect
                id="llmProvider"
                value={config.llmProvider || 'ollama'}
                options={[
                  { value: 'ollama', label: 'Ollama' },
                  { value: 'openai_compat', label: 'LM Studio (OpenAI-compatible)' },
                ]}
                onChange={(value) => {
                  updateConfig('llmProvider', value);
                  const nextAllowed = getAllowedModelsForProvider(value);
                  const currentModel = String(config.genModel || config.model || '').trim();
                  if (!nextAllowed.includes(currentModel)) {
                    updateConfig('genModel', nextAllowed[0]);
                    updateConfig('model', nextAllowed[0]);
                  }
                  if (value === 'openai_compat') {
                    const current = String(config.llmBaseUrl || '').trim();
                    if (!current || current.includes(':11434')) {
                      updateConfig('llmBaseUrl', 'http://localhost:1234/v1');
                    }
                  }
                }}
              />
            </div>
            <div>
              <label htmlFor="genModel">Generation model</label>
              <CustomSelect
                id="genModel"
                value={effectiveGenModel}
                options={providerAllowedModels.map((modelName) => ({
                  value: modelName,
                  label: modelName,
                }))}
                onChange={(value) => {
                  updateConfig('genModel', value);
                  updateConfig('model', value);
                }}
              />
            </div>
            <div>
              <label htmlFor="embedModel">Embedding model</label>
              <CustomSelect
                id="embedModel"
                value={effectiveEmbedModel}
                options={embedOptionIds.map((id) => {
                  const fb = staticFallbackEmbedModel(config.llmProvider || 'ollama');
                  const isPlaceholder = endpointRawModels.length === 0 && id === fb;
                  return {
                    value: id,
                    label: isPlaceholder ? `${id} (refresh to load from server)` : id,
                  };
                })}
                onChange={(value) => updateConfig('embedModel', value)}
              />
            </div>
          </div>
        )}
        {runtimeCheck && !runtimeCheck.ready ? (
          <div className="setup-banner mt-12">
            <span className="setup-banner-text">
              {(String(config.llmProvider || 'ollama') === 'openai_compat'
                ? !runtimeCheck.openaiCompatReachable
                : !runtimeCheck.ollamaReachable)
                ? 'Start LM Studio local server'
                : 'Load the required models in LM Studio'}
            </span>
          </div>
        ) : null}
        <div className="inline-actions mt-12">
          <button
            id="tour-check-runtime"
            className="btn-primary"
            onClick={() => void handleCheckRuntime()}
          >
            {runtimeCheck && !runtimeCheck.ready ? 'Re-check runtime' : 'Check runtime'}
          </button>
          {policyEnforced ? (
            <button type="button" className="btn-secondary" onClick={() => void openExternalUrl('https://lmstudio.ai')}>
              Get LM Studio
            </button>
          ) : null}
        </div>
        <div className="inline-actions mt-12">
          <button
            type="button"
            className="btn-link"
            onClick={() => void loadRuntimeModels()}
            disabled={modelsLoading}
          >
            {modelsLoading ? 'Refreshing…' : 'Refresh models'}
          </button>
          {policyEnforced ? (
            <button type="button" className="btn-link" onClick={() => void openExternalUrl(workerSetupGuideUrl)}>
              Setup guide
            </button>
          ) : null}
        </div>
        {policyEnforced && detectedModels.length > 0 ? (
          <div className="mt-12">
            <button
              type="button"
              className="btn-link"
              onClick={() => setShowDetectedModels((value) => !value)}
            >
              {showDetectedModels ? 'Hide detected models' : 'Advanced: detected models on endpoint'}
            </button>
            {showDetectedModels ? (
              <p className="hint mt-8">{detectedModels.join(', ')}</p>
            ) : null}
          </div>
        ) : null}
      </section>

      <section className="panel-block runtime-col">
        <div className="panel-block-head">
          <h2>Runtime settings</h2>
          <p>Endpoint URL, API key, and prompt compatibility.</p>
        </div>
        <div className="field-grid">
          {String(config.llmProvider || 'ollama') === 'openai_compat' ? (
            <>
              <div>
                <label htmlFor="llmBaseUrl">LM Studio base URL</label>
                <input
                  id="llmBaseUrl"
                  type="text"
                  value={config.llmBaseUrl || ''}
                  onChange={(e) => updateConfig('llmBaseUrl', e.target.value)}
                  placeholder="http://localhost:1234/v1"
                />
              </div>
              <div>
                <label htmlFor="llmApiKey">API key (optional)</label>
                <input
                  id="llmApiKey"
                  type="password"
                  value={config.llmApiKey || ''}
                  onChange={(e) => updateConfig('llmApiKey', e.target.value)}
                  placeholder="not required for local LM Studio"
                />
              </div>
              <div>
                <label htmlFor="openAiCompatRoleMode">Prompt role mode</label>
                <CustomSelect
                  id="openAiCompatRoleMode"
                  value={config.openAiCompatRoleMode || 'auto'}
                  options={[
                    { value: 'auto', label: 'Auto compatibility' },
                    { value: 'system', label: 'System + User' },
                    { value: 'user_only', label: 'User-only' },
                  ]}
                  onChange={(value) => updateConfig('openAiCompatRoleMode', value)}
                />
              </div>
            </>
          ) : (
            <div>
              <label htmlFor="ollamaUrl">Ollama URL</label>
              <input
                id="ollamaUrl"
                type="text"
                value={config.ollamaUrl || ''}
                onChange={(e) => updateConfig('ollamaUrl', e.target.value)}
                placeholder="http://localhost:11434"
              />
            </div>
          )}
        </div>
        {runtimeCheck ? (
          <div className="runtime-status-row mt-12">
            {String(config?.llmProvider || 'ollama') === 'openai_compat' ? (
              <span className={`rail-badge ${runtimeCheck.openaiCompatReachable ? 'is-ok' : 'is-bad'}`}>
                Endpoint {runtimeCheck.openaiCompatReachable ? 'connected' : 'offline'}
              </span>
            ) : (
              <span className={`rail-badge ${runtimeCheck.ollamaReachable ? 'is-ok' : 'is-bad'}`}>
                Ollama {runtimeCheck.ollamaReachable ? 'connected' : 'offline'}
              </span>
            )}
            <span className={`rail-badge ${runtimeCheck.generationModelAvailable ? 'is-ok' : 'is-bad'}`}>
              Generation {runtimeCheck.generationModelAvailable ? 'ready' : 'missing'}
            </span>
            <span className={`rail-badge ${runtimeCheck.embeddingModelAvailable ? 'is-ok' : 'is-bad'}`}>
              Embedding {runtimeCheck.embeddingModelAvailable ? 'ready' : 'missing'}
            </span>
          </div>
        ) : (
          <p className="hint mt-12">Runtime not checked yet. Use Check runtime above.</p>
        )}
        {!policyEnforced && availableModels.length > 0 ? (
          <p className="hint mt-8">
            Allowed generation: {availableModels.join(', ')}
            {endpointRawModels.length > 0
              ? ` · ${endpointRawModels.length} ids on endpoint`
              : null}
          </p>
        ) : null}
      </section>

      <div className="runtime-footer">
        <button
          className="btn-primary"
          onClick={() => void handleSave({ runtimeOnly: true })}
          disabled={!runtimeConfigDirty}
        >
          Save settings
        </button>
        {runtimeSavedNotice ? <span className="saved-notice">Saved</span> : null}
      </div>
    </div>
  );

  const trayAvailable = Boolean(trayStatus?.available || trayStatus?.active);
  const minimizeToTrayOnClose = config.minimizeToTrayOnClose !== false;
  const showTrayUnavailableWarning = minimizeToTrayOnClose && trayStatus && !trayAvailable;
  const tokenEndpoint = config.apiUrl || 'https://quavence.com';
  const showTokenInput = tokenReplaceMode || !hasStoredToken;
  const tokenCardInvalid = hubState === 'token_invalid';

  const appForm = (
    <div className="panel-stack app-panel">
      <div className="settings-grid">
        <div className="settings-column">
          <section className="panel-block panel-block-compact">
            <div className="panel-block-head panel-block-head-compact">
              <h2>App behavior</h2>
              <p>Startup, tray, and background operation.</p>
            </div>
            <div className="app-settings-list app-settings-list-compact">
              <label className="app-setting-row app-setting-row-compact">
                <span>
                  <strong>Launch app on system startup</strong>
                  <span className="hint">Register in Windows login items.</span>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(config.launchAtStartup)}
                  onChange={() => void handleToggleAppSetting('launchAtStartup')}
                />
              </label>
              <label className="app-setting-row app-setting-row-compact">
                <span>
                  <strong>Start worker automatically when app opens</strong>
                  <span className="hint">When token is saved and runtime is ready.</span>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(config.startWorkerOnLaunch)}
                  onChange={() => void handleToggleAppSetting('startWorkerOnLaunch')}
                />
              </label>
              <label className="app-setting-row app-setting-row-compact">
                <span>
                  <strong>Keep running in tray when window is closed</strong>
                  <span className="hint">Closing keeps the worker available in the system tray.</span>
                  {showTrayUnavailableWarning ? (
                    <span className="setup-banner setup-banner-neutral app-setting-banner">
                      <span className="setup-banner-text">
                        Tray icon is unavailable. Closing the window will quit the app until this is fixed.
                      </span>
                    </span>
                  ) : null}
                </span>
                <input
                  type="checkbox"
                  checked={minimizeToTrayOnClose}
                  onChange={() => void handleToggleAppSetting('minimizeToTrayOnClose')}
                />
              </label>
              <label
                className={`app-setting-row app-setting-row-compact${
                  minimizeToTrayOnClose ? '' : ' is-disabled'
                }`}
              >
                <span>
                  <strong>Show close-to-tray hint</strong>
                  <span className="hint">One-time reminder when closing while the worker is running.</span>
                </span>
                <input
                  type="checkbox"
                  checked={config.showCloseToTrayHint !== false}
                  disabled={!minimizeToTrayOnClose}
                  onChange={() => void handleToggleAppSetting('showCloseToTrayHint')}
                />
              </label>
              <label className="app-setting-row app-setting-row-compact">
                <span>
                  <strong>Developer mode</strong>
                  <span className="hint">Show the Debug tab with logs and tray diagnostics.</span>
                </span>
                <input
                  type="checkbox"
                  checked={Boolean(config.developerMode)}
                  onChange={() => void handleToggleAppSetting('developerMode')}
                />
              </label>
            </div>
          </section>

          <section className="panel-block panel-block-compact">
            <div className="panel-block-head panel-block-head-compact">
              <h2>Application actions</h2>
              <p>Stop worker keeps the app open. Quit exits.</p>
            </div>
            <div className="inline-actions inline-actions-compact">
              <button type="button" className="btn-secondary" onClick={() => void handleStop()} disabled={!status?.running}>
                Stop worker
              </button>
              <button type="button" className="btn-secondary warn-btn" onClick={() => void handleQuit()}>
                Quit app
              </button>
            </div>
          </section>
        </div>

        <div className="settings-column">
          <section
            ref={tokenCardRef}
            id="worker-token-card"
            className={`panel-block panel-block-compact worker-token-card${tokenCardInvalid ? ' is-invalid' : ''}`}
          >
            <div className="panel-block-head panel-block-head-compact">
              <h2>Worker token</h2>
              {tokenCardInvalid ? (
                <div className="setup-banner mt-8">
                  <span className="setup-banner-text">
                    Saved token is invalid. Issue a new token on the Worker page, then replace it here.
                  </span>
                </div>
              ) : showTokenInput ? (
                <p>Paste your node token from the Worker page.</p>
              ) : null}
            </div>
            {showTokenInput ? (
              <>
                <div id="tour-token" className="worker-token-input">
                  <label htmlFor="token">Node token</label>
                  <input
                    id="token"
                    type="password"
                    autoComplete="off"
                    placeholder="paste node_token only (without Bearer)"
                    value={config.token}
                    onChange={(e) => updateConfig('token', e.target.value)}
                  />
                </div>
                <p className="hint worker-token-endpoint">
                  Endpoint: <code>{tokenEndpoint}</code>
                </p>
                <div className="inline-actions inline-actions-compact">
                  <button type="button" className="btn-primary" onClick={() => void handleSave()} disabled={!canSaveToken}>
                    Save token
                  </button>
                  {tokenReplaceMode && hasStoredToken ? (
                    <button type="button" className="btn-secondary" onClick={() => setTokenReplaceMode(false)}>
                      Cancel
                    </button>
                  ) : null}
                </div>
              </>
            ) : (
              <>
                <dl className="rail-kv panel-kv">
                  <div><dt>Status</dt><dd>Saved locally</dd></div>
                  <div><dt>Endpoint</dt><dd className="truncate-text" title={tokenEndpoint}>{tokenEndpoint}</dd></div>
                </dl>
                <div className="inline-actions inline-actions-compact">
                  <button type="button" className="btn-secondary" onClick={() => setTokenReplaceMode(true)}>
                    Replace token
                  </button>
                  <button type="button" className="btn-secondary" onClick={() => void handleForgetToken()}>
                    Forget saved token
                  </button>
                </div>
              </>
            )}
          </section>

          <section id="worker-payout-address-card" className="panel-block panel-block-compact">
            <div className="panel-block-head panel-block-head-compact">
              <h2>On-Chain Payout Address (QVNC)</h2>
              <p>Required: Staking wallet address (S...) to receive on-chain AI pool dividends.</p>
            </div>
            <div className="worker-token-input">
              <label htmlFor="qvncAddress">Native QVNC Address (Required)</label>
              <input
                id="qvncAddress"
                type="text"
                autoComplete="off"
                placeholder="e.g. SXmpJDFVEW7HzwrAAVrpK8hTDzyjfdbpU6"
                value={config.qvncAddress || ''}
                onChange={(e) => updateConfig('qvncAddress', e.target.value.trim())}
              />
            </div>
            {hasUsableAddress ? (
              <p className="hint" style={{ color: '#34d399' }}>
                ✓ Valid Quavence address format (Mainnet P2PKH)
              </p>
            ) : String(config.qvncAddress || '').trim() ? (
              <p className="hint" style={{ color: '#f87171' }}>
                ⚠ Invalid address. Address must start with &quot;S&quot; (26-35 characters).
              </p>
            ) : (
              <p className="hint" style={{ color: '#fbbf24' }}>
                ⚠ Address is required to start the worker and earn PoUS rewards.
              </p>
            )}
            <div className="inline-actions inline-actions-compact">
              <button type="button" className="btn-primary" onClick={() => void handleSave()} disabled={!hasUsableAddress}>
                Save address
              </button>
            </div>
          </section>

          <section className="panel-block panel-block-compact">
            <div className="panel-block-head panel-block-head-compact">
              <h2>About</h2>
              <p>Version and links for support.</p>
            </div>
            <dl className="rail-kv panel-kv">
              <div><dt>App</dt><dd>{APP_DISPLAY_NAME}</dd></div>
              <div><dt>Version</dt><dd>{appVersionLabel}{appBuildLabel}</dd></div>
              <div><dt>Hub</dt><dd className="truncate-text" title={hubHost}>{hubHost}</dd></div>
            </dl>
            <div className="inline-actions inline-actions-compact">
              <button type="button" className="btn-secondary" onClick={() => void openExternalUrl(workerPageUrl)}>
                Open Worker page
              </button>
              <button type="button" className="btn-secondary" onClick={() => void openExternalUrl(WORKER_RELEASE_NOTES_URL)}>
                Release notes
              </button>
            </div>
          </section>
        </div>
      </div>
    </div>
  );

  return (
    <div id="viewport">
      {showOnboarding ? (
        <div className="onboarding-overlay">
          {onboardingAnchorRect ? (
            <div
              className="onboarding-highlight"
              style={{
                top: `${onboardingAnchorRect.top - 4}px`,
                left: `${onboardingAnchorRect.left - 4}px`,
                width: `${onboardingAnchorRect.width + 8}px`,
                height: `${onboardingAnchorRect.height + 8}px`,
              }}
            />
          ) : null}
          <div className="onboarding-modal onboarding-modal-anchored" style={getOnboardingPopoverStyle()}>
            <div className="onboarding-title">{onboardingSteps[onboardingStep]?.title}</div>
            <div className="onboarding-body">{onboardingSteps[onboardingStep]?.body}</div>
            <div className="onboarding-progress">
              {onboardingStep + 1} / {onboardingSteps.length}
            </div>
            <div className="row onboarding-actions mt-12">
              <button
                type="button"
                className="btn-secondary"
                onClick={() => setOnboardingStep((s) => Math.max(0, s - 1))}
                disabled={onboardingStep === 0}
              >
                Back
              </button>
              <button type="button" className="btn-secondary" onClick={() => void completeOnboarding()}>
                Skip
              </button>
              {isLastOnboardingStep ? (
                <button type="button" className="primary" onClick={() => void completeOnboarding()}>
                  Done
                </button>
              ) : (
                <button
                  type="button"
                  className="primary"
                  onClick={() => setOnboardingStep((s) => Math.min(onboardingSteps.length - 1, s + 1))}
                >
                  Next
                </button>
              )}
            </div>
          </div>
        </div>
      ) : null}

      <div className="app-shell worker-app">
        <header className="top-bar">
          <div className="top-bar-brand" title={APP_DISPLAY_NAME}>
            <img className="top-bar-logo" src={appLogoUrl} alt="" width={32} height={32} />
            <span className="top-bar-brand-text">Quavence Worker</span>
          </div>
          <nav className="seg-nav" aria-label="Worker sections">
            {navItems.map((item) => (
              <button
                key={item.id}
                type="button"
                className={`seg-nav-item ${activeSection === item.id ? 'is-active' : ''}`}
                onClick={() => setActiveSection(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
          <div className="top-bar-end">
            <button type="button" className="icon-btn" onClick={handleShowTutorial} title="Open tutorial" aria-label="Open tutorial">
              ?
            </button>
            {showWindowControls ? (
              <div className="window-controls">
                <button
                  type="button"
                  className="window-control-btn"
                  title="Minimize"
                  aria-label="Minimize"
                  onClick={() => void api?.windowMinimize?.()}
                >
                  <svg viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M1 5h8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </button>
                <button
                  type="button"
                  className="window-control-btn"
                  title={windowMaximized ? 'Restore' : 'Maximize'}
                  aria-label={windowMaximized ? 'Restore' : 'Maximize'}
                  onClick={() => void api?.windowMaximizeToggle?.()}
                >
                  {windowMaximized ? (
                    <svg viewBox="0 0 10 10" aria-hidden="true">
                      <path d="M2.5 3.5h5v5h-5z" fill="none" stroke="currentColor" strokeWidth="1.1" />
                      <path d="M3.5 2.5h5v5" fill="none" stroke="currentColor" strokeWidth="1.1" />
                    </svg>
                  ) : (
                    <svg viewBox="0 0 10 10" aria-hidden="true">
                      <rect x="1.5" y="1.5" width="7" height="7" fill="none" stroke="currentColor" strokeWidth="1.2" />
                    </svg>
                  )}
                </button>
                <button
                  type="button"
                  className="window-control-btn is-close"
                  title="Close"
                  aria-label="Close"
                  onClick={() => void api?.windowClose?.()}
                >
                  <svg viewBox="0 0 10 10" aria-hidden="true">
                    <path d="M2 2l6 6M8 2L2 8" fill="none" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                  </svg>
                </button>
              </div>
            ) : null}
          </div>
        </header>

        <main className={`main-panel ${activeSection === 'dashboard' ? 'main-panel-dashboard' : 'main-panel-scroll'}${activeSection === 'runtime' ? ' runtime-panel' : ''}${activeSection === 'app' ? ' app-panel-view' : ''}${activeSection === 'activity' ? ' activity-panel-view' : ''}`}>
          {activeSection === 'dashboard' ? (
            <div className="dashboard">
              <div className="dash-grid">
                <div className="dash-columns dash-columns-hero">
                  <div
                    className={`dashboard-ambient dashboard-ambient-${dashboardAmbientState}`}
                    aria-hidden="true"
                  >
                    <div className="dashboard-ambient-core" />
                  </div>
                  <section className="dash-hero">
                    <div
                      id="tour-status"
                      className={`dash-hero-pill ${startPending ? 'is-starting' : currentTask ? 'is-running' : status?.running ? 'is-running' : 'is-stopped'}`}
                    >
                      <span className="dash-hero-pill-dot" aria-hidden="true" />
                      {startPending ? 'Starting' : currentTask ? 'Processing' : statusText}
                    </div>
                    <h2
                      className={`dash-hero-title${currentTask ? ' is-task' : ''}`}
                      title={currentTask ? currentTask.type : undefined}
                    >
                      {currentTask ? formatTaskTypeLabel(currentTask.type) : uiState.title}
                    </h2>
                    {currentTask ? (
                      <p className="dash-hero-lede">
                        Keep {providerLabel} running until this finishes.
                      </p>
                    ) : (() => {
                      const heroTitle = uiState.title;
                      const nextPlain = String(nextActionLine || '').replace(/^Next action:\s*/i, '').trim();
                      const statusPlain = String(powerStatusLine || '').trim();
                      let lede = '';
                      if (statusPlain && statusPlain !== heroTitle) {
                        const nextLower = nextPlain.toLowerCase();
                        const statusLower = statusPlain.toLowerCase();
                        const nextRedundant = !nextPlain
                          || nextLower === statusLower
                          || statusLower.includes(nextLower)
                          || (nextLower.includes('token') && statusLower.includes('token'));
                        lede = nextRedundant ? statusPlain : `${statusPlain} · ${nextPlain}`;
                      } else {
                        lede = nextPlain;
                      }
                      return lede ? <p className="dash-hero-lede">{lede}</p> : null;
                    })()}
                    <button
                      id="tour-power"
                      type="button"
                      className={`power-btn power-btn-hero ${powerBtnLabel ? 'power-btn-has-label' : 'power-btn-icon-only'} ${startPending || uiState.phase === 'initializing' ? 'power-starting' : `power-${uiState.powerMode}`}`}
                      onClick={handlePowerClick}
                      disabled={startPending || uiState.phase === 'initializing'}
                      aria-label={startPending ? 'Starting worker' : uiState.phase === 'initializing' ? 'Checking setup' : status?.running ? 'Stop worker' : canStart ? 'Start worker' : uiState.actionLabel}
                    >
                      {startPending || uiState.phase === 'initializing' ? (
                        <PowerButtonSpinner />
                      ) : (
                        <PowerButtonIcon
                          running={Boolean(status?.running)}
                          canStart={canStart}
                          actionTarget={uiState.actionTarget}
                        />
                      )}
                      {powerBtnLabel ? <span className="power-btn-label">{powerBtnLabel}</span> : null}
                    </button>
                    <div className="dash-hero-meta">
                      <span className={`rail-badge hub-status hub-${hubState}`}>{hubStateLabel(hubState, hubSuspension)}</span>
                      <span className={`rail-badge ${modelReady ? 'is-ok' : 'is-pending'}`}>{runtimeReadyLabel}</span>
                      <span className={`rail-badge ${protectionBadge.className}`}>{protectionBadge.label}</span>
                      <span
                        className="rail-badge"
                        title={
                          pousBoostPercent > 0
                            ? `PoUS Staking Boost active (+${pousBoostPercent}% bnWeight for ${todayTasks} tasks today)`
                            : 'PoUS Staking Boost: Complete at least 1 verified compute task to activate +20% boost (+35% for 5+, +50% for 10+)'
                        }
                        style={
                          pousBoostPercent > 0
                            ? { color: '#34d399', borderColor: 'rgba(52, 211, 153, 0.4)', background: 'rgba(52, 211, 153, 0.1)' }
                            : { color: '#94a3b8', borderColor: 'rgba(148, 163, 184, 0.25)', background: 'rgba(30, 41, 59, 0.4)' }
                        }
                      >
                        {pousBoostPercent > 0 ? `PoUS +${pousBoostPercent}%` : 'PoUS +0%'}
                      </span>
                    </div>
                    <dl className="dash-hero-kv">
                      <div><dt>Token</dt><dd>{hasStoredToken ? 'Saved' : hasUsableToken ? 'Ready' : 'Missing'}</dd></div>
                      <div>
                        <dt>Payout</dt>
                        <dd className="device-id-cell">
                          <span className="truncate-text" title={config.qvncAddress || undefined}>
                            {config.qvncAddress ? `${config.qvncAddress.slice(0, 8)}…` : '—'}
                          </span>
                          {config.qvncAddress ? (
                            <button type="button" className="copy-chip" onClick={() => void copyPayoutAddress()} title="Copy address" aria-label="Copy address">
                              <svg viewBox="0 0 16 16" aria-hidden="true">
                                <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                                <path d="M3.5 10.5V3.5h7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                              </svg>
                            </button>
                          ) : null}
                        </dd>
                      </div>
                      <div>
                        <dt>Device</dt>
                        <dd className="device-id-cell">
                          <span className="truncate-text" title={config.deviceId || undefined}>{shortDeviceId}</span>
                          {config.deviceId ? (
                            <button type="button" className="copy-chip" onClick={() => void copyDeviceId()} title="Copy device id" aria-label="Copy device id">
                              <svg viewBox="0 0 16 16" aria-hidden="true">
                                <rect x="5.5" y="5.5" width="8" height="8" rx="1.5" fill="none" stroke="currentColor" strokeWidth="1.3" />
                                <path d="M3.5 10.5V3.5h7" fill="none" stroke="currentColor" strokeWidth="1.3" strokeLinecap="round" />
                              </svg>
                            </button>
                          ) : null}
                        </dd>
                      </div>
                      <div><dt>Last contact</dt><dd>{lastHubContactLabel}</dd></div>
                    </dl>
                  </section>

                  <aside className="dash-contribution">
                    <section className="rail-card contribution-card">
                      <div className="contribution-head">
                        <h3>Your contribution</h3>
                        <p>Earnings and task progress for this node.</p>
                      </div>
                      <div className="contribution-hero">
                        <div className="contribution-hero-value">
                          {formatUsdRewardValue(workerOverview?.rewards?.accrued_amount_usd)}
                        </div>
                        <div className="contribution-hero-label">
                          Payout-eligible
                          <span className="contribution-hero-sub">
                            ≈ {formatQvncSettlementAmount(accruedTotal)} {rewardAsset}
                          </span>
                        </div>
                      </div>
                      <div className="contribution-grid">
                        <div>
                          <div className="contribution-stat-value">{totalTasks}</div>
                          <div className="contribution-stat-label">Tasks done</div>
                        </div>
                        <div>
                          <div className="contribution-stat-value">{todayTasks}</div>
                          <div className="contribution-stat-label">Today</div>
                        </div>
                        <div>
                          <div className="contribution-stat-value">{formatUsdRewardValue(workerOverview?.rewards?.paid_amount_usd)}</div>
                          <div className="contribution-stat-label">Lifetime paid</div>
                        </div>
                        <div>
                          <div className="contribution-stat-value">{pendingPayouts}</div>
                          <div className="contribution-stat-label">Pending batches</div>
                        </div>
                      </div>
                      {showAccruedBreakdown ? (
                        <dl className="rail-kv earnings-kv contribution-breakdown">
                          {Number(heldTotal) > 0 ? (
                            <div>
                              <dt>Held (review)</dt>
                              <dd className="earnings-dual earnings-muted">
                                <span>{formatUsdRewardValue(workerOverview?.rewards?.accrued_held_amount_usd)}</span>
                                <span className="earnings-settlement">≈ {formatQvncSettlementAmount(heldTotal)} {rewardAsset}</span>
                              </dd>
                            </div>
                          ) : null}
                          {Number(rejectedTotal) > 0 ? (
                            <div>
                              <dt>Not payable</dt>
                              <dd className="earnings-dual earnings-muted">
                                <span>{formatUsdRewardValue(workerOverview?.rewards?.accrued_rejected_amount_usd)}</span>
                                <span className="earnings-settlement">≈ {formatQvncSettlementAmount(rejectedTotal)} {rewardAsset}</span>
                              </dd>
                            </div>
                          ) : null}
                        </dl>
                      ) : null}
                    </section>
                  </aside>
                </div>

                <div className="dash-activity">
                  <div className="dash-activity-head">
                    <span>Recent activity</span>
                    {activityFeed.length > 0 ? (
                      <button type="button" className="strip-link" onClick={() => setActiveSection('activity')}>
                        View all
                      </button>
                    ) : null}
                  </div>
                  <div className="dash-activity-body">
                    <ul className="activity-compact">
                      {activityFeed.length > 0 ? (
                        activityFeed.slice(0, 5).map((item) => (
                          <li key={item.id} className={`activity-compact-item tone-${item.tone}`}>
                            <span className="activity-compact-time">{item.time}</span>
                            <span className="activity-compact-text">{item.text}</span>
                          </li>
                        ))
                      ) : (
                        <li className="activity-compact-empty">No events yet — start the worker to begin earning.</li>
                      )}
                    </ul>
                  </div>
                </div>
              </div>
            </div>
          ) : null}

          {activeSection === 'runtime' ? runtimeForm : null}
          {activeSection === 'app' ? appForm : null}

          {activeSection === 'activity' ? (
              <div className="panel-stack activity-panel">
                <div className="activity-layout">
                  <section className="panel-block activity-feed-block">
                    <div className="panel-block-head">
                      <h2>Recent activity</h2>
                      <p>Task claims, completions, and runtime events.</p>
                    </div>
                    <ul className="activity-list activity-list-full">
                      {activityFeedFull.length > 0 ? (
                        activityFeedFull.map((item) => (
                          <li key={item.id} className={`activity-item tone-${item.tone}`}>
                            <span className="activity-time">{item.time}</span>
                            <span className="activity-text">{item.text}</span>
                          </li>
                        ))
                      ) : (
                        <li className="activity-empty">No activity yet.</li>
                      )}
                    </ul>
                  </section>
                  <section className="panel-block activity-task-block">
                    <div className="panel-block-head">
                      <h2>Current task</h2>
                    </div>
                    {currentTask ? (
                      <div className="current-task-badge" title={`${currentTask.type} · ${currentTask.id}`}>
                        <span className="current-task-type">{currentTask.type}</span>
                        <span className="current-task-id">{currentTask.id}</span>
                      </div>
                    ) : (
                      <p className="hint">No active task</p>
                    )}
                    <div className="worker-meta mt-12">
                      <span>PID: {status?.pid || '—'}</span>
                      <span>Started: {formatStartedAt(status?.startedAt)}</span>
                    </div>
                  </section>
                </div>
              </div>
            ) : null}

            {activeSection === 'debug' && developerMode ? (
              <div className="panel-stack debug-panel">
                <details className="diagnostics-details diagnostics-details-block">
                  <summary>Tray diagnostics</summary>
                  <dl className="rail-kv compact-tray-status">
                    <div>
                      <dt>Tray</dt>
                      <dd className={trayAvailable ? 'protection-value tone-good' : 'protection-value tone-warn'}>
                        {trayAvailable ? 'active' : (trayStatus?.unavailableReason || 'unavailable')}
                      </dd>
                    </div>
                    <div>
                      <dt>Icon path</dt>
                      <dd className="truncate-text" title={trayStatus?.iconPath || trayStatus?.resolvedPath || '—'}>
                        {trayStatus?.iconPath || trayStatus?.resolvedPath || '—'}
                      </dd>
                    </div>
                    <div>
                      <dt>Icon exists</dt>
                      <dd>{(trayStatus?.iconExists ?? trayStatus?.exists) ? 'true' : 'false'}</dd>
                    </div>
                    <div>
                      <dt>Close to tray</dt>
                      <dd>{minimizeToTrayOnClose ? 'enabled' : 'disabled'}</dd>
                    </div>
                  </dl>
                </details>
                <section className="panel-block">
                  <div className="panel-block-head logs-head">
                    <div>
                      <h2>Debug logs</h2>
                      <p>stdout/stderr from the worker agent.</p>
                    </div>
                    <div className="row">
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          void navigator.clipboard.writeText(filteredLogs.join('\n'));
                        }}
                      >
                        Copy logs
                      </button>
                      <button
                        type="button"
                        className="btn-ghost"
                        onClick={() => {
                          const blob = new Blob([filteredLogs.join('\n')], { type: 'text/plain' });
                          const url = URL.createObjectURL(blob);
                          const anchor = document.createElement('a');
                          anchor.href = url;
                          anchor.download = `quavence-worker-logs-${Date.now()}.txt`;
                          anchor.click();
                          URL.revokeObjectURL(url);
                        }}
                      >
                        Export logs
                      </button>
                      <button type="button" className="btn-ghost" onClick={() => setLogs([])}>
                        Clear
                      </button>
                    </div>
                  </div>
                  <div className="logs-filter-row">
                    {['all', 'errors', 'warnings', 'debug', 'hub', 'runtime', 'xdao'].map((filter) => (
                      <button
                        key={filter}
                        type="button"
                        className={logSourceFilter === filter ? 'filter-active' : ''}
                        onClick={() => setLogSourceFilter(filter)}
                      >
                        {filter === 'all' ? 'All' : filter.charAt(0).toUpperCase() + filter.slice(1)}
                      </button>
                    ))}
                  </div>
                  <div id="logs" className="debug-log-pane" ref={logsRef}>
                    {filteredLogs.join('\n') || 'No logs yet.'}
                  </div>
                </section>
              </div>
            ) : null}
        </main>
      </div>
      {toasts.length > 0 ? (
        <div className="app-toast-stack" aria-live="polite">
          {toasts.map((toast) => (
            <div
              key={toast.id}
              className={`app-toast is-${toast.tone}`}
              role="status"
              onMouseEnter={() => pauseToastTimer(toast.id)}
              onMouseLeave={() => resumeToastTimer(toast.id)}
            >
              <span className="app-toast-text">{toast.text}</span>
              <div className="app-toast-actions">
                {toast.actionLabel && toast.actionKey ? (
                  <button
                    type="button"
                    className="app-toast-action"
                    onClick={() => {
                      handleToastAction(toast.actionKey);
                      dismissToast(toast.id);
                    }}
                  >
                    {toast.actionLabel}
                  </button>
                ) : null}
                <button type="button" className="app-toast-dismiss" onClick={() => dismissToast(toast.id)}>
                  Dismiss
                </button>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
