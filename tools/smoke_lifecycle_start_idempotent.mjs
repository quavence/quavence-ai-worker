import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const { createWorkerStartGate, resetWorkerStartGateForTests } = require('../src/workerStartGate.cjs');

const mainSource = fs.readFileSync(path.join(root, 'src', 'main.cjs'), 'utf8');

function assert(condition, message) {
  if (!condition) {
    console.error(`Assertion failed: ${message}`);
    process.exit(1);
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function runGateTests() {
  resetWorkerStartGateForTests();

  let running = false;
  let spawnCount = 0;
  const debug = [];

  const gate = createWorkerStartGate({
    isRunning: () => running,
    startImpl: async () => {
      spawnCount += 1;
      await delay(40);
      running = true;
    },
    onDebugLog: (message) => debug.push(message),
  });

  const first = gate({});
  const second = gate({});
  const [firstResult, secondResult] = await Promise.all([first, second]);

  assert(spawnCount === 1, 'concurrent starts should spawn one worker');
  assert(firstResult?.ok === true, 'first start should succeed');
  assert(secondResult?.ok === true, 'second start should succeed');
  assert(
    firstResult?.started === true || secondResult?.started === true,
    'one caller should observe started=true'
  );

  resetWorkerStartGateForTests();
  running = true;
  spawnCount = 0;
  debug.length = 0;

  const alreadyRunningGate = createWorkerStartGate({
    isRunning: () => running,
    startImpl: async () => {
      spawnCount += 1;
    },
    onDebugLog: (message) => debug.push(message),
  });

  const alreadyResult = await alreadyRunningGate({});
  assert(alreadyResult?.alreadyRunning === true, 'running worker should return alreadyRunning');
  assert(spawnCount === 0, 'already running should not spawn');
  assert(debug.some((line) => /worker already running/i.test(line)), 'debug should note already running');
}

function runStaticChecks() {
  assert(mainSource.includes('createWorkerStartGate'), 'main.cjs should use worker start gate');
  assert(mainSource.includes('spawnWorkerProcess'), 'main.cjs should split spawn from idempotent start');
  assert(!/throw new Error\('Worker is already running'\)/.test(mainSource), 'main.cjs should not throw on duplicate start');
  assert(/sendDebugLog\(/.test(mainSource), 'main.cjs should log duplicate start to debug');
}

await runGateTests();
runStaticChecks();
console.log('Lifecycle start idempotent smoke OK');
