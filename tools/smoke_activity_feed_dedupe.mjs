import {
  buildActivityFeed,
  dedupeActivityEvents,
  parseProgressEvent,
} from '../src/renderer-react/workerUiHelpers.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const taskId = 'ba06e8b2-1111-2222-3333-444455556666';

const claimedLines = [
  `[12:01:02] task claimed: ${taskId} (TASK_RISK_FLAGS)`,
  `[12:01:05] task claimed: ${taskId} (TASK_RISK_FLAGS)`,
  `[12:01:08] task claimed: ${taskId} (TASK_RISK_FLAGS)`,
];

const feed = buildActivityFeed(claimedLines, { limit: 10 });
const claimedRows = feed.filter((item) => /task claimed/i.test(item.text));
assert(claimedRows.length === 1, 'repeated task claims should collapse to one activity row');
assert(
  claimedRows[0].text === 'Task claimed (TASK_RISK_FLAGS)',
  'task claimed label should stay product-friendly',
);

const completedLine = `[12:02:00] task completed: ${taskId} ~$0.05 USD → 0.02 QVNC`;
const completed = parseProgressEvent(completedLine);
assert(
  completed.label === 'Task completed · + $0.05 / ≈ 0.02 QVNC',
  'completed reward label should use compact product format',
);

const workerStarted = dedupeActivityEvents([
  { time: '12:00:01', text: 'Worker started', tone: 'neutral' },
  { time: '12:00:02', text: 'Worker started', tone: 'neutral' },
], 60000);
assert(workerStarted.length === 1, 'text-only events should still merge within 60s window');
assert(workerStarted[0].text === 'Worker started ×2', 'text-only merge should show repeat count');

console.log('smoke_activity_feed_dedupe: PASS');
