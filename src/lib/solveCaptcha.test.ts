import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import {
  hasCheckboxCaptchaSignal,
  hasTurnstileSignal,
  isCloudflareInterstitial,
} from './solveCaptcha';

describe('owned-site captcha helpers', () => {
  it('detects Cloudflare interstitial vs widget', () => {
    assert.equal(isCloudflareInterstitial([{ id: 'cloudflare_challenge' }]), true);
    assert.equal(isCloudflareInterstitial([{ id: 'turnstile' }]), false);
    assert.equal(hasTurnstileSignal([{ id: 'turnstile_iframe' }]), true);
    assert.equal(hasCheckboxCaptchaSignal([{ id: 'recaptcha' }]), true);
    assert.equal(hasCheckboxCaptchaSignal([{ id: 'datadome' }]), false);
  });
});
