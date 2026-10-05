import { withPageValue, type WithPageOptions } from '../browser/pool';
import { pageEvaluateNoArg } from '../browser/playwrightEvaluate';

export type PerformanceOptions = {
  url: string;
  settleMs?: number;
  gotoTimeoutMs?: number;
  width?: number;
  height?: number;
  runtime?: WithPageOptions['runtime'];
};

export async function measurePerformance(options: PerformanceOptions) {
  const started = Date.now();
  const consoleErrors: string[] = [];
  const consoleWarnings: string[] = [];
  const pageErrors: string[] = [];
  const network: Array<{ url: string; status: number; method: string }> = [];

  return withPageValue(
    { width: options.width, height: options.height, runtime: options.runtime },
    async (page) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 300));
      if (msg.type() === 'warning') consoleWarnings.push(msg.text().slice(0, 300));
    });
    page.on('pageerror', (err) => {
      pageErrors.push((err.message || String(err)).slice(0, 300));
    });
    page.on('response', (res) => {
      if (network.length < 200) {
        network.push({
          url: res.url().slice(0, 500),
          status: res.status(),
          method: res.request().method(),
        });
      }
    });

    const response = await page.goto(options.url, {
      waitUntil: 'domcontentloaded',
      timeout: options.gotoTimeoutMs ?? 45_000,
    });

    await page.waitForTimeout(Math.max(options.settleMs ?? 1500, 1500));
    try {
      await page.waitForLoadState('networkidle', { timeout: 8_000 });
    } catch {
      // ignore
    }

    const metrics = await pageEvaluateNoArg(page, () => {
      const nav = performance.getEntriesByType('navigation')[0] as PerformanceNavigationTiming | undefined;
      const paints = performance.getEntriesByType('paint');
      const fcp = paints.find((p) => p.name === 'first-contentful-paint')?.startTime ?? null;
      const lcpEntries = performance.getEntriesByType('largest-contentful-paint') as PerformanceEntry[];
      const lcp = lcpEntries.length ? lcpEntries[lcpEntries.length - 1].startTime : null;

      let cls = 0;
      const layoutShifts = performance.getEntriesByType('layout-shift') as Array<
        PerformanceEntry & { value?: number; hadRecentInput?: boolean }
      >;
      for (const entry of layoutShifts) {
        if (!entry.hadRecentInput) cls += entry.value || 0;
      }

      const resources = performance.getEntriesByType('resource');
      let transferSize = 0;
      for (const r of resources) {
        const rr = r as PerformanceResourceTiming;
        transferSize += rr.transferSize || 0;
      }

      return {
        ttfb_ms: nav ? Math.round(nav.responseStart) : null,
        dom_content_loaded_ms: nav ? Math.round(nav.domContentLoadedEventEnd) : null,
        load_event_ms: nav ? Math.round(nav.loadEventEnd) : null,
        fcp_ms: fcp != null ? Math.round(fcp) : null,
        lcp_ms: lcp != null ? Math.round(lcp) : null,
        cls: Number(cls.toFixed(4)),
        resource_count: resources.length,
        transfer_size_bytes: transferSize,
      };
    });

    return {
      status: 'success' as const,
      url: options.url,
      final_url: page.url(),
      http_status: response?.status() ?? null,
      metrics,
      console_errors: consoleErrors.slice(0, 50),
      console_warnings: consoleWarnings.slice(0, 50),
      page_errors: pageErrors.slice(0, 50),
      network: network.slice(0, 100),
      response_time_ms: Date.now() - started,
      timestamp: new Date().toISOString(),
    };
    },
  );
}
