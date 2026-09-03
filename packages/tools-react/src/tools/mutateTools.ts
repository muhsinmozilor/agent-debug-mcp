import { AgentDebugError, decode, defineTool, type Enc, type Path } from '@devtools-mcp/protocol';
import { getRenderer, type Fiber } from 'bippy';
import { reactForceRerenderMeta, reactOverrideValueMeta } from '../descriptors.js';
import { resolveElement } from '../elements.js';
import { hooksOf } from '../inspect.js';
import { kindOf, nameOf } from '../naming.js';

function rendererFor(fiber: Fiber) {
  const renderer = getRenderer(fiber);
  if (!renderer) throw new AgentDebugError('PAGE_ERROR', 'Could not find the React renderer for this component');
  return renderer;
}

function requireDev(renderer: ReturnType<typeof rendererFor>, what: string): void {
  if (renderer.bundleType !== 1) {
    throw new AgentDebugError('CAPABILITY_UNAVAILABLE', `${what} requires a development build of React`, {
      hint: 'Production React bundles do not expose override hooks. Run the app with its dev server.',
    });
  }
}

function setIn(obj: unknown, path: Path, value: unknown): unknown {
  if (path.length === 0) return value;
  const [head, ...rest] = path as [string | number, ...Path];
  const isArray = Array.isArray(obj);
  const copy: Record<string | number, unknown> = isArray ? ([...(obj as unknown[])] as unknown as Record<number, unknown>) : { ...((obj as Record<string, unknown>) ?? {}) };
  copy[head] = setIn((obj as Record<string | number, unknown> | undefined)?.[head], rest, value);
  return copy;
}

export const reactOverrideValue = defineTool<{ elementId: number; kind: 'props' | 'hooks' | 'state'; path: Path; value: Enc }, unknown>({
  ...reactOverrideValueMeta,
  execute: ({ elementId, kind, path, value }) => {
    const fiber = resolveElement(elementId);
    const renderer = rendererFor(fiber);
    let decoded: unknown;
    try {
      decoded = decode(value);
    } catch (e) {
      throw new AgentDebugError('INVALID_INPUT', `Cannot decode value: ${(e as Error).message}`);
    }
    const name = nameOf(fiber);
    switch (kind) {
      case 'props': {
        requireDev(renderer, 'Overriding props');
        if (typeof renderer.overrideProps !== 'function') throw new AgentDebugError('CAPABILITY_UNAVAILABLE', 'This React version does not support overrideProps');
        renderer.overrideProps(fiber, path, decoded);
        return { ok: true, id: elementId, name, kind, path, note: 'Prop overridden until the parent re-renders and passes new props.' };
      }
      case 'hooks': {
        requireDev(renderer, 'Overriding hook state');
        if (typeof renderer.overrideHookState !== 'function') throw new AgentDebugError('CAPABILITY_UNAVAILABLE', 'This React version does not support overrideHookState');
        const [hookIndex, ...inner] = path;
        if (typeof hookIndex !== 'number') throw new AgentDebugError('INVALID_INPUT', 'For kind "hooks" the first path segment must be the hook index (integer)');
        const hooks = hooksOf(fiber);
        const flat: { id: number | null; name: string; isStateEditable: boolean }[] = [];
        const walk = (nodes: { id: number | null; name: string; isStateEditable: boolean; subHooks: unknown[] }[]): void => {
          for (const h of nodes) {
            flat.push(h);
            walk(h.subHooks as typeof nodes);
          }
        };
        if (hooks.tree) walk(hooks.tree as never);
        const target = flat[hookIndex];
        if (!target) throw new AgentDebugError('INVALID_INPUT', `No hook at index ${hookIndex} (component has ${flat.length})`);
        if (!target.isStateEditable || target.id === null) {
          throw new AgentDebugError('INVALID_INPUT', `Hook #${hookIndex} (${target.name}) is not editable — only useState/useReducer state can be overridden`);
        }
        renderer.overrideHookState(fiber, target.id, inner, decoded);
        return { ok: true, id: elementId, name, kind, hook: { index: hookIndex, name: target.name }, path: inner };
      }
      case 'state': {
        if (kindOf(fiber) !== 'class') throw new AgentDebugError('INVALID_INPUT', 'kind "state" applies to class components; use kind "hooks" for function components');
        const instance = fiber.stateNode as { state?: Record<string, unknown>; setState?: (s: unknown) => void } | null;
        if (!instance || typeof instance.setState !== 'function') throw new AgentDebugError('PAGE_ERROR', 'Class instance has no setState');
        const next = setIn(instance.state ?? {}, path, decoded);
        instance.setState(next);
        return { ok: true, id: elementId, name, kind, path };
      }
      default:
        throw new AgentDebugError('INVALID_INPUT', `Unknown kind "${String(kind)}"`);
    }
  },
});

export const reactForceRerender = defineTool<{ elementId: number }, unknown>({
  ...reactForceRerenderMeta,
  execute: ({ elementId }) => {
    const fiber = resolveElement(elementId);
    const renderer = rendererFor(fiber);
    if (kindOf(fiber) === 'class') {
      const inst = fiber.stateNode as { forceUpdate?: () => void } | null;
      if (inst?.forceUpdate) {
        inst.forceUpdate();
        return { ok: true, id: elementId, name: nameOf(fiber), via: 'forceUpdate' };
      }
    }
    requireDev(renderer, 'Forcing a re-render');
    if (typeof renderer.scheduleUpdate !== 'function') throw new AgentDebugError('CAPABILITY_UNAVAILABLE', 'This React version does not support scheduleUpdate');
    renderer.scheduleUpdate(fiber);
    return { ok: true, id: elementId, name: nameOf(fiber), via: 'scheduleUpdate' };
  },
});
