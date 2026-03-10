import test from 'node:test';
import assert from 'node:assert/strict';
import type { PublishTaskStatus } from '../../contracts/domain.js';
import {
  assertTransition,
  canTransition,
  getAllowedTransitions
} from './publish-state-machine.js';

const validMatrix: Array<{ from: PublishTaskStatus; to: PublishTaskStatus }> = [
  { from: 'approved', to: 'publishing' },
  { from: 'publishing', to: 'waiting_login' },
  { from: 'publishing', to: 'published' },
  { from: 'publishing', to: 'publish_failed' },
  { from: 'waiting_login', to: 'publishing' },
  { from: 'waiting_login', to: 'manual_intervention' },
  { from: 'publish_failed', to: 'manual_intervention' }
];

const invalidMatrix: Array<{ from: PublishTaskStatus; to: PublishTaskStatus }> = [
  { from: 'approved', to: 'published' },
  { from: 'publishing', to: 'manual_intervention' },
  { from: 'manual_intervention', to: 'publishing' },
  { from: 'published', to: 'waiting_login' }
];

test('state machine matrix accepts all valid transitions', () => {
  for (const row of validMatrix) {
    assert.equal(canTransition(row.from, row.to), true, `${row.from} -> ${row.to} should be allowed`);
    assert.doesNotThrow(() => assertTransition(row.from, row.to));
  }
});

test('state machine matrix rejects all invalid transitions', () => {
  for (const row of invalidMatrix) {
    assert.equal(canTransition(row.from, row.to), false, `${row.from} -> ${row.to} should be rejected`);
    assert.throws(() => assertTransition(row.from, row.to), /invalid transition/);
  }
});

test('allowed transition list for waiting_login is stable', () => {
  assert.deepEqual(getAllowedTransitions('waiting_login'), ['publishing', 'manual_intervention']);
});

