const HUB_REQUEST_TIMEOUT_MS = Number(process.env.AI_WORKER_HUB_TIMEOUT_MS || 25000);
const HUB_REQUEST_MAX_RETRIES = Number(process.env.AI_WORKER_HUB_REQUEST_RETRIES || 3);
const HUB_REQUEST_RETRY_DELAY_MS = Number(process.env.AI_WORKER_HUB_RETRY_DELAY_MS || 900);

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isHubTransientNetworkError(error) {
  const status = Number(error?.status);
  const message = String(error?.message || '').toLowerCase();
  if (status === 429 || status >= 500) {
    return true;
  }
  return (
    message.includes('connect timeout')
    || message.includes('timeout')
    || message.includes('timed out')
    || message.includes('fetch failed')
    || message.includes('econnrefused')
    || message.includes('etimedout')
    || message.includes('enotfound')
    || message.includes('socket hang up')
    || message.includes('network error')
    || message.includes('aborted')
    || message.includes('abort')
    || message.includes('502')
    || message.includes('503')
  );
}

async function requestJsonWithRetry(
  requestJson,
  method,
  urlString,
  headers = {},
  body = null,
  {
    timeoutMs = HUB_REQUEST_TIMEOUT_MS,
    maxRetries = HUB_REQUEST_MAX_RETRIES,
    retryDelayMs = HUB_REQUEST_RETRY_DELAY_MS,
  } = {},
) {
  let lastError = null;
  const attempts = Math.max(1, maxRetries);

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await requestJson(method, urlString, headers, body, timeoutMs);
    } catch (error) {
      lastError = error;
      if (!isHubTransientNetworkError(error) || attempt >= attempts) {
        throw error;
      }
      await sleep(retryDelayMs * attempt);
    }
  }

  throw lastError || new Error('Hub request failed');
}

module.exports = {
  HUB_REQUEST_TIMEOUT_MS,
  HUB_REQUEST_MAX_RETRIES,
  HUB_REQUEST_RETRY_DELAY_MS,
  isHubTransientNetworkError,
  requestJsonWithRetry,
  sleep,
};
