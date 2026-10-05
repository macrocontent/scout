import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { ADAPTIVE_MIN_SCORE, parseSelectorHint, scoreCandidate } from './adaptiveSelector';
import { loadSecurityPolicy } from './securityPolicy';
import { urlMatchesXhrPattern } from './xhrCapture';

describe('parseSelectorHint', () => {
  it('reads id, tag, and classes from the last compound', () => {
    const hint = parseSelectorHint('section.hero a.btn-primary#buy');
    assert.equal(hint.tag, 'a');
    assert.equal(hint.id, 'buy');
    assert.deepEqual(hint.classes, ['btn-primary']);
  });
});

describe('scoreCandidate', () => {
  it('scores class overlap and match text', () => {
    const hint = parseSelectorHint('button.checkout');
    const score = scoreCandidate({
      tag: 'button',
      classList: ['checkout', 'primary'],
      text: 'Buy now',
      hint,
      matchText: 'Buy',
    });
    assert.ok(score >= ADAPTIVE_MIN_SCORE);
  });
});

describe('urlMatchesXhrPattern', () => {
  it('matches globs', () => {
    assert.equal(urlMatchesXhrPattern('https://shop.example/api/pricing', '*/api/pricing*'), true);
    assert.equal(urlMatchesXhrPattern('https://shop.example/api/pricing', '/v1/other'), false);
  });
});

describe('loadSecurityPolicy', () => {
  it('never requires domain verify in self_hosted even if env asks', () => {
    const policy = loadSecurityPolicy('self_hosted', {
      SCOUT_REQUIRE_DOMAIN_VERIFY: 'true',
      SCOUT_SECURITY_POLICY: JSON.stringify({ requireDomainVerification: true }),
    });
    assert.equal(policy.requireDomainVerification, false);
  });

  it('defaults hosted to require verify', () => {
    const policy = loadSecurityPolicy('hosted', {});
    assert.equal(policy.requireDomainVerification, true);
  });
});
