import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { stripEsbuildNameHelpers, toPlaywrightFunction } from './playwrightEvaluate';

describe('stripEsbuildNameHelpers', () => {
  it('unwraps keepNames __name wrappers', () => {
    const src = '__name((x) => x + 1, "add")';
    assert.equal(stripEsbuildNameHelpers(src), '(x) => x + 1');
    const fn = toPlaywrightFunction((x: number) => x + 1);
    assert.equal(fn(2), 3);
  });
});
