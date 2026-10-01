#!/usr/bin/env node
import {
  countTodayCompletedTasks,
  resolveTasksDoneToday,
} from '../src/renderer-react/workerUiHelpers.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const memoryStorage = () => {
  const map = new Map();
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)); },
    removeItem: (key) => { map.delete(key); },
  };
};

const storage = memoryStorage();
const idA = '11111111-1111-1111-1111-111111111111';
const idB = '22222222-2222-2222-2222-222222222222';

assert(countTodayCompletedTasks([], storage) === 0, 'empty logs => 0');

const logs = [
  `[10:00:00] INFO task completed: ${idA} (~$0.01 USD → 0.01 QVNC)`,
  `[10:01:00] INFO task completed: ${idA} (~$0.01 USD → 0.01 QVNC)`,
  `[11:00:00] INFO task completed: ${idB}`,
];
assert(countTodayCompletedTasks(logs, storage) === 2, 'dedupe by task id across logs');
assert(countTodayCompletedTasks([], storage) === 2, 'persisted count survives empty logs / restart');

assert(
  resolveTasksDoneToday({ tasks: { done_today: 7 } }, logs, storage) === 7,
  'hub done_today wins over local',
);
assert(
  resolveTasksDoneToday({ tasks: { done: 48 } }, [], storage) === 2,
  'missing done_today falls back to persisted local count',
);
assert(
  resolveTasksDoneToday({ tasks: { done_today: '3' } }, [], storage) === 3,
  'numeric string done_today is accepted',
);

console.log('smoke_tasks_done_today: PASS');
