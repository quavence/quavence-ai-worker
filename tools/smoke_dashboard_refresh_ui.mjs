#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildWorkerProtectionRows,
  compactProtectionRows,
  resolveTasksDoneToday,
} from '../src/renderer-react/workerUiHelpers.js';

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const appSource = fs.readFileSync(path.join(root, 'src/renderer-react/App.jsx'), 'utf8');
const stylesSource = fs.readFileSync(path.join(root, 'src/renderer-react/styles.css'), 'utf8');

assert(!appSource.includes('dashboardRefresh'), 'flag state must be removed');
assert(!appSource.includes('worker.ui.dashboardRefresh'), 'localStorage flag key must be removed');
assert(!appSource.includes('Dashboard refresh (test copy)'), 'Debug toggle must be removed');
assert(!appSource.includes('session-stats'), 'legacy Session aside must be gone');
assert(!appSource.includes('Eligible accrued'), 'legacy money KPI row must be gone');
assert(
  appSource.includes('dash-columns-hero')
    && appSource.includes('dash-hero')
    && appSource.includes('Your contribution')
    && appSource.includes('power-btn-hero'),
  'approved hero + contribution dashboard must be default',
);
assert(
  stylesSource.includes('.dashboard .dash-columns-hero')
    && stylesSource.includes('.dashboard .contribution-card')
    && stylesSource.includes('.dashboard .power-btn-hero')
    && !stylesSource.includes('dashboard--refresh'),
  'refresh CSS must be promoted to .dashboard (no flag class)',
);
assert(
  stylesSource.includes('--topbar-h: 56px')
    && stylesSource.includes('.worker-app .seg-nav-item'),
  'scaled chrome must apply on default worker-app',
);

const fullRows = buildWorkerProtectionRows({
  overview: { has_node: true, device_binding: { status: 'active' } },
  hasStoredToken: true,
  hasUsableToken: true,
  localDeviceId: 'dev-1',
});
assert(compactProtectionRows(fullRows).some((row) => row.id === 'hub-managed-checks'), 'compact helper remains');
assert(resolveTasksDoneToday({ tasks: { done_today: 4 } }, []) === 4, 'done_today helper remains');

console.log('smoke_dashboard_refresh_ui: PASS');
