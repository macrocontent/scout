import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { estimateCreditsDetailed } from './costs';

describe('estimateCreditsDetailed', () => {
  it('discounts http extract and adds xhr/captcha addons', () => {
    const r = estimateCreditsDetailed('POST', '/v1/extract', {
      fetch_mode: 'http',
      capture_xhr: '*/api/*',
      solve_captcha: true,
    });
    const types = Object.fromEntries(r.items.map((i) => [i.type, i.credits]));
    assert.equal(types.base, 2);
    assert.equal(types.capture_xhr, 1);
    assert.equal(types.solve_captcha, 2);
  });

  it('applies 2.0x multiplier when stealth is enabled', () => {
    const r = estimateCreditsDetailed('POST', '/v1/extract', {
      stealth: true,
    });
    const types = Object.fromEntries(r.items.map((i) => [i.type, i.credits]));
    assert.equal(types.base, 3);
    assert.equal(types.stealth_multiplier, 3);
    assert.equal(r.estimatedCredits, 6);
  });

  it('propagates stealth multiplier through nested jobs estimates', () => {
    const r = estimateCreditsDetailed('POST', '/v1/jobs', {
      requests: [
        {
          type: 'extract',
          body: {
            url: 'https://example.com',
            fields: [{ name: 'h1', selector: 'h1', type: 'text' }],
            stealth: true,
          },
        },
      ],
    });
    const line = r.items.find((item) => item.type === 'job:extract:stealth_multiplier');
    assert.equal(line?.credits, 3);
    assert.equal(r.estimatedCredits, 6);
  });
});
