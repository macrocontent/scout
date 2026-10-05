import type { Page } from 'playwright';
import { pageEvaluate, pageEvaluateNoArg } from '../browser/playwrightEvaluate';

export type CaptchaSignal = {
  captcha_detected: boolean;
  signals: Array<{ id: string; evidence: string }>;
};

/**
 * Heuristic captcha / challenge detection — facts only, no bypass.
 */
export async function detectCaptcha(page: Page): Promise<CaptchaSignal> {
  return pageEvaluateNoArg(page, () => {
    const signals: Array<{ id: string; evidence: string }> = [];
    const title = (document.title || '').toLowerCase();
    const html = document.documentElement.innerHTML.slice(0, 250_000).toLowerCase();
    const text = (document.body?.innerText || '').slice(0, 20_000).toLowerCase();

    const checks: Array<[string, boolean, string]> = [
      ['recaptcha', /recaptcha|g-recaptcha|grecaptcha/.test(html), 'recaptcha marker in DOM'],
      ['hcaptcha', /hcaptcha|h-captcha/.test(html), 'hcaptcha marker in DOM'],
      ['turnstile', /cf-turnstile|challenges\.cloudflare\.com/.test(html), 'cloudflare turnstile marker'],
      ['cloudflare_challenge', /cf-browser-verification|just a moment|attention required/.test(html) || title.includes('just a moment'), 'cloudflare challenge page'],
      ['datadome', /datadome|dd\.js/.test(html), 'datadome marker'],
      ['perimeterx', /perimeterx|_px/.test(html), 'perimeterx marker'],
      ['arkose', /arkose|funcaptcha/.test(html), 'arkose/funcaptcha marker'],
      ['geetest', /geetest/.test(html), 'geetest marker'],
      ['captcha_text', /\bcaptcha\b/.test(text) && (text.includes('verify') || text.includes('robot') || text.includes('human')), 'captcha wording in page text'],
    ];

    for (const [id, hit, evidence] of checks) {
      if (hit) signals.push({ id, evidence });
    }

    // iframe heuristics
    const iframes = Array.from(document.querySelectorAll('iframe[src]'));
    for (const iframe of iframes.slice(0, 20)) {
      const src = (iframe.getAttribute('src') || '').toLowerCase();
      if (src.includes('recaptcha')) signals.push({ id: 'recaptcha_iframe', evidence: src.slice(0, 200) });
      if (src.includes('hcaptcha')) signals.push({ id: 'hcaptcha_iframe', evidence: src.slice(0, 200) });
      if (src.includes('challenges.cloudflare')) signals.push({ id: 'turnstile_iframe', evidence: src.slice(0, 200) });
    }

    // dedupe by id
    const seen = new Set<string>();
    const unique = signals.filter((s) => {
      if (seen.has(s.id)) return false;
      seen.add(s.id);
      return true;
    });

    return {
      captcha_detected: unique.length > 0,
      signals: unique,
    };
  });
}

/** True when a challenge still blocks the page (not merely leftover recaptcha script tags). */
export async function challengeStillBlocking(page: Page): Promise<boolean> {
  return pageEvaluateNoArg(page, () => {
    const title = (document.title || '').toLowerCase();
    if (title.includes('just a moment') || title.includes('attention required')) return true;

    const visible = (el: Element | null) => {
      if (!el || !(el instanceof HTMLElement)) return false;
      const style = window.getComputedStyle(el);
      if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') return false;
      const box = el.getBoundingClientRect();
      return box.width > 2 && box.height > 2;
    };

    const tokenValue = (selector: string) => {
      const el = document.querySelector<HTMLTextAreaElement | HTMLInputElement>(selector);
      return Boolean(el?.value && el.value.length > 20);
    };

    if (visible(document.querySelector('iframe[src*="recaptcha"][src*="bframe"]'))) return true;
    if (visible(document.querySelector('iframe[src*="hcaptcha.com"][src*="challenge"]'))) return true;
    if (document.querySelector('.g-recaptcha, iframe[src*="recaptcha"]') && !tokenValue('#g-recaptcha-response') && !tokenValue('textarea[name="g-recaptcha-response"]')) {
      const checkboxIframe = document.querySelector('iframe[src*="recaptcha"][src*="anchor"]');
      if (visible(checkboxIframe) || visible(document.querySelector('.g-recaptcha'))) return true;
    }
    if (document.querySelector('.h-captcha, iframe[src*="hcaptcha"]') && !tokenValue('textarea[name="h-captcha-response"]')) {
      return true;
    }
    if (document.querySelector('.cf-turnstile, iframe[src*="challenges.cloudflare.com"]') && !tokenValue('input[name="cf-turnstile-response"]')) {
      return true;
    }

    const html = document.documentElement.innerHTML.slice(0, 80_000).toLowerCase();
    if (/datadome|perimeterx|_px\b/.test(html) && (title.includes('denied') || title.includes('blocked') || html.includes('access denied'))) {
      return true;
    }
    return false;
  });
}
