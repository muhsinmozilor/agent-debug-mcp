/**
 * Pure tool metadata — no DOM/React imports so the relay can load this in Node.
 * `execute` implementations live in ./tools and are attached by createReactTools().
 */
import { budgetSchema, pathSchema as basePathSchema, type JsonSchema, type ToolAnnotations, type ToolMeta } from '@devtools-mcp/protocol';

const RO: ToolAnnotations = { readOnlyHint: true, untrustedContentHint: true, openWorldHint: false };
const RW: ToolAnnotations = { readOnlyHint: false, untrustedContentHint: true, openWorldHint: false };

const pathSchema: JsonSchema = { ...basePathSchema, description: 'Path into the inspected value, e.g. ["props","items",0,"id"] or ["hooks",2].' };

const elementIdProp: JsonSchema = { type: 'integer', description: 'Component id from react_get_tree / react_search_components / react_find_by_dom.' };

export const reactGetRenderersMeta: ToolMeta = {
  name: 'react_get_renderers',
  title: 'React renderers',
  description:
    'List React renderers registered on the tab: React version, build type (development/production), number of roots, ' +
    'how the DevTools hook was obtained (adopted from the official React DevTools extension, or installed by Agent Debug MCP), ' +
    'and which capabilities (props/state override, profiling) the renderer supports. Call this first if other react_* tools fail.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: RO,
  capability: 'react',
  mutation: false,
};

export const reactGetTreeMeta: ToolMeta = {
  name: 'react_get_tree',
  title: 'React component tree',
  description:
    'Return the mounted React component tree as a paginated pre-order list. Each node has an `id` (stable while the ' +
    'component stays mounted; use it with react_inspect_element and friends), `name`, `kind`, `key`, `depth`, ' +
    '`parentId` and `childCount`. Host elements (div, span…) and wrapper nodes (Fragment, StrictMode…) are hidden by ' +
    'default. Apps using routers/providers nest deeply — raise `maxDepth` (default 6) or start from a `rootId`. ' +
    'Use `filter.nameRegex` to focus and `cursor` to fetch the next page.',
  inputSchema: {
    type: 'object',
    properties: {
      rootId: { type: 'integer', description: 'Element id to use as the subtree root (default: all React roots).' },
      maxDepth: { type: 'integer', minimum: 0, maximum: 64, default: 6, description: 'Max depth below the root(s).' },
      maxNodes: { type: 'integer', minimum: 1, maximum: 2000, default: 200, description: 'Page size.' },
      cursor: { type: 'string', description: 'Opaque cursor from a previous page.' },
      filter: {
        type: 'object',
        properties: {
          nameRegex: { type: 'string', description: 'Only include components whose display name matches (case-insensitive). Ancestors are still shown for context.' },
          hideHost: { type: 'boolean', default: true, description: 'Hide DOM host elements.' },
          hideWrappers: { type: 'boolean', default: true, description: 'Hide Fragment/StrictMode/Profiler/Offscreen wrappers.' },
        },
        additionalProperties: false,
      },
    },
    additionalProperties: false,
  },
  annotations: RO,
  capability: 'react',
  mutation: false,
};

export const reactInspectElementMeta: ToolMeta = {
  name: 'react_inspect_element',
  title: 'Inspect a React component',
  description:
    'Inspect one mounted component: props, state (class components), hooks (name, current value, editable?), consumed ' +
    'contexts, owner chain, source location (unsymbolicated; use react_get_source for file:line) and the DOM nodes it ' +
    'renders. Values deeper than the budget are collapsed to `{ "$": "object", "path": [...] }` stubs — pass those paths in ' +
    '`expand` to drill in without re-fetching everything. Non-JSON values are tagged (`{"$":"date"}`, `{"$":"fn"}`, `{"$":"map"}`…).',
  inputSchema: {
    type: 'object',
    properties: {
      elementId: elementIdProp,
      expand: { type: 'array', items: pathSchema, description: 'Paths (relative to {props,state,hooks,context}) to expand.' },
      budget: budgetSchema,
    },
    required: ['elementId'],
    additionalProperties: false,
  },
  annotations: RO,
  capability: 'react',
  mutation: false,
};

