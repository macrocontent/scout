import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { prepareBrowseAccess, browseRuntimeMeta, toPageBrowseOptions } from './browseOptions';
import { ScoutError } from './errors';

describe('browse options stealth runtime', () => {
  it('maps stealth flag to runtime selection', () => {
    const normal = toPageBrowseOptions({});
    const stealth = toPageBrowseOptions({ stealth: true });
    assert.equal(normal.runtime, 'chromium');
    assert.equal(stealth.runtime, 'stealth');
  });

  it('rejects stealth for free tier on hosted cloud', async () => {
    await assert.rejects(
      () =>
        prepareBrowseAccess({
          url: 'https://example.com',
          apiKey: 'sk_scout_test',
          tier: 'free',
          browse: { stealth: true },
        }),
      (err: unknown) => err instanceof ScoutError && err.code === 'STEALTH_TIER_NOT_ALLOWED',
    );
  });

  it('exposes browser_runtime in response metadata', () => {
    assert.deepEqual(browseRuntimeMeta({}), { browser_runtime: 'chromium' });
    assert.deepEqual(browseRuntimeMeta({ stealth: true }), { browser_runtime: 'stealth' });
  });
});
