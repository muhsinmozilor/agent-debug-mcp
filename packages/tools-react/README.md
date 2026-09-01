# @devtools-mcp/tools-react

Page-side React tools. Fiber-centric: uses the React DevTools global hook (adopted if the official extension
installed it, otherwise installed by bippy) and bippy's fiber utilities.

- `hook.ts` — `initReactHook()` (call at `document_start`), renderer/root/commit tracking, `hasReact()`.
- `elements.ts` — stable element ids (`bippy.getFiberId`), `resolveElement` → `STALE_ELEMENT`.
- `naming.ts`, `tree.ts` — kind classification, display names, paginated pre-order tree with filters.
- `inspect.ts` — props / class state / hooks (`bippy/source.getFiberHooks`) / contexts / owners / source / host nodes, `expand`.
- `dom.ts`, `overlay.ts`, `pick.ts` — DOM↔fiber mapping, unique selectors, closed-shadow-root highlight, click-to-pick.
- `profiler.ts` — commit recording with render causes (props/hooks/state/context/parent/mount), summaries.
- `tools/*` — the tool executors; `descriptors.ts` — pure metadata imported by the relay.

Tests run in jsdom against real React 19; import `./hook-first.js` before `react-dom`.
