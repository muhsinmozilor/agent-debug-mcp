import { DevtoolsError } from '@devtools-mcp/protocol';
import { componentForElement, elementAtPoint, isOverlayNode, type ElementComponentInfo } from './dom.js';
import { clearHighlight, highlightElements } from './overlay.js';
import { nameOf } from './naming.js';
import { getFiber } from 'bippy';
import { nearestComposite } from './dom.js';

let active: (() => void) | null = null;

/** Let the user click an element. Hover highlights; the click is swallowed. */
export function pickElement(opts: { timeoutMs: number; signal: AbortSignal }): Promise<ElementComponentInfo> {
  active?.(); // cancel a previous pick
  return new Promise((resolve, reject) => {
    let done = false;
    const finish = (): void => {
      if (done) return;
      done = true;
      active = null;
      document.removeEventListener('mousemove', onMove, true);
      document.removeEventListener('click', onClick, true);
      document.removeEventListener('mousedown', swallow, true);
      document.removeEventListener('mouseup', swallow, true);
      document.removeEventListener('keydown', onKey, true);
      opts.signal.removeEventListener('abort', onAbort);
      clearTimeout(timer);
      clearHighlight();
    };
    active = () => {
      finish();
      reject(new DevtoolsError('CANCELLED', 'Superseded by a newer page_pick_element call'));
    };
    const onMove = (e: MouseEvent): void => {
      const el = elementAtPoint(e.clientX, e.clientY);
      if (!el || isOverlayNode(el)) return;
      const composite = nearestComposite(getFiber(el));
      highlightElements([el], composite ? `${nameOf(composite)} · click to select · Esc to cancel` : 'click to select · Esc to cancel');
    };
    const swallow = (e: Event): void => {
      e.preventDefault();
      e.stopImmediatePropagation();
    };
    const onClick = (e: MouseEvent): void => {
      swallow(e);
      const el = elementAtPoint(e.clientX, e.clientY);
      finish();
      if (!el) {
        reject(new DevtoolsError('PAGE_ERROR', 'No element under the pointer'));
        return;
      }
      resolve(componentForElement(el));
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        swallow(e);
        finish();
        reject(new DevtoolsError('CANCELLED', 'User pressed Escape'));
      }
    };
    const onAbort = (): void => {
      finish();
      reject(new DevtoolsError('CANCELLED', 'Cancelled by the client'));
    };
    const timer = setTimeout(() => {
      finish();
      reject(new DevtoolsError('TIMEOUT', `No element was picked within ${Math.round(opts.timeoutMs / 1000)} s`));
    }, opts.timeoutMs);
    document.addEventListener('mousemove', onMove, true);
    document.addEventListener('click', onClick, true);
    document.addEventListener('mousedown', swallow, true);
    document.addEventListener('mouseup', swallow, true);
    document.addEventListener('keydown', onKey, true);
    opts.signal.addEventListener('abort', onAbort, { once: true });
    highlightElements([], 'Agent Debug MCP: click an element · Esc to cancel');
  });
}