export const reactSearchComponentsMeta: ToolMeta = {
  name: 'react_search_components',
  title: 'Search components',
  description:
    'Find mounted components by display-name regex and/or a substring that must appear in their props (matched against a ' +
    'compact preview of the props). Returns ids, names, depth and the ancestor chain so you can orient without dumping the tree.',
  inputSchema: {
    type: 'object',
    properties: {
      nameRegex: { type: 'string', description: 'Case-insensitive regex on the component display name.' },
      propsContains: { type: 'string', description: 'Substring that must appear in the props preview (e.g. a label or id value).' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 25 },
    },
    additionalProperties: false,
  },
  annotations: RO,
  capability: 'react',
  mutation: false,
};

export const reactFindByDomMeta: ToolMeta = {
  name: 'react_find_by_dom',
  title: 'DOM selector → component',
  description:
    'Resolve a CSS selector to the React component(s) that rendered the matching DOM element(s): nearest composite ' +
    'component id/name plus its ancestor chain. Use `nth` to pick one match; otherwise up to 10 matches are returned.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector, e.g. `[data-testid="save"]` or `main button`.' },
      nth: { type: 'integer', minimum: 0, description: 'Zero-based index among matches.' },
    },
    required: ['selector'],
    additionalProperties: false,
  },
  annotations: RO,
  capability: 'react',
  mutation: false,
};

export const reactGetDomNodesMeta: ToolMeta = {
  name: 'react_get_dom_nodes',
  title: 'Component → DOM nodes',
  description: 'List the host DOM nodes a component renders (tag, unique CSS selector, bounding rect, text preview).',
  inputSchema: { type: 'object', properties: { elementId: elementIdProp }, required: ['elementId'], additionalProperties: false },
  annotations: RO,
  capability: 'react',
  mutation: false,
};

export const reactGetSourceMeta: ToolMeta = {
  name: 'react_get_source',
  title: 'Component source location',
  description:
    'Resolve where a component is defined and where its JSX was created: file, line, column and function name, symbolicated ' +
    'through source maps when the dev server serves them (React 19 has no _debugSource; this uses the owner stack). Also ' +
    'returns the raw (bundle) frame and the owner stack.',
  inputSchema: { type: 'object', properties: { elementId: elementIdProp }, required: ['elementId'], additionalProperties: false },
  annotations: RO,
  capability: 'react',
  mutation: false,
  timeoutMs: 30_000,
};

export const pageHighlightMeta: ToolMeta = {
  name: 'page_highlight',
  title: 'Highlight on page',
  description:
    'Draw a temporary highlight overlay around a component (by `elementId`) or DOM elements (by CSS `selector`) so the ' +
    'user can see what you are referring to. Purely visual; does not modify the app.',
  inputSchema: {
    type: 'object',
    properties: {
      elementId: elementIdProp,
      selector: { type: 'string', description: 'CSS selector (alternative to elementId).' },
      durationMs: { type: 'integer', minimum: 100, maximum: 60000, default: 3000 },
      label: { type: 'string', description: 'Optional caption shown with the highlight.' },
    },
    additionalProperties: false,
  },
  annotations: RW,
  capability: 'page',
  mutation: false,
};

export const pageElementAtPointMeta: ToolMeta = {
  name: 'page_element_at_point',
  title: 'Element at viewport point',
  description: 'Return the DOM element at viewport coordinates (x, y) and the React component that rendered it, with ancestors.',
  inputSchema: {
    type: 'object',
    properties: { x: { type: 'number' }, y: { type: 'number' } },
    required: ['x', 'y'],
    additionalProperties: false,
  },
  annotations: RO,
  capability: 'page',
  mutation: false,
};

export const pagePickElementMeta: ToolMeta = {
  name: 'page_pick_element',
  title: 'Ask the user to click an element',
  description:
    'Enter a pick mode on the page: elements highlight on hover and the next click is captured (not delivered to the app). ' +
    'Returns the clicked DOM element and its React component. Blocks until the user clicks, presses Escape, or `timeoutMs` elapses.',
  inputSchema: {
    type: 'object',
    properties: { timeoutMs: { type: 'integer', minimum: 1000, maximum: 300000, default: 60000 } },
    additionalProperties: false,
  },
  annotations: RW,
  capability: 'page',
  mutation: false,
  timeoutMs: 305_000,
};

const MUT: ToolAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, untrustedContentHint: true, openWorldHint: false };

