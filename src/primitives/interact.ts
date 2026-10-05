import type { Page } from 'playwright';
import { pageEvaluate } from '../browser/playwrightEvaluate';

export type InteractAction =
  | { action: 'click'; selector: string }
  | { action: 'type'; selector: string; text: string; clear?: boolean }
  | { action: 'fill'; selector: string; text: string }
  | { action: 'scroll'; selector?: string; y?: number }
  | { action: 'hover'; selector: string }
  | { action: 'press_key'; key: string; selector?: string }
  | { action: 'select_option'; selector: string; value: string }
  | { action: 'wait'; ms: number }
  | { action: 'wait_for_selector'; selector: string; state?: 'attached' | 'visible' | 'hidden'; timeout_ms?: number };

export async function runInteractAction(page: Page, step: InteractAction): Promise<void> {
  switch (step.action) {
    case 'click':
      await page.click(step.selector, { timeout: 15_000 });
      return;
    case 'type':
      if (step.clear) await page.fill(step.selector, '');
      await page.type(step.selector, step.text, { delay: 20 });
      return;
    case 'fill':
      await page.fill(step.selector, step.text);
      return;
    case 'scroll':
      if (step.selector) {
        await page.locator(step.selector).scrollIntoViewIfNeeded();
      } else {
        await pageEvaluate(page, (y) => window.scrollBy(0, y), step.y ?? 600);
      }
      return;
    case 'hover':
      await page.hover(step.selector, { timeout: 15_000 });
      return;
    case 'press_key':
      if (step.selector) await page.focus(step.selector);
      await page.keyboard.press(step.key);
      return;
    case 'select_option':
      await page.selectOption(step.selector, step.value);
      return;
    case 'wait':
      await page.waitForTimeout(Math.max(0, Math.min(step.ms, 60_000)));
      return;
    case 'wait_for_selector':
      await page.waitForSelector(step.selector, {
        state: step.state ?? 'attached',
        timeout: step.timeout_ms ?? 15_000,
      });
      return;
    default: {
      const _exhaustive: never = step;
      throw new Error(`Unknown action: ${JSON.stringify(_exhaustive)}`);
    }
  }
}
