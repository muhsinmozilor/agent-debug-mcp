import { OVERLAY_ATTR, rectOf, type Rect } from './dom.js';

let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let clearTimer: ReturnType<typeof setTimeout> | null = null;

function ensure(): ShadowRoot {
  if (root && host?.isConnected) return root;
  host = document.createElement('div');
  host.setAttribute(OVERLAY_ATTR, '');
  host.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483647;';
  root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = `
    .box{position:fixed;box-sizing:border-box;border:2px solid #4f8ef7;background:rgba(79,142,247,.12);pointer-events:none;border-radius:2px}
    .label{position:fixed;font:12px/1.4 ui-monospace,SFMono-Regular,Menlo,monospace;color:#fff;background:#1f2937;padding:2px 6px;border-radius:4px;pointer-events:none;white-space:nowrap;max-width:60vw;overflow:hidden;text-overflow:ellipsis}
  `;
  root.appendChild(style);
  (document.documentElement ?? document).appendChild(host);
  return root;
}

export function clearHighlight(): void {
  if (clearTimer) clearTimeout(clearTimer);
  clearTimer = null;
  if (root) while (root.children.length > 1) root.removeChild(root.lastChild as Node);
}

function highlightRects(rects: Rect[], label?: string, durationMs?: number): void {
  const r = ensure();
  clearHighlight();
  for (const rect of rects) {
    const box = document.createElement('div');
    box.className = 'box';
    box.style.cssText += `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;`;
    r.appendChild(box);
  }
  if (label && rects[0]) {
    const l = document.createElement('div');
    l.className = 'label';
    l.textContent = label;
    const top = rects[0].y > 24 ? rects[0].y - 22 : rects[0].y + rects[0].height + 4;
    l.style.cssText += `left:${Math.max(0, rects[0].x)}px;top:${top}px;`;
    r.appendChild(l);
  }
  if (durationMs && durationMs > 0) clearTimer = setTimeout(clearHighlight, durationMs);
}

export function highlightElements(els: Element[], label?: string, durationMs?: number): number {
  const rects = els.map(rectOf).filter((x): x is Rect => !!x && (x.width > 0 || x.height > 0));
  highlightRects(rects, label, durationMs);
  return rects.length;
}
