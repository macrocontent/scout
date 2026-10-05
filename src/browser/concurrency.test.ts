import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { BrowserConcurrencyGate, browserAcquireTimeoutMs } from './concurrency';
import { ScoutError } from '../lib/errors';

describe('BrowserConcurrencyGate', () => {
  it('transfers a permit to a waiter without double-counting', async () => {
    const gate = new BrowserConcurrencyGate(1);
    await gate.acquire(0);
    assert.equal(gate.inUse, 1);

    let waiterReady = false;
    const waiter = gate.acquire(5_000).then(() => {
      waiterReady = true;
    });
    await new Promise((r) => setImmediate(r));
    assert.equal(waiterReady, false);
    assert.equal(gate.inUse, 1);

    gate.release();
    await waiter;
    assert.equal(waiterReady, true);
    assert.equal(gate.inUse, 1);

    gate.release();
    assert.equal(gate.inUse, 0);
  });

  it('rejects waiters after acquire timeout and frees the queue', async () => {
    const gate = new BrowserConcurrencyGate(1);
    await gate.acquire(0);
    await assert.rejects(() => gate.acquire(20), (err: unknown) => {
      assert.ok(err instanceof ScoutError);
      assert.equal(err.code, 'TIMEOUT');
      return true;
    });
    assert.equal(gate.inUse, 1);
    gate.release();
    assert.equal(gate.inUse, 0);
    await gate.acquire(50);
    assert.equal(gate.inUse, 1);
    gate.release();
  });
});

describe('browserAcquireTimeoutMs', () => {
  it('defaults to 120s', () => {
    assert.equal(browserAcquireTimeoutMs({}), 120_000);
  });
});
