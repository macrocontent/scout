import { withPageValue, type WithPageOptions } from '../browser/pool';

export type SandboxResource = {
  url: string;
  body: string;
  content_type?: string;
  status?: number;
};

export type SandboxOptions = {
  html: string;
  resources?: SandboxResource[];
  blockExternal?: boolean;
  width?: number;
  height?: number;
  waitForFunction?: string;
  waitTimeoutMs?: number;
  evaluate?: string;
  allowEvaluate?: boolean;
  screenshot?: boolean;
};

/**
 * Generic HTML sandbox: load custom HTML with optional mocked network resources.
 * Useful for component previews, email HTML checks, offline fixtures — not product-specific.
 */
export async function runSandbox(options: SandboxOptions) {
  const started = Date.now();
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];

  const pageOpts: WithPageOptions = {
    width: options.width ?? 960,
    height: options.height ?? 640,
    resources: (options.resources ?? []).map((r) => ({
      url: r.url,
      body: r.body,
      contentType: r.content_type,
      status: r.status,
    })),
    blockExternal: options.blockExternal !== false,
  };

  return withPageValue(pageOpts, async (page) => {
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text().slice(0, 400));
    });
    page.on('pageerror', (err) => {
      pageErrors.push((err.message || String(err)).slice(0, 400));
    });

    await page.setContent(options.html, {
      waitUntil: 'domcontentloaded',
      timeout: options.waitTimeoutMs ?? 30_000,
    });

    if (options.waitForFunction) {
      await page.waitForFunction(options.waitForFunction, {
        timeout: options.waitTimeoutMs ?? 30_000,
      });
    }

    let evaluateResult: unknown = undefined;
    if (options.evaluate) {
      if (!options.allowEvaluate) {
        throw new Error('evaluate requires a Pro API key');
      }
      evaluateResult = await page.evaluate(options.evaluate);
    }

    let screenshotBase64: string | undefined;
    if (options.screenshot) {
      const buf = await page.screenshot({ type: 'jpeg', quality: 84, fullPage: false });
      screenshotBase64 = Buffer.from(buf).toString('base64');
    }

    return {
      status: 'success' as const,
      console_errors: consoleErrors,
      page_errors: pageErrors,
      evaluate_result: evaluateResult,
      screenshot_base64: screenshotBase64,
      response_time_ms: Date.now() - started,
      timestamp: new Date().toISOString(),
    };
  });
}
