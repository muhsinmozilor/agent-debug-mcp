/**
 * `page_snapshot`: a compact accessibility-style outline of the page (roles, names, selectors) with every node
 * annotated by the React component that rendered it. One call gives an agent both an actionable target
 * (selector for Playwright / react_find_by_dom) and the owning component (elementId for react_inspect_element).
 */
import { getFiber } from 'bippy';
import { defaultDomSelector } from '@devtools-mcp/protocol';
import { isOverlayNode, nearestComposite } from './dom.js';
import { elementIdOf } from './elements.js';
import { nameOf } from './naming.js';

export interface SnapshotNode {
  role: string;
  name: string;
  tag: string;
  selector: string;
  depth: number;
  component: { id: number; name: string } | null;
  attrs?: Record<string, string | number | boolean>;
}

export interface SnapshotOptions {
  root?: Element;
  maxNodes?: number;
  interactiveOnly?: boolean;
}

export interface SnapshotResult {
  nodes: SnapshotNode[];
  truncated: boolean;
  scanned: number;
}

const INTERACTIVE = new Set(['link', 'button', 'checkbox', 'radio', 'slider', 'spinbutton', 'searchbox', 'textbox', 'combobox', 'listbox', 'option', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'focusable']);
const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'TEMPLATE', 'NOSCRIPT', 'HEAD', 'META', 'LINK', 'TITLE', 'SVG', 'PATH']);
const LANDMARKS: Record<string, string> = { NAV: 'navigation', MAIN: 'main', HEADER: 'banner', FOOTER: 'contentinfo', ASIDE: 'complementary', FORM: 'form', DIALOG: 'dialog', ARTICLE: 'article' };
const INPUT_ROLES: Record<string, string> = { button: 'button', submit: 'button', reset: 'button', image: 'button', checkbox: 'checkbox', radio: 'radio', range: 'slider', number: 'spinbutton', search: 'searchbox' };

/** ARIA role: explicit `role`, else the implicit role of the element; null for generic containers. */
function roleOf(el: Element): string | null {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit.split(/\s+/)[0] as string;
  const tag = el.tagName;
  if (tag === 'A' || tag === 'AREA') return el.hasAttribute('href') ? 'link' : null;
  if (tag === 'BUTTON' || tag === 'SUMMARY') return 'button';
  if (tag === 'INPUT') {
    const type = ((el as HTMLInputElement).type || 'text').toLowerCase();
    if (type === 'hidden') return null;
    return INPUT_ROLES[type] ?? 'textbox';
  }
  if (tag === 'TEXTAREA') return 'textbox';
  if (tag === 'SELECT') return (el as HTMLSelectElement).multiple || (el as HTMLSelectElement).size > 1 ? 'listbox' : 'combobox';
  if (tag === 'OPTION') return 'option';
  if (/^H[1-6]$/.test(tag)) return 'heading';
  if (tag === 'IMG') return 'img';
  if (tag === 'UL' || tag === 'OL' || tag === 'MENU') return 'list';
  if (tag === 'LI') return 'listitem';
  if (tag === 'TABLE') return 'table';
  if (tag === 'TR') return 'row';
  if (tag === 'TD') return 'cell';
  if (tag === 'TH') return 'columnheader';
  if (tag === 'P') return 'paragraph';
  if (tag === 'HR') return 'separator';
  if (tag === 'PROGRESS') return 'progressbar';
  if (tag === 'DETAILS') return 'group';
  if (tag === 'SECTION') return el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null;
  if (tag in LANDMARKS) return LANDMARKS[tag] as string;
  if ((el as HTMLElement).isContentEditable) return 'textbox';
  if (el.hasAttribute('tabindex')) return 'focusable';
  if (el.hasAttribute('data-testid') || el.hasAttribute('aria-label')) return 'generic';
  return null;
}

function isHidden(el: Element): boolean {
  if ((el as HTMLElement).hidden || el.getAttribute('aria-hidden') === 'true') return true;
  if (el.tagName === 'INPUT' && (el as HTMLInputElement).type === 'hidden') return true;
  const view = el.ownerDocument.defaultView;
  if (view && typeof view.getComputedStyle === 'function') {
    const cs = view.getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return true;
  }
  return false;
}

function trimText(s: string | null | undefined, max = 60): string {
  const t = (s ?? '').replace(/\s+/g, ' ').trim();
  return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

/** Approximate accessible name. */
function accessibleName(el: Element, role: string): string {
  const aria = el.getAttribute('aria-label');
  if (aria) return trimText(aria);
  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => el.ownerDocument.getElementById(id)?.textContent ?? '')
      .join(' ');
    if (text.trim()) return trimText(text);
  }
  const tag = el.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    const input = el as HTMLInputElement;
    if (input.id) {
      const label = el.ownerDocument.querySelector(`label[for="${input.id.replace(/"/g, '\\"')}"]`);
      if (label?.textContent?.trim()) return trimText(label.textContent);
    }
    const wrapping = el.closest('label');
    if (wrapping?.textContent?.trim()) return trimText(wrapping.textContent);
    if (tag === 'INPUT' && (input.type === 'button' || input.type === 'submit' || input.type === 'reset') && input.value) return trimText(input.value);
    if (input.placeholder) return trimText(input.placeholder);
    return trimText(el.getAttribute('title'));
  }
  if (tag === 'IMG') return trimText(el.getAttribute('alt') ?? el.getAttribute('title'));
  if (role === 'list' || role === 'table' || role === 'group' || role === 'generic' || role === 'form' || (role in LANDMARK_ROLES && role !== 'dialog')) {
    return trimText(el.getAttribute('title'));
  }
  return trimText(el.textContent, role === 'paragraph' || role === 'cell' || role === 'listitem' ? 80 : 60);
}
const LANDMARK_ROLES: Record<string, true> = { navigation: true, main: true, banner: true, contentinfo: true, complementary: true, region: true, article: true, dialog: true };

