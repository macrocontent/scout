import type { Page } from 'playwright';
import { pageEvaluate } from '../browser/playwrightEvaluate';

export type CookieBannerResult = {
  cookie_banner_detected: boolean;
  cookie_banner_dismissed: boolean;
  /** Best-effort CMP id when recognized */
  cookie_banner_vendor: string | null;
};

/** Known CMP root / dialog containers (detection + scoped clicks). */
const VENDOR_CONTAINERS: Array<{ id: string; selector: string }> = [
  { id: 'onetrust', selector: '#onetrust-banner-sdk, #onetrust-consent-sdk, #onetrust-pc-sdk' },
  { id: 'cookiebot', selector: '#CybotCookiebotDialog, #CookiebotWidget' },
  { id: 'usercentrics', selector: '#usercentrics-root, [data-testid="uc-container"]' },
  { id: 'didomi', selector: '#didomi-host, #didomi-notice' },
  { id: 'quantcast', selector: '.qc-cmp2-container, #qc-cmp2-ui' },
  { id: 'trustarc', selector: '#truste-consent-track, .truste_overlay, #consent-banner' },
  { id: 'klaro', selector: '.klaro .cookie-modal, .klaro .cm-modal' },
  { id: 'borlabs', selector: '#BorlabsCookieBox, .borlabs-cookie' },
  { id: 'cookieyes', selector: '.cky-consent-container, .cky-modal' },
  { id: 'complianz', selector: '#cmplz-cookiebanner-container, .cmplz-cookiebanner' },
  { id: 'osano', selector: '.osano-cm-window, .osano-cm-dialog' },
  { id: 'iubenda', selector: '#iubenda-cs-banner, .iubenda-cs-container' },
  { id: 'generic', selector: '[id*="cookie"][role="dialog"], [class*="cookie-banner"], [class*="cookie-consent"], [aria-label*="cookie" i]' },
];

/**
 * Fixed accept / dismiss buttons only — never customer-supplied selectors.
 * Prefer “accept all” style controls that remove the overlay so content is readable.
 */
const ACCEPT_SELECTORS = [
  '#onetrust-accept-btn-handler',
  'button#onetrust-accept-btn-handler',
  '#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll',
  '#CybotCookiebotDialogBodyButtonAccept',
  '#CybotCookiebotDialogBodyLevelButtonAccept',
  'button[data-testid="uc-accept-all-button"]',
  '#uc-btn-accept-banner',
  'button[data-action="accept-all"]',
  '#didomi-notice-agree-button',
  'button.didomi-continue-without-agreeing',
  '.qc-cmp2-summary-buttons button[mode="primary"]',
  'button.qc-cmp2-btn-primary',
  'a.borlabs-cookie-btn[data-cookie-accept-all]',
  'button.cky-btn-accept',
  '.cmplz-accept',
  '.cmplz-btn.cmplz-accept',
  '.osano-cm-accept-all',
  '#iubenda-cs-accept-btn, .iubenda-cs-accept-btn',
  'button[aria-label="Accept all"]',
  'button[aria-label="Alle akzeptieren"]',
];

const ACCEPT_TEXT =
  /^(accept\s*all|allow\s*all|accept\s*cookies|i\s*agree|alle\s*akzeptieren|alle\s*cookies\s*akzeptieren|zustimmen|akzeptieren|agree|got\s*it|ok,\s*got\s*it)$/i;

const emptyResult = (): CookieBannerResult => ({
  cookie_banner_detected: false,
  cookie_banner_dismissed: false,
  cookie_banner_vendor: null,
});

async function detectVendor(page: Page): Promise<{ detected: boolean; vendor: string | null }> {
  return pageEvaluate(page, (vendors) => {
    for (const v of vendors) {
      try {
        if (document.querySelector(v.selector)) return { detected: true, vendor: v.id };
      } catch {
        /* invalid selector in some browsers — skip */
      }
    }
    const text = (document.body?.innerText || '').slice(0, 8_000).toLowerCase();
    if (
      text.includes('cookie') &&
      (text.includes('accept') || text.includes('akzeptieren') || text.includes('consent'))
    ) {
      return { detected: true, vendor: 'text_heuristic' };
    }
    return { detected: false, vendor: null };
  }, VENDOR_CONTAINERS);
}

async function tryClickSelector(page: Page, selector: string): Promise<boolean> {
  try {
    const loc = page.locator(selector).first();
    if ((await loc.count()) === 0) return false;
    if (!(await loc.isVisible({ timeout: 400 }).catch(() => false))) return false;
    await loc.click({ timeout: 2_000, force: false });
    return true;
  } catch {
    return false;
  }
}

async function tryClickAcceptText(page: Page): Promise<boolean> {
  try {
    const buttons = page.locator('button, a[role="button"], [role="button"]');
    const count = Math.min(await buttons.count(), 40);
    for (let i = 0; i < count; i++) {
      const btn = buttons.nth(i);
      if (!(await btn.isVisible().catch(() => false))) continue;
      const label = ((await btn.innerText().catch(() => '')) || '').replace(/\s+/g, ' ').trim();
      if (!label || label.length > 48) continue;
      if (!ACCEPT_TEXT.test(label)) continue;
      await btn.click({ timeout: 2_000 });
      return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

/**
 * Best-effort cookie-banner dismiss for read-only browser ops.
 * Does **not** accept customer selectors — fixed CMP allowlist only.
 * Safe without domain verify (unlike free journey interact).
 */
export async function dismissCookieBanner(page: Page): Promise<CookieBannerResult> {
  // CMP widgets often paint after first paint
  await page.waitForTimeout(450);

  const before = await detectVendor(page);
  let dismissed = false;

  for (const selector of ACCEPT_SELECTORS) {
    if (await tryClickSelector(page, selector)) {
      dismissed = true;
      break;
    }
  }

  if (!dismissed) {
    dismissed = await tryClickAcceptText(page);
  }

  if (dismissed) {
    await page.waitForTimeout(350);
  }

  const after = await detectVendor(page);

  return {
    cookie_banner_detected: before.detected || dismissed,
    /** True when an allowlisted control was clicked — banner may still remain on exotic CMPs. */
    cookie_banner_dismissed: dismissed,
    cookie_banner_vendor: before.vendor || after.vendor,
  };
}

/** No-op helper when the browse flag is off. */
export async function maybeDismissCookieBanner(
  page: Page,
  enabled: boolean | undefined,
): Promise<CookieBannerResult | undefined> {
  if (!enabled) return undefined;
  return dismissCookieBanner(page);
}

export { emptyResult as emptyCookieBannerResult };