export const reactOverrideValueMeta: ToolMeta = {
  name: 'react_override_value',
  title: 'Override a prop / hook state / class state value',
  description:
    'Set a value inside a mounted component and re-render it, like editing in React DevTools. `kind` selects the store: ' +
    '"props" (path into props), "hooks" (path starts with the hook index from react_inspect_element, then into its state — only ' +
    'useState/useReducer are editable), "state" (class component state). `value` accepts plain JSON or tagged values ' +
    '({"$":"date","iso":…}, {"$":"undefined"}, {"$":"map",…}). Requires a development React build and the per-origin mutation toggle.',
  inputSchema: {
    type: 'object',
    properties: {
      elementId: elementIdProp,
      kind: { type: 'string', enum: ['props', 'hooks', 'state'] },
      path: { type: 'array', items: { type: ['string', 'integer'] }, minItems: 1, description: 'Path within the store, e.g. ["items", 0, "label"] or [0] for hook #0.' },
      value: { description: 'New value (JSON or tagged).' },
    },
    required: ['elementId', 'kind', 'path', 'value'],
    additionalProperties: false,
  },
  annotations: MUT,
  capability: 'react',
  mutation: true,
};

export const reactForceRerenderMeta: ToolMeta = {
  name: 'react_force_rerender',
  title: 'Force a re-render',
  description: 'Schedule an update on a component (and thus its subtree) without changing props or state. Useful to observe render behaviour with react_watch_renders.',
  inputSchema: { type: 'object', properties: { elementId: elementIdProp }, required: ['elementId'], additionalProperties: false },
  annotations: MUT,
  capability: 'react',
  mutation: true,
};

export const reactProfileStartMeta: ToolMeta = {
  name: 'react_profile_start',
  title: 'Start render profiling',
  description:
    'Start recording React commits. Each commit records which components rendered, their self render time (dev builds), and ' +
    'WHY: changed prop keys, changed hook indices, class state, context, first mount, or "parent" (re-rendered only because a parent did). ' +
    'Interact with the app, then call react_profile_stop for a summary and react_profile_get_commits for details.',
  inputSchema: { type: 'object', properties: { recordChangeDescriptions: { type: 'boolean', default: true } }, additionalProperties: false },
  annotations: RW,
  capability: 'react',
  mutation: false,
};

export const reactProfileStopMeta: ToolMeta = {
  name: 'react_profile_stop',
  title: 'Stop render profiling',
  description:
    'Stop the current profiling session and return a summary: commit count, total duration, render-cause histogram, hottest components ' +
    '(by self time) and most-rendered components with the props that changed most often. Data stays available for react_profile_get_commits unless keepData=false.',
  inputSchema: { type: 'object', properties: { keepData: { type: 'boolean', default: true } }, additionalProperties: false },
  annotations: RW,
  capability: 'react',
  mutation: false,
};

export const reactProfileGetCommitsMeta: ToolMeta = {
  name: 'react_profile_get_commits',
  title: 'Get profiled commits',
  description: 'Page through the commits of the last profile: timestamp, duration, and per-component render records (id, name, phase, causes, changedProps, changedHooks, selfDurationMs). Filter by `minDurationMs` or a `component` name regex.',
  inputSchema: {
    type: 'object',
    properties: {
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
      minDurationMs: { type: 'number', minimum: 0 },
      component: { type: 'string', description: 'Only commits (and renders) matching this component-name regex.' },
    },
    additionalProperties: false,
  },
  annotations: RO,
  capability: 'react',
  mutation: false,
};

export const reactWatchRendersMeta: ToolMeta = {
  name: 'react_watch_renders',
  title: 'Watch renders live',
  description:
    'Block for `durationMs` (default 10 s) while recording commits, streaming progress, then return a digest: render-cause histogram, ' +
    'most-rendered/hottest components and a compact timeline like `Counter(props)`, `App(hooks)`, `Themed(context)`, `List(parent)`. ' +
    'Use it to catch unnecessary re-renders while you (or the user) interact with the page. Cancel any time.',
  inputSchema: {
    type: 'object',
    properties: {
      durationMs: { type: 'integer', minimum: 100, maximum: 300000, default: 10000 },
      filter: { type: 'object', properties: { nameRegex: { type: 'string' } }, additionalProperties: false },
      maxEvents: { type: 'integer', minimum: 1, maximum: 5000, default: 500, description: 'Stop early after this many component renders.' },
    },
    additionalProperties: false,
  },
  annotations: RO,
  capability: 'react',
  mutation: false,
  timeoutMs: 310_000,
};

