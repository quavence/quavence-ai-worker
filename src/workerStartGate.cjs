let workerStartInFlight = null;

function createWorkerStartGate({ isRunning, startImpl, onDebugLog } = {}) {
  if (typeof isRunning !== 'function' || typeof startImpl !== 'function') {
    throw new Error('createWorkerStartGate requires isRunning and startImpl');
  }

  return async function requestWorkerStart(config) {
    if (isRunning()) {
      onDebugLog?.('Worker already running');
      return { ok: true, alreadyRunning: true };
    }

    if (workerStartInFlight) {
      onDebugLog?.('Start already in progress');
      return workerStartInFlight;
    }

    workerStartInFlight = (async () => {
      if (isRunning()) {
        onDebugLog?.('Worker already running');
        return { ok: true, alreadyRunning: true };
      }
      await startImpl(config);
      return { ok: true, started: true };
    })().finally(() => {
      workerStartInFlight = null;
    });

    return workerStartInFlight;
  };
}

function resetWorkerStartGateForTests() {
  workerStartInFlight = null;
}

module.exports = {
  createWorkerStartGate,
  resetWorkerStartGateForTests,
};
