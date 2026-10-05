import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Response } from 'express';
import { scoutDemoKeyGuard } from './demoGuard';
import type { ScoutAuthRequest } from './middleware';

function mockRes() {
  const out: { statusCode?: number; body?: unknown } = {};
  const res = {
    status(code: number) {
      out.statusCode = code;
      return this;
    },
    json(body: unknown) {
      out.body = body;
      return this;
    },
  } as unknown as Response;
  return { res, out };
}

describe('scoutDemoKeyGuard', () => {
  it('lets non-demo keys through', () => {
    const req = { scoutKey: { tier: 'pro', key: 'sk' }, path: '/jobs', body: {} } as ScoutAuthRequest;
    let next = false;
    scoutDemoKeyGuard(req, mockRes().res, () => {
      next = true;
    });
    assert.equal(next, true);
  });

  it('blocks jobs on the demo key', () => {
    const req = { scoutKey: { tier: 'demo', key: 'demo' }, path: '/jobs', body: {} } as ScoutAuthRequest;
    const { res, out } = mockRes();
    let next = false;
    scoutDemoKeyGuard(req, res, () => {
      next = true;
    });
    assert.equal(next, false);
    assert.equal(out.statusCode, 403);
  });

  it('allows screenshot/json and strips evaluate', () => {
    const req = {
      scoutKey: { tier: 'demo', key: 'demo' },
      path: '/screenshot/json',
      body: { evaluate: '1+1', wait_ms: 60_000, max_pages: 99 },
    } as ScoutAuthRequest;
    const { res, out } = mockRes();
    let next = false;
    scoutDemoKeyGuard(req, res, () => {
      next = true;
    });
    assert.equal(next, false);
    assert.equal(out.statusCode, 403);
  });

  it('clamps crawl fields on allowed paths', () => {
    const body: Record<string, unknown> = { max_pages: 99, max_depth: 9, wait_ms: 30_000 };
    const req = {
      scoutKey: { tier: 'demo', key: 'demo' },
      path: '/crawl',
      body,
    } as ScoutAuthRequest;
    let next = false;
    scoutDemoKeyGuard(req, mockRes().res, () => {
      next = true;
    });
    assert.equal(next, true);
    assert.equal(body.max_pages, 8);
    assert.equal(body.max_depth, 2);
    assert.equal(body.wait_ms, 8_000);
  });
});
