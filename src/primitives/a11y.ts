import { createRequire } from 'module';
import type { Page } from 'playwright';
import { pageEvaluateNoArg } from '../browser/playwrightEvaluate';

const require = createRequire(__filename);

export type A11yReport = {
  axe: {
    violations: Array<{
      id: string;
      impact: string | null;
      description: string;
      help: string;
      helpUrl: string;
      nodes: Array<{ html: string; target: string[]; failureSummary?: string }>;
    }>;
    passes_count: number;
    incomplete_count: number;
    inapplicable_count: number;
  } | null;
  axe_error: string | null;
  contrast_samples: Array<{
    selector: string;
    color: string;
    background: string;
    font_size: string;
    font_weight: string;
  }>;
  tab_order: Array<{ tag: string; role: string | null; name: string; tabIndex: number }>;
  aria: {
    landmarks: Array<{ role: string; label: string | null }>;
    images_missing_alt: number;
    buttons_without_name: number;
  };
};

export async function runA11yChecks(page: Page): Promise<A11yReport> {
  let axeResult: A11yReport['axe'] = null;
  let axeError: string | null = null;

  try {
    const axePath = require.resolve('axe-core/axe.min.js');
    await page.addScriptTag({ path: axePath });
    const raw = await pageEvaluateNoArg(page, async () => {
      // @ts-expect-error axe injected
      const results = await window.axe.run(document, {
        resultTypes: ['violations', 'passes', 'incomplete', 'inapplicable'],
      });
      return {
        violations: (results.violations || []).slice(0, 50).map((v: {
          id: string;
          impact: string | null;
          description: string;
          help: string;
          helpUrl: string;
          nodes: Array<{ html: string; target: string[]; failureSummary?: string }>;
        }) => ({
          id: v.id,
          impact: v.impact,
          description: v.description,
          help: v.help,
          helpUrl: v.helpUrl,
          nodes: (v.nodes || []).slice(0, 10).map((n) => ({
            html: (n.html || '').slice(0, 500),
            target: n.target,
            failureSummary: n.failureSummary,
          })),
        })),
        passes_count: (results.passes || []).length,
        incomplete_count: (results.incomplete || []).length,
        inapplicable_count: (results.inapplicable || []).length,
      };
    });
    axeResult = raw;
  } catch (err) {
    axeError = err instanceof Error ? err.message : String(err);
  }

  const extras = await pageEvaluateNoArg(page, () => {
    const contrast_samples: A11yReport['contrast_samples'] = [];
    const candidates = Array.from(document.querySelectorAll('p, h1, h2, h3, a, button, label, li')).slice(0, 40);
    for (const el of candidates) {
      const style = window.getComputedStyle(el);
      contrast_samples.push({
        selector: el.tagName.toLowerCase() + (el.id ? `#${el.id}` : ''),
        color: style.color,
        background: style.backgroundColor,
        font_size: style.fontSize,
        font_weight: style.fontWeight,
      });
    }

    const focusables = Array.from(
      document.querySelectorAll(
        'a[href], button, input, select, textarea, [tabindex]:not([tabindex="-1"])',
      ),
    ).slice(0, 80);

    const tab_order = focusables.map((el) => {
      const htmlEl = el as HTMLElement;
      return {
        tag: el.tagName.toLowerCase(),
        role: el.getAttribute('role'),
        name: (el.getAttribute('aria-label')
          || (el as HTMLInputElement).labels?.[0]?.textContent
          || el.textContent
          || '').trim().slice(0, 120),
        tabIndex: htmlEl.tabIndex,
      };
    });

    const landmarks = Array.from(
      document.querySelectorAll('[role=banner], [role=navigation], [role=main], [role=contentinfo], header, nav, main, footer'),
    ).map((el) => ({
      role: el.getAttribute('role') || el.tagName.toLowerCase(),
      label: el.getAttribute('aria-label'),
    }));

    const images_missing_alt = Array.from(document.querySelectorAll('img')).filter(
      (img) => !img.getAttribute('alt') && img.getAttribute('role') !== 'presentation',
    ).length;

    const buttons_without_name = Array.from(document.querySelectorAll('button, [role=button]')).filter((el) => {
      const name = (el.getAttribute('aria-label') || el.textContent || '').trim();
      return !name;
    }).length;

    return {
      contrast_samples,
      tab_order,
      aria: { landmarks, images_missing_alt, buttons_without_name },
    };
  });

  return {
    axe: axeResult,
    axe_error: axeError,
    ...extras,
  };
}
