#!/usr/bin/env node
import {
  buildSetupChecklist,
  buildActivityFeed,
  dedupeActivityEvents,
  isHubNormalIdleState,
} from '../src/renderer-react/workerUiHelpers.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

assert(isHubNormalIdleState('online'), 'online is normal idle');
assert(isHubNormalIdleState('waiting'), 'waiting is normal idle');
assert(isHubNormalIdleState('duplicate_blocked'), 'duplicate_blocked is normal idle');
assert(!isHubNormalIdleState('token_invalid'), 'token invalid is not idle');
assert(!isHubNormalIdleState('offline'), 'offline is not idle');

const waitingChecklist = buildSetupChecklist({
  hasUsableToken: true,
  hasStoredToken: true,
  runtimeCheck: { ollamaReachable: true, generationModelAvailable: true, embeddingModelAvailable: true },
  llmProvider: 'ollama',
  hubState: 'waiting',
  suspension: null,
});
const hubRow = waitingChecklist.find((item) => item.id === 'hub');
assert(hubRow?.ok, 'waiting hub row must be ok (no setup banner)');
assert(hubRow?.label === 'Waiting for tasks', 'hub label stays Waiting for tasks');
assert(!waitingChecklist.some((item) => !item.ok && item.id === 'hub'), 'hub must not trigger banner');

const deduped = dedupeActivityEvents([
  { text: 'Waiting for tasks', tone: 'neutral', time: '12:00:01', kind: 'waiting_idle' },
  { text: 'Waiting for tasks', tone: 'neutral', time: '12:00:15', kind: 'waiting_idle' },
  { text: 'Waiting for tasks · last heartbeat 12:01', tone: 'neutral', time: '12:01:00', kind: 'waiting_idle' },
], 60000);
assert(deduped.length === 1, 'waiting idle events must collapse to one');
assert(!deduped[0].text.includes('×'), 'waiting idle must not show multiplied warning count');

const feed = buildActivityFeed(
  [
    '[12:00:01] Waiting for tasks',
    '[12:00:15] Waiting for tasks',
  ],
  {
    limit: 6,
    context: {
      hubState: 'waiting',
      statusRunning: true,
      currentTask: null,
      lastHubContactLabel: '12:01',
    },
  },
);
assert(feed.some((item) => /Waiting for tasks/i.test(item.text)), 'activity feed keeps waiting heartbeat');

console.log('smoke_worker_idle_hub_ui: PASS');
