import type { Page } from 'playwright';
import { ScoutError } from './errors';

export async function applyWaitForSelector(
  page: Page,
  options?: {
    waitForSelector?: string;
    waitTimeoutMs?: number;
    /** If true, throw SELECTOR_NOT_FOUND instead of continuing */
    required?: boolean;
  },
): Promise<{ waited: boolean; found: boolean }> {
  const selector = options?.waitForSelector?.trim();
  if (!selector) return { waited: false, found: true };

  try {
    await page.waitForSelector(selector, {
      state: 'attached',
      timeout: options?.waitTimeoutMs ?? 15_000,
    });
    return { waited: true, found: true };
  } catch (err) {
    if (options?.required !== false) {
      throw new ScoutError(
        'SELECTOR_NOT_FOUND',
        `wait_for_selector not found: ${selector}`,
        {
          details: {
            selector,
            cause: err instanceof Error ? err.message.slice(0, 200) : String(err).slice(0, 200),
          },
        },
      );
    }
    return { waited: true, found: false };
  }
}
