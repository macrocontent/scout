import type { Page } from 'playwright';
import { pageEvaluateNoArg } from '../browser/playwrightEvaluate';

export type TechStackReport = {
  cms: Array<{ id: string; evidence: string }>;
  frameworks: Array<{ id: string; evidence: string }>;
  analytics: Array<{ id: string; evidence: string }>;
  generators: Array<{ id: string; evidence: string }>;
};

export async function detectTechStack(page: Page): Promise<TechStackReport> {
  return pageEvaluateNoArg(page, () => {
    const cms: TechStackReport['cms'] = [];
    const frameworks: TechStackReport['frameworks'] = [];
    const analytics: TechStackReport['analytics'] = [];
    const generators: TechStackReport['generators'] = [];

    const html = document.documentElement.outerHTML.slice(0, 400_000);
    const lower = html.toLowerCase();
    const scripts = Array.from(document.scripts).map((s) => s.src || '').filter(Boolean);
    const metas = Array.from(document.querySelectorAll('meta')).map((m) => ({
      name: (m.getAttribute('name') || m.getAttribute('property') || '').toLowerCase(),
      content: (m.getAttribute('content') || '').toLowerCase(),
    }));

    const pushUnique = (
      list: Array<{ id: string; evidence: string }>,
      id: string,
      evidence: string,
    ) => {
      if (!list.some((x) => x.id === id)) list.push({ id, evidence });
    };

    // CMS
    if (lower.includes('wp-content') || lower.includes('wordpress')) {
      pushUnique(cms, 'wordpress', 'wp-content / wordpress string');
    }
    if (lower.includes('cdn.shopify.com') || (window as unknown as { Shopify?: unknown }).Shopify) {
      pushUnique(cms, 'shopify', 'Shopify global or CDN');
    }
    if (lower.includes('squarespace') || lower.includes('static1.squarespace')) {
      pushUnique(cms, 'squarespace', 'squarespace marker');
    }
    if (lower.includes('wix.com') || lower.includes('_wix_browser_sess')) {
      pushUnique(cms, 'wix', 'wix marker');
    }
    if (lower.includes('webflow') || scripts.some((s) => s.includes('webflow'))) {
      pushUnique(cms, 'webflow', 'webflow marker');
    }
    if (lower.includes('drupal') || lower.includes('sites/default/files')) {
      pushUnique(cms, 'drupal', 'drupal marker');
    }
    if (lower.includes('data-macro-key') || lower.includes('macrocontent')) {
      pushUnique(cms, 'macrocontent', 'data-macro-key / macrocontent');
    }

    // Frameworks
    if ((window as unknown as { __NEXT_DATA__?: unknown }).__NEXT_DATA__ || lower.includes('__next')) {
      pushUnique(frameworks, 'nextjs', '__NEXT_DATA__ / __next');
    }
    if ((window as unknown as { __NUXT__?: unknown }).__NUXT__ || lower.includes('__nuxt')) {
      pushUnique(frameworks, 'nuxt', '__NUXT__');
    }
    if ((window as unknown as { Vue?: unknown }).Vue || lower.includes('data-v-')) {
      pushUnique(frameworks, 'vue', 'Vue / data-v-');
    }
    if ((window as unknown as { React?: unknown }).React || lower.includes('data-reactroot')) {
      pushUnique(frameworks, 'react', 'React marker');
    }
    if ((window as unknown as { ng?: unknown }).ng || lower.includes('ng-version')) {
      pushUnique(frameworks, 'angular', 'Angular marker');
    }
    if (lower.includes('svelte') || document.querySelector('[class*=svelte-]')) {
      pushUnique(frameworks, 'svelte', 'svelte marker');
    }
    if (lower.includes('astro-') || document.querySelector('astro-island')) {
      pushUnique(frameworks, 'astro', 'astro-island');
    }

    // Generators meta
    for (const m of metas) {
      if (m.name === 'generator' && m.content) {
        pushUnique(generators, m.content.split(' ')[0] || m.content, `meta generator: ${m.content}`);
      }
    }

    // Analytics / trackers (facts only)
    const trackerChecks: Array<[string, (s: string) => boolean]> = [
      ['google-analytics', (s) => s.includes('google-analytics.com') || s.includes('googletagmanager.com') || s.includes('gtag/')],
      ['google-tag-manager', (s) => s.includes('googletagmanager.com')],
      ['facebook-pixel', (s) => s.includes('connect.facebook.net') || s.includes('fbevents.js')],
      ['hotjar', (s) => s.includes('hotjar.com')],
      ['segment', (s) => s.includes('cdn.segment.com') || s.includes('segment.io')],
      ['mixpanel', (s) => s.includes('mixpanel.com')],
      ['plausible', (s) => s.includes('plausible.io')],
      ['matomo', (s) => s.includes('matomo') || s.includes('piwik')],
      ['clarity', (s) => s.includes('clarity.ms')],
      ['linkedin-insight', (s) => s.includes('snap.licdn.com') || s.includes('linkedin.com/px')],
    ];
    for (const src of scripts) {
      for (const [id, test] of trackerChecks) {
        if (test(src.toLowerCase())) pushUnique(analytics, id, src);
      }
    }
    for (const [id, test] of trackerChecks) {
      if (test(lower)) pushUnique(analytics, id, 'page html match');
    }

    return { cms, frameworks, analytics, generators };
  });
}
