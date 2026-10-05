/**
 * Relocate CSS selectors when the page structure changes.
 * Used by extract/assert inside page.evaluate — keep this logic DOM-free so unit tests can cover scoring.
 */

export type SelectorHint = {
  tag: string;
  id: string | null;
  classes: string[];
};

export function parseSelectorHint(selector: string): SelectorHint {
  const last = selector.trim().split(/[\s>+~]+/).pop() || '';
  const idMatch = last.match(/#([A-Za-z_][\w-]*)/);
  const tagMatch = last.match(/^([a-z][a-z0-9]*)/i);
  const classes = [...last.matchAll(/\.([A-Za-z_][\w-]*)/g)].map((m) => m[1]);
  return {
    tag: tagMatch?.[1]?.toLowerCase() || '*',
    id: idMatch?.[1] ?? null,
    classes,
  };
}

export function scoreCandidate(opts: {
  tag: string;
  classList: string[];
  text: string;
  hint: SelectorHint;
  matchText?: string;
}): number {
  let score = 0;
  if (opts.hint.tag !== '*' && opts.tag === opts.hint.tag) score += 1;
  for (const cls of opts.hint.classes) {
    if (opts.classList.includes(cls)) score += 3;
  }
  const needle = (opts.matchText || '').trim().toLowerCase();
  if (needle && opts.text.toLowerCase().includes(needle)) score += 4;
  return score;
}

/** Minimum score before we treat a relocated node as a match. */
export const ADAPTIVE_MIN_SCORE = 3;
