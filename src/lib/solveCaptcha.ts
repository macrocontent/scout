import type { Page } from 'playwright';
import { detectCaptcha, type CaptchaSignal } from './captcha';

export type SolveCaptchaResult = {
  captcha_detected: boolean;
  captcha_solved: boolean;
  captcha_signals: Array<{ id: string; evidence: string }>;
};

const DEFAULT_CHALLENGE_TIMEOUT_MS = 18_000;
const POLL_MS = 450;

export function isCloudflareInterstitial(signals: Array<{ id: string }>): boolean {
  return signals.some((s) => s.id === 'cloudflare_challenge');
}

export function hasTurnstileSignal(signals: Array<{ id: string }>): boolean {
  return signals.some((s) => s.id === 'turnstile' || s.id === 'turnstile_iframe');
}

export function hasCheckboxCaptchaSignal(signals: Array<{ id: string }>): boolean {
  return signals.some(
    (s) =>
      s.id === 'turnstile' ||
      s.id === 'turnstile_iframe' ||
      s.id === 'recaptcha' ||
      s.id === 'recaptcha_iframe' ||
      s.id === 'hcaptcha' ||
      s.id === 'hcaptcha_iframe',
  );
}

function challengeMayAutoPass(signals: Array<{ id: string }>): boolean {
  return isCloudflareInterstitial(signals) || hasTurnstileSignal(signals);
}

async function waitForChallengeClear(page: Page, timeoutMs: number): Promise<CaptchaSignal> {
  const deadline = Date.now() + Math.max(0, timeoutMs);
  let latest = await detectCaptcha(page);
  while (Date.now() < deadline && latest.captcha_detected && challengeMayAutoPass(latest.signals)) {
    await page.waitForTimeout(POLL_MS);
    await page.waitForLoadState('domcontentloaded').catch(() => undefined);
    latest = await detectCaptcha(page);
  }
  return latest;
}

async function clickOwnedSiteWidgets(page: Page): Promise<void> {
  const frames = page.frames().filter((f) =>
    /turnstile|challenges\.cloudflare|recaptcha|hcaptcha/i.test(f.url()),
  );
  for (const frame of frames) {
    const checkbox = frame.locator(
      'input[type="checkbox"], [role="checkbox"], .ctp-checkbox-label, #recaptcha-anchor, .recaptcha-checkbox',
    );
    if (await checkbox.count().catch(() => 0)) {
      await checkbox
        .first()
        .click({ timeout: 3500 })
        .catch(() => undefined);
    } else {
      await frame
        .locator('body')
        .click({ timeout: 2000, position: { x: 28, y: 32 } })
        .catch(() => undefined);
    }
  }

  const hosts = page.locator(
    '.cf-turnstile, iframe[src*="challenges.cloudflare.com"], iframe[src*="turnstile"], iframe[src*="recaptcha"], iframe[src*="hcaptcha"]',
  );
  const n = await hosts.count().catch(() => 0);
  for (let i = 0; i < Math.min(n, 4); i++) {
    const box = await hosts.nth(i).boundingBox().catch(() => null);
    if (!box) continue;
    await page.mouse.click(box.x + Math.min(28, box.width / 3), box.y + box.height / 2).catch(() => undefined);
  }
}

/**
 * Best-effort challenge handling on **owned** sites (domain verify / self-host).
 * Waits for Cloudflare JS / managed Turnstile to auto-pass (needs stealth runtime),
 * then clicks visible checkbox widgets. Does not solve image/audio puzzles or use solving APIs.
 */
export async function maybeSolveCaptcha(
  page: Page,
  enabled: boolean | undefined,
  options?: { timeoutMs?: number },
): Promise<SolveCaptchaResult | undefined> {
  if (!enabled) return undefined;

  const timeoutMs = options?.timeoutMs ?? DEFAULT_CHALLENGE_TIMEOUT_MS;
  const started = Date.now();
  const first = await detectCaptcha(page);
  if (!first.captcha_detected) {
    return { captcha_detected: false, captcha_solved: false, captcha_signals: [] };
  }

  let current = first;
  if (challengeMayAutoPass(current.signals)) {
    current = await waitForChallengeClear(page, timeoutMs);
  }

  if (current.captcha_detected && hasCheckboxCaptchaSignal(current.signals)) {
    await page.waitForTimeout(350);
    await clickOwnedSiteWidgets(page);
    const remaining = timeoutMs - (Date.now() - started);
    current = await waitForChallengeClear(page, Math.max(3_000, remaining));
  }

  return {
    captcha_detected: current.captcha_detected,
    captcha_solved: first.captcha_detected && !current.captcha_detected,
    captcha_signals: current.signals.length ? current.signals : first.signals,
  };
}
