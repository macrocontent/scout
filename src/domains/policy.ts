import type { JourneyStep } from '../primitives/journey';

const SENSITIVE_INTERACT = new Set([
  'click',
  'type',
  'fill',
  'hover',
  'press_key',
  'select_option',
]);

/**
 * Sensitive journeys need a verified domain for every navigate URL:
 * - interact that changes/pages (click/type/…)
 * - evaluate
 * - session cookies supplied by the client
 *
 * Read-only journeys (navigate + extract/visibility/screenshot/wait) stay open.
 */
export function journeyRequiresVerifiedDomain(
  steps: JourneyStep[],
  cookies?: unknown[] | null,
): boolean {
  if (cookies && cookies.length > 0) return true;
  for (const step of steps) {
    if (step.type === 'evaluate') return true;
    if (step.type === 'interact' && SENSITIVE_INTERACT.has(step.action)) return true;
  }
  return false;
}

export function collectNavigateUrls(steps: JourneyStep[]): string[] {
  const urls: string[] = [];
  for (const step of steps) {
    if (step.type === 'navigate' && step.url) urls.push(step.url);
  }
  return urls;
}
