export type DomTreeNode = {
  path: string;
  tag: string;
  id?: string;
  class?: string;
  text?: string;
  children?: DomTreeNode[];
};

export type DomDiffSample = {
  path: string;
  before?: DomTreeNode | null;
  after?: DomTreeNode | null;
};

export type DomDiffResult = {
  added_count: number;
  removed_count: number;
  changed_count: number;
  added_samples: DomDiffSample[];
  removed_samples: DomDiffSample[];
  changed_samples: DomDiffSample[];
};

const MAX_SAMPLES = 50;

/** Serialize DOM in browser — injected via page.evaluate. */
export function domSerializeScript(maxDepth: number, textMaxLen: number): string {
  return `(() => {
    function serialize(el, depth, path) {
      if (depth > ${maxDepth}) return null;
      const tag = (el.tagName || '').toLowerCase();
      if (!tag || tag === 'script' || tag === 'style' || tag === 'noscript') return null;
      const node = { path, tag };
      if (el.id) node.id = el.id;
      const cls = (el.className && typeof el.className === 'string') ? el.className.trim() : '';
      if (cls) node.class = cls.slice(0, 120);
      const directText = Array.from(el.childNodes)
        .filter((n) => n.nodeType === Node.TEXT_NODE)
        .map((n) => (n.textContent || '').trim())
        .join(' ')
        .trim();
      if (directText) node.text = directText.slice(0, ${textMaxLen});
      const children = [];
      let idx = 0;
      for (const child of el.children || []) {
        const c = serialize(child, depth + 1, path + '/' + tag + '[' + idx + ']');
        if (c) children.push(c);
        idx++;
      }
      if (children.length) node.children = children;
      return node;
    }
    return serialize(document.documentElement, 0, '/html');
  })()`;
}

function flattenTree(node: DomTreeNode | null | undefined, map = new Map<string, DomTreeNode>()) {
  if (!node) return map;
  map.set(node.path, node);
  for (const child of node.children ?? []) flattenTree(child, map);
  return map;
}

function nodeSignature(n: DomTreeNode): string {
  return JSON.stringify({
    tag: n.tag,
    id: n.id ?? null,
    class: n.class ?? null,
    text: n.text ?? null,
  });
}

export function diffDomTrees(
  before: DomTreeNode | null | undefined,
  after: DomTreeNode | null | undefined,
): DomDiffResult {
  const aMap = flattenTree(before);
  const bMap = flattenTree(after);
  const allPaths = new Set([...aMap.keys(), ...bMap.keys()]);

  const added: DomDiffSample[] = [];
  const removed: DomDiffSample[] = [];
  const changed: DomDiffSample[] = [];

  for (const path of allPaths) {
    const a = aMap.get(path);
    const b = bMap.get(path);
    if (a && !b) {
      removed.push({ path, before: a });
    } else if (!a && b) {
      added.push({ path, after: b });
    } else if (a && b && nodeSignature(a) !== nodeSignature(b)) {
      changed.push({ path, before: a, after: b });
    }
  }

  return {
    added_count: added.length,
    removed_count: removed.length,
    changed_count: changed.length,
    added_samples: added.slice(0, MAX_SAMPLES),
    removed_samples: removed.slice(0, MAX_SAMPLES),
    changed_samples: changed.slice(0, MAX_SAMPLES),
  };
}
