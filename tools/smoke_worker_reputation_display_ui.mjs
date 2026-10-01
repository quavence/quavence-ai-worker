#!/usr/bin/env node
import {
  formatWorkerReputationLine,
  formatWorkerReputationScore,
} from '../src/renderer-react/workerUiHelpers.js';
import { formatAdminReputationBadge } from '../../src/services/aiWorkerReputationDisplayService.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const baselineNode = {
  reputation_display: {
    score: 0.5,
    score_label: '0.50',
    samples: 0,
    tier: 'baseline',
    label: 'Baseline',
    caption: 'New worker baseline',
    updated_at: null,
  },
};

const formatted = formatWorkerReputationScore(baselineNode);
assert(formatted?.text === '0.50 · Baseline', `desktop baseline text mismatch: ${formatted?.text}`);
assert(
  formatted?.title === 'New worker baseline',
  `desktop baseline title mismatch: ${formatted?.title}`,
);

assert(
  formatWorkerReputationLine(baselineNode) === '0.50 · Baseline',
  `desktop helper line mismatch: ${formatWorkerReputationLine(baselineNode)}`,
);

assert(
  formatAdminReputationBadge(baselineNode.reputation_display) === 'Rep 0.50 · baseline',
  `admin badge mismatch: ${formatAdminReputationBadge(baselineNode.reputation_display)}`,
);

const suspendedNode = {
  reputation_display: {
    score: 0.73,
    score_label: '0.73',
    samples: 8,
    tier: 'under_review',
    label: 'Under review',
    caption: 'Worker quality or policy review is active.',
    updated_at: null,
  },
};

assert(
  formatWorkerReputationScore(suspendedNode)?.text === 'Under review',
  'desktop suspended text mismatch',
);

console.log('smoke_worker_reputation_display_ui: ALL OK');
