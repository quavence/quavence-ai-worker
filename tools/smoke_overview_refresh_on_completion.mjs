import { shouldRefreshOverviewOnLogLine } from '../src/renderer-react/workerUiHelpers.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const taskId = 'ba06e8b2-1111-2222-3333-444455556666';
const completedLine = `[12:02:00] INFO task completed: ${taskId} (~$0.05 USD → 0.02 QVNC)`;
const claimedLine = `[12:01:00] INFO task claimed: ${taskId} (TASK_RISK_FLAGS)`;

const first = shouldRefreshOverviewOnLogLine(completedLine, null);
assert(first.refresh === true, 'task completed log should trigger overview refresh');
assert(first.taskId === taskId, 'refresh decision should include task id');

const duplicate = shouldRefreshOverviewOnLogLine(completedLine, taskId);
assert(duplicate.refresh === false, 'same task completion should not trigger duplicate refresh');

const claimed = shouldRefreshOverviewOnLogLine(claimedLine, null);
assert(claimed.refresh === false, 'task claimed should not trigger overview refresh');

console.log('smoke_overview_refresh_on_completion: PASS');
