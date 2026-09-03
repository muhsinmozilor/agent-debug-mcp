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
    'List React renderers on the tab: version, build type (development/production), root count, how the DevTools hook ' +
    'was obtained, and supported capabilities (override, profiling). Call this first if other react_* tools fail.',
  inputSchema: { type: 'object', properties: {}, additionalProperties: false },
  annotations: RO,
  capability: 'react',
  mutation: false,
};

export const reactGetTreeMeta: ToolMeta = {
  name: 'react_get_tree',
  title: 'React component tree',
  description:
    'Mounted React component tree as a paginated pre-order list: id (stable while mounted; used by react_inspect_element ' +
    'and friends), name, kind, key, depth, parentId, childCount. Host elements and wrappers are hidden by default. ' +
    'Deeply nested apps need a higher `maxDepth` (default 6) or a `rootId` start.',
  inputSchema: {
    type: 'object',
    properties: {
      rootId: { type: 'integer', description: 'Subtree root element id (default: all React roots).' },
      maxDepth: { type: 'integer', minimum: 0, maximum: 64, default: 6 },
      maxNodes: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
      cursor: { type: 'string' },
      filter: {
        type: 'object',
        properties: {
          nameRegex: { type: 'string', description: 'Only components whose display name matches (case-insensitive); ancestors kept for context.' },
          hideHost: { type: 'boolean', default: true },
          hideWrappers: { type: 'boolean', default: true },
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
    'Inspect one mounted component: props, class state, hooks (name, value, editable?), contexts, owner chain, raw source ' +
    'location (react_get_source symbolicates) and rendered DOM nodes. Values beyond the budget collapse to ' +
    '`{ "$": "object", "path": [...] }` stubs — pass those paths in `expand` to drill in. Non-JSON values are tagged (`{"$":"date"}`, `{"$":"fn"}`…).',
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
    'Find mounted components by display-name regex and/or a substring of their props preview. Returns ids, names, depth and ancestor chain.',
  inputSchema: {
    type: 'object',
    properties: {
      nameRegex: { type: 'string', description: 'Case-insensitive regex on the display name.' },
      propsContains: { type: 'string', description: 'Substring that must appear in the props preview.' },
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
    'Resolve a CSS selector to the React component(s) that rendered it: nearest composite component id/name plus ancestors. Up to 10 matches unless `nth` picks one.',
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
    'Where a component is defined and where its JSX was created: file, line, column, function name — symbolicated through ' +
    'source maps when the dev server serves them. Also returns the raw bundle frame and the owner stack.',
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
    'Draw a temporary highlight overlay around a component (`elementId`) or DOM elements (`selector`) to show the user what you mean. Purely visual.',
  inputSchema: {
    type: 'object',
    properties: {
      elementId: elementIdProp,
      selector: { type: 'string', description: 'CSS selector (alternative to elementId).' },
      durationMs: { type: 'integer', minimum: 100, maximum: 60000, default: 3000 },
      label: { type: 'string', description: 'Caption shown with the highlight.' },
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
    'Pick mode: elements highlight on hover; the next click is captured (not delivered to the app) and returned as DOM ' +
    'element + React component. Blocks until the user clicks, presses Escape, or `timeoutMs` elapses.',
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
    'Set a value inside a mounted component and re-render it, like editing in React DevTools. `kind`: "props", "hooks" ' +
    '(path starts with the hook index from react_inspect_element; only useState/useReducer are editable) or "state" (class components). ' +
    '`value` accepts JSON or tagged values ({"$":"date","iso":…}, {"$":"undefined"}…). Requires a dev React build and the per-origin mutation toggle.',
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
  description: 'Schedule an update on a component subtree without changing props or state (e.g. to observe with react_watch_renders).',
  inputSchema: { type: 'object', properties: { elementId: elementIdProp }, required: ['elementId'], additionalProperties: false },
  annotations: MUT,
  capability: 'react',
  mutation: true,
};

export const reactProfileStartMeta: ToolMeta = {
  name: 'react_profile_start',
  title: 'Start render profiling',
  description:
    'Start recording React commits: which components rendered, self render time (dev builds), and WHY — changed prop keys, ' +
    'changed hook indices, class state, context, first mount, or "parent" (only because a parent did). Interact, then ' +
    'react_profile_stop for a summary and react_profile_get_commits for details.',
  inputSchema: { type: 'object', properties: { recordChangeDescriptions: { type: 'boolean', default: true } }, additionalProperties: false },
  annotations: RW,
  capability: 'react',
  mutation: false,
};

export const reactProfileStopMeta: ToolMeta = {
  name: 'react_profile_stop',
  title: 'Stop render profiling',
  description:
    'Stop profiling and summarise: commit count, total duration, render-cause histogram, hottest and most-rendered ' +
    'components with their most-changed props. Data stays available for react_profile_get_commits unless keepData=false.',
  inputSchema: { type: 'object', properties: { keepData: { type: 'boolean', default: true } }, additionalProperties: false },
  annotations: RW,
  capability: 'react',
  mutation: false,
};

export const reactProfileGetCommitsMeta: ToolMeta = {
  name: 'react_profile_get_commits',
  title: 'Get profiled commits',
  description: 'Page through the commits of the last profile: timestamp, duration, per-component render records (id, name, phase, causes, changedProps, changedHooks, selfDurationMs).',
  inputSchema: {
    type: 'object',
    properties: {
      cursor: { type: 'string' },
      limit: { type: 'integer', minimum: 1, maximum: 200, default: 20 },
      minDurationMs: { type: 'number', minimum: 0 },
      component: { type: 'string', description: 'Component-name regex filter.' },
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
    'Block for `durationMs` (default 10 s) recording commits while you or the user interact, then return a digest: ' +
    'render-cause histogram, hottest components and a compact timeline like `Counter(props)`, `List(parent)`. Catches unnecessary re-renders. Cancel any time.',
  inputSchema: {
    type: 'object',
    properties: {
      durationMs: { type: 'integer', minimum: 100, maximum: 300000, default: 10000 },
      filter: { type: 'object', properties: { nameRegex: { type: 'string' } }, additionalProperties: false },
      maxEvents: { type: 'integer', minimum: 1, maximum: 5000, default: 500, description: 'Stop early after this many renders.' },
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
    'Runtime problems recorded since the document loaded: uncaught exceptions, unhandled rejections, console.error ' +
    '(React ones tagged `react` with the component stack), failed TanStack queries/mutations and router match errors. ' +
    'Use as the verification step after a change or action: pass the previous call\'s `latestSeq` as `since` to get only what happened in between.',
  inputSchema: {
    type: 'object',
    properties: {
      since: { type: 'integer', minimum: 0, description: 'Only entries with seq greater than this (latestSeq from the previous call).' },
      kinds: {
        type: 'array',
        items: { type: 'string', enum: ['exception', 'unhandledrejection', 'console.error', 'console.warn', 'react', 'query', 'mutation', 'router'] },
        description: 'Default: everything except console.warn.',
      },
      includeWarnings: { type: 'boolean', default: false, description: 'Include console.warn when `kinds` is not given.' },
      limit: { type: 'integer', minimum: 1, maximum: 500, default: 50 },
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
    'Compact accessibility-style outline of the page: one line per meaningful element with role, name, state, a CSS ' +
    'selector and the owning React component (`→ Name#elementId`). One call gives both an automation target (selector) ' +
    'and the component to inspect (elementId). Prefer this over react_get_tree to orient on what the user sees.',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'Root element to outline (default body).' },
      maxNodes: { type: 'integer', minimum: 1, maximum: 2000, default: 200 },
      interactiveOnly: { type: 'boolean', default: false, description: 'Only focusable controls.' },
      format: { type: 'string', enum: ['text', 'json'], default: 'text', description: '`text` = indented outline (fewest tokens).' },
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
    'One-call summary of the component behind a CSS selector or elementId: props, hooks, contexts, owners, rendered DOM ' +
    'nodes and symbolicated source location. Equivalent to react_find_by_dom + react_inspect_element + react_get_dom_nodes + ' +
    'react_get_source. Start here for "why does this element look/behave like that".',
  inputSchema: {
    type: 'object',
    properties: {
      selector: { type: 'string', description: 'CSS selector of a rendered element (e.g. from page_snapshot).' },
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
