/** Minimal DOM helpers. No framework — this is four screens (CLAUDE.md §2). */

type Attrs = Record<string, string | number | boolean | EventListener | undefined>;
type Child = Node | string | null | undefined | false;

export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    if (key.startsWith('on') && typeof value === 'function') {
      node.addEventListener(key.slice(2).toLowerCase(), value as EventListener);
    } else if (key === 'class') {
      node.className = String(value);
    } else if (value === true) {
      node.setAttribute(key, '');
    } else {
      node.setAttribute(key, String(value));
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export function clear(node: Element): void {
  while (node.firstChild) node.removeChild(node.firstChild);
}

export const prefersReducedMotion = (): boolean =>
  globalThis.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false;