export const pageGetErrorsMeta: ToolMeta = {
  name: 'page_get_errors',
  title: 'Errors since last check',
  description:
    'Runtime problems recorded in this document since it loaded: uncaught exceptions, unhandled promise rejections, ' +
    'console.error (React error-boundary catches and React warnings are tagged `react`, with the component stack), failed ' +
    'TanStack queries/mutations and router match errors. Use it as the verification step after a change or an action: pass ' +
    'the `latestSeq` from the previous call as `since` to get only what happened in between. Consecutive duplicates are ' +
    'collapsed with a `count`. Buffer holds the last 200 entries per document.',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'integer', minimum: 0, description: 'Return only entries with seq greater than this (use latestSeq from the previous call).' },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['exception', 'unhandledrejection', 'console.error', 'console.warn', 'react', 'query', 'mutation', 'router'] },
        description: 'Restrict to these kinds. Default: everything except console.warn.',
      },
      includeWarnings: { type: 'boolean', default: false, description: 'Include console.warn entries when `kinds` is not given.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Most recent N matching entries.' },
    },
    additionalProperties: false,
  },
  annotations: RO,
  capability: 'page',
  mutation: false,
};

export const pageSnapshotMeta: ToolMeta = {
  name: 'page_snapshot',
  title: 'Page outline with owning components',
  description:
    'Compact accessibility-style outline of the page: one line per meaningful element (landmarks, headings, links, buttons, ' +
    'inputs, lists, paragraphs, anything with data-testid) with role, name, state attributes, a CSS selector and the React ' +
    'component that rendered it (`→ Name#elementId`, printed where it changes). One call gives both an actionable target ' +
    '(selector for Playwright / react_find_by_dom) and the component to inspect (elementId for react_inspect_element / ' +
    'react_explain). Hidden elements are skipped. Prefer this over react_get_tree to orient on what the user sees.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'Root element to outline (default body).' },
      maxNodes: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
      interactiveOnly: { type: 'boolean', default: false, description: 'Only links, buttons, inputs and other focusable controls.' },
      format: { type: 'string', enum: ['text', 'json'], default: 'text', description: '`text` = indented outline (fewest tokens); `json` = structured nodes.' },
    },
    additionalProperties: false,
  },
  annotations: RO,
  capability: 'page',
  mutation: false,
};

export const reactExplainMeta: ToolMeta = {
  name: 'react_explain',
  title: 'Everything about one component',
  description:
    'One-call summary of the component behind a DOM element or elementId: props, hooks, contexts, owners and ancestors, the ' +
    'DOM nodes it renders, and its source location (symbolicated through source maps when available). Equivalent to ' +
    'react_find_by_dom + react_inspect_element + react_get_dom_nodes + react_get_source. Start here when asked "why does this ' +
    'element look/behave like that"; follow with the profiler or query tools it points to.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of a rendered element (from page_snapshot or a Playwright locator).' },
      nth: { type: 'integer', minimum: 0, default: 0, description: 'Which selector match to use.' },
      elementId: elementIdProp,
      expand: { type: 'array', items: pathSchema, description: 'Paths (relative to {props,state,hooks,context}) to expand in full.' },
    },
    additionalProperties: false,
  },
  annotations: RO,
  capability: 'react',
  mutation: false,
  timeoutMs: 30_000,
};

export const reactToolMetas: ToolMeta[] = [
  pageSnapshotMeta,
  pageGetErrorsMeta,
  reactExplainMeta,
  reactGetRenderersMeta,
  reactGetTreeMeta,
  reactInspectElementMeta,
  reactSearchComponentsMeta,
  reactFindByDomMeta,
  reactGetDomNodesMeta,
  reactGetSourceMeta,
  pageHighlightMeta,
  pageElementAtPointMeta,
  pagePickElementMeta,
  reactOverrideValueMeta,
  reactForceRerenderMeta,
  reactProfileStartMeta,
  reactProfileStopMeta,
  reactProfileGetCommitsMeta,
  reactWatchRendersMeta,
];
