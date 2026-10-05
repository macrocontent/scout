import type { Page } from 'playwright';

/**
 * tsx/esbuild `keepNames` rewrites:
 *   const foo = (x) => ...
 * into:
 *   const foo = __name((x) => ..., "foo")
 *
 * Playwright serializes the callback via `.toString()` and runs it in the page,
 * where `__name` does not exist → ReferenceError. Strip those wrappers and
 * rebuild a clean function for evaluate().
 */
export function stripEsbuildNameHelpers(source: string): string {
  let current = source;
  let previous = '';
  // Nested keepNames wrappers sit inside the outer __name(...) first arg —
  // strip repeatedly until stable.
  while (current !== previous) {
    previous = current;
    current = stripEsbuildNameHelpersOnce(current);
  }
  return current;
}

function stripEsbuildNameHelpersOnce(source: string): string {
  const token = '__name(';
  let out = '';
  let i = 0;

  while (i < source.length) {
    const start = source.indexOf(token, i);
    if (start === -1) {
      out += source.slice(i);
      break;
    }
    out += source.slice(i, start);

    let j = start + token.length;
    let depth = 1;
    let inStr: '"' | "'" | '`' | null = null;
    let escaped = false;

    while (j < source.length && depth > 0) {
      const ch = source[j]!;
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
      } else if (ch === '(') depth += 1;
      else if (ch === ')') depth -= 1;
      j += 1;
    }

    const inner = source.slice(start + token.length, j - 1);
    let split = -1;
    depth = 0;
    inStr = null;
    escaped = false;
    for (let k = 0; k < inner.length; k++) {
      const ch = inner[k]!;
      if (inStr) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === inStr) inStr = null;
      } else if (ch === '"' || ch === "'" || ch === '`') {
        inStr = ch;
      } else if (ch === '(' || ch === '{' || ch === '[') depth += 1;
      else if (ch === ')' || ch === '}' || ch === ']') depth -= 1;
      else if (ch === ',' && depth === 0) split = k;
    }

    out += (split === -1 ? inner : inner.slice(0, split)).trim();
    i = j;
  }

  return out;
}

export function toPlaywrightFunction<T extends(...args: never[]) => unknown>(fn: T): T {
  const stripped = stripEsbuildNameHelpers(fn.toString());
  // eslint-disable-next-line no-new-func, @typescript-eslint/no-implied-eval
  return new Function(`"use strict"; return (${stripped});`)() as T;
}

export async function pageEvaluate<Arg, Result>(
  page: Page,
  fn: (arg: Arg) => Result | Promise<Result>,
  arg: Arg,
): Promise<Result> {
  return page.evaluate(toPlaywrightFunction(fn) as never, arg);
}

export async function pageEvaluateNoArg<Result>(
  page: Page,
  fn: () => Result | Promise<Result>,
): Promise<Result> {
  return page.evaluate(toPlaywrightFunction(fn));
}
