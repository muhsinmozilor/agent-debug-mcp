import { defineTool } from '@devtools-mcp/protocol';
import { detectReactBuildType } from 'bippy';
import { reactGetRenderersMeta } from '../descriptors.js';
import { getAllRoots, getReactHookState } from '../hook.js';

export interface RendererInfo {
  id: number;
  version: string | null;
  packageName: string | null;
  buildType: 'development' | 'production';
  rootCount: number;
  commitCount: number;
  lastCommitAt: number | null;
  supports: {
    overrideProps: boolean;
    overrideHookState: boolean;
    scheduleUpdate: boolean;
    findFiberByHostInstance: boolean;
    profiling: boolean;
  };
}

export interface RenderersResult {
  hookMode: string;
  hookInstalledAt: number;
  renderers: RendererInfo[];
  notes: string[];
}

export const reactGetRenderers = defineTool<Record<string, never>, RenderersResult>({
  ...reactGetRenderersMeta,
  execute: () => {
    const state = getReactHookState();
    const notes: string[] = [];
    if (!state) return { hookMode: 'none', hookInstalledAt: 0, renderers: [], notes: ['React hook not initialised'] };
    const roots = getAllRoots();
    const renderers: RendererInfo[] = [];
    for (const rec of state.renderers.values()) {
      const r = rec.renderer as unknown as { version?: string; rendererPackageName?: string; bundleType?: number };
      const buildType = detectReactBuildType(rec.renderer);
      if (buildType === 'production') {
        notes.push(`Renderer ${rec.id} is a production build: component names, hooks and source locations will be degraded.`);
      }
      renderers.push({
        id: rec.id,
        version: r.version ?? null,
        packageName: r.rendererPackageName ?? null,
        buildType,
        rootCount: roots.filter((x) => x.rendererId === rec.id).length,
        commitCount: rec.commitCount,
        lastCommitAt: rec.lastCommitAt,
        supports: {
          overrideProps: typeof rec.renderer.overrideProps === 'function',
          overrideHookState: typeof rec.renderer.overrideHookState === 'function',
          scheduleUpdate: typeof rec.renderer.scheduleUpdate === 'function',
          findFiberByHostInstance: typeof rec.renderer.findFiberByHostInstance === 'function',
          profiling: buildType === 'development',
        },
      });
    }
    if (state.mode === 'official-devtools') {
      notes.push('Hook adopted from the official React DevTools extension; both tools share it.');
    }
    return { hookMode: state.mode, hookInstalledAt: state.installedAt, renderers, notes };
  },
});
