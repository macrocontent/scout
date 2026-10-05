import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  STEALTH_DEFAULT_USER_AGENT,
  STEALTH_PROFILE,
  applyStealthDefaults,
  buildStealthInitScript,
  chromeMajorFromBrowserVersion,
  getStealthLaunchOptions,
  getStealthRuntimeStatus,
  stealthRuntimeEnabledFromEnv,
} from './stealth';

describe('stealth runtime helpers', () => {
  it('reads SCOUT_STEALTH_RUNTIME_ENABLED', () => {
    assert.equal(stealthRuntimeEnabledFromEnv({ SCOUT_STEALTH_RUNTIME_ENABLED: 'true' }), true);
    assert.equal(stealthRuntimeEnabledFromEnv({ SCOUT_STEALTH_RUNTIME_ENABLED: '0' }), false);
    assert.equal(stealthRuntimeEnabledFromEnv({}), false);
  });

  it('parses Chrome major from Playwright browser.version()', () => {
    assert.equal(chromeMajorFromBrowserVersion('Chrome/134.0.6998.35'), 134);
    assert.equal(chromeMajorFromBrowserVersion('HeadlessChrome/133.0.1.0'), 133);
    assert.equal(chromeMajorFromBrowserVersion('bogus'), 134);
  });

  it('applies Linux Chrome defaults matching major', () => {
    const out = applyStealthDefaults({ chromeMajor: 134 });
    assert.equal(out.userAgent, STEALTH_DEFAULT_USER_AGENT);
    assert.match(out.userAgent, /Linux x86_64/);
    assert.equal(out.locale, 'en-US');
    assert.match(out.extraHTTPHeaders['Accept-Language'] ?? '', /en-US/);
    assert.ok(out.extraHTTPHeaders['Sec-CH-UA']?.includes('"Chromium";v="134"'));
    assert.equal(out.extraHTTPHeaders['Sec-CH-UA-Platform'], '"Linux"');
  });

  it('preserves caller UA and headers', () => {
    const out = applyStealthDefaults({
      userAgent: 'CustomBot/1.0',
      extraHTTPHeaders: { 'X-Test': '1', 'Accept-Language': 'de-DE' },
    });
    assert.equal(out.userAgent, 'CustomBot/1.0');
    assert.equal(out.extraHTTPHeaders['X-Test'], '1');
    assert.equal(out.extraHTTPHeaders['Accept-Language'], 'de-DE');
  });

  it('init script hides webdriver and sets chrome + webgl patches', () => {
    const script = buildStealthInitScript();
    assert.match(script, /webdriver/);
    assert.match(script, /chrome/);
    assert.match(script, /permissions/);
    assert.match(script, /37445/);
  });

  it('launch options strip automation and use full Chromium', () => {
    const launch = getStealthLaunchOptions(['--no-sandbox']);
    assert.equal(launch.channel, 'chromium');
    assert.deepEqual(launch.ignoreDefaultArgs, ['--enable-automation']);
    assert.ok(launch.args.includes('--disable-blink-features=AutomationControlled'));
  });

  it('reports runtime status for health', () => {
    const off = getStealthRuntimeStatus({});
    assert.equal(off.enabled, false);
    const on = getStealthRuntimeStatus({ SCOUT_STEALTH_RUNTIME_ENABLED: 'yes' });
    assert.equal(on.enabled, true);
    assert.equal(on.profile, STEALTH_PROFILE);
  });
});
