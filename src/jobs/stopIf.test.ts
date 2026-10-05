import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { matchesStopIf, stopReason, StopIfSchema } from './stopIf';

describe('matchesStopIf', () => {
  it('returns false when stop_if is missing', () => {
    assert.equal(matchesStopIf(undefined, { visible: false }), false);
  });

  it('stops when visibility matches stop_if.visible=false', () => {
    assert.equal(matchesStopIf({ visible: false }, { visible: false, exists: true }), true);
  });

  it('continues when visibility is true and stop_if wants false', () => {
    assert.equal(matchesStopIf({ visible: false }, { visible: true, exists: true }), false);
  });

  it('matches overall_pass and status together', () => {
    assert.equal(
      matchesStopIf({ overall_pass: false, status: 'missing' }, { overall_pass: false, status: 'missing' }),
      true,
    );
    assert.equal(
      matchesStopIf({ overall_pass: false, status: 'missing' }, { overall_pass: false, status: 'hidden' }),
      false,
    );
  });

  it('rejects empty stop_if objects', () => {
    assert.equal(StopIfSchema.safeParse({}).success, false);
    assert.equal(StopIfSchema.safeParse({ visible: false }).success, true);
  });

  it('formats stop reason', () => {
    assert.match(stopReason({ visible: false }, 0), /step 0/);
    assert.match(stopReason({ visible: false }, 0), /visible=false/);
  });
});