function attrsOf(el: Element, role: string): Record<string, string | number | boolean> | undefined {
  const out: Record<string, string | number | boolean> = {};
  if (role === 'heading') out.level = Number(el.getAttribute('aria-level') ?? el.tagName.slice(1)) || 2;
  if (role === 'link') {
    const href = el.getAttribute('href');
    if (href) out.href = trimText(href, 80);
  }
  const input = el as HTMLInputElement;
  if ((role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitemcheckbox') && (input.checked || el.getAttribute('aria-checked') === 'true')) out.checked = true;
  if ((role === 'textbox' || role === 'searchbox' || role === 'spinbutton' || role === 'slider' || role === 'combobox') && el.tagName !== 'DIV') {
    const v = (el as HTMLInputElement | HTMLSelectElement).value;
    if (v) out.value = trimText(String(v), 40);
  }
  if ((el as HTMLButtonElement).disabled || el.getAttribute('aria-disabled') === 'true') out.disabled = true;
  const expanded = el.getAttribute('aria-expanded') ?? (el.tagName === 'DETAILS' ? String((el as HTMLDetailsElement).open) : null);
  if (expanded === 'true' || expanded === 'false') out.expanded = expanded === 'true';
  if (el.getAttribute('aria-pressed') === 'true') out.pressed = true;
  if (el.getAttribute('aria-selected') === 'true' || (role === 'option' && (el as HTMLOptionElement).selected)) out.selected = true;
  if (el.getAttribute('aria-current')) out.current = el.getAttribute('aria-current') as string;
  return Object.keys(out).length ? out : undefined;
}

function componentOf(el: Element): { id: number; name: string } | null {
  const composite = nearestComposite(getFiber(el));
  return composite ? { id: elementIdOf(composite), name: nameOf(composite) } : null;
}

export function snapshot(opts: SnapshotOptions = {}): SnapshotResult {
  const root = opts.root ?? document.body;
  const max = Math.min(Math.max(opts.maxNodes ?? 200, 1), 2000);
  const nodes: SnapshotNode[] = [];
  let scanned = 0;
  let truncated = false;
  // Iterative DFS carrying the depth of the nearest *included* ancestor.
  const stack: { el: Element; depth: number }[] = [{ el: root, depth: -1 }];
  while (stack.length) {
    const { el, depth } = stack.pop() as { el: Element; depth: number };
    scanned++;
    if (SKIP_TAGS.has(el.tagName) || isOverlayNode(el) || (el !== root && isHidden(el))) continue;
    let childDepth = depth;
    const role = el === root && root === document.body ? null : roleOf(el);
    if (role && (!opts.interactiveOnly || INTERACTIVE.has(role))) {
      if (nodes.length >= max) {
        truncated = true;
        break;
      }
      const node: SnapshotNode = {
        role,
        name: accessibleName(el, role),
        tag: el.tagName.toLowerCase(),
        selector: defaultDomSelector(el as unknown as Parameters<typeof defaultDomSelector>[0]),
        depth: depth + 1,
        component: componentOf(el),
      };
      const attrs = attrsOf(el, role);
      if (attrs) node.attrs = attrs;
      nodes.push(node);
      childDepth = depth + 1;
      // Leaf-like roles: their text is already the name; do not descend into inline markup.
      if (role === 'button' || role === 'link' || role === 'heading' || role === 'option' || role === 'paragraph' || role === 'textbox' || role === 'img' || role === 'cell' || role === 'columnheader') {
        if (!el.querySelector('button, a[href], input, select, textarea, [role]')) continue;
      }
    }
    const children = el.children;
    for (let i = children.length - 1; i >= 0; i--) stack.push({ el: children[i] as Element, depth: childDepth });
  }
  return { nodes, truncated, scanned };
}

/** Render nodes as an indented outline; the owning component is printed only where it changes. */
export function renderSnapshot(nodes: SnapshotNode[]): string {
  const lines: string[] = [];
  const ownerAtDepth: (number | null)[] = [];
  for (const n of nodes) {
    const parentOwner = n.depth > 0 ? (ownerAtDepth[n.depth - 1] ?? null) : null;
    ownerAtDepth[n.depth] = n.component?.id ?? null;
    ownerAtDepth.length = n.depth + 1;
    const attrs = n.attrs
      ? ' ' +
        Object.entries(n.attrs)
          .map(([k, v]) => (v === true ? `[${k}]` : `[${k}=${typeof v === 'string' ? JSON.stringify(v) : v}]`))
          .join(' ')
      : '';
    const owner = n.component && n.component.id !== parentOwner ? ` → ${n.component.name}#${n.component.id}` : '';
    lines.push(`${'  '.repeat(n.depth)}- ${n.role}${n.name ? ` ${JSON.stringify(n.name)}` : ''}${attrs} {${n.selector}}${owner}`);
  }
  return lines.join('\n');
}
