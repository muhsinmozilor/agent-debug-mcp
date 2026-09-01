# Contributing

## Setup

```bash
corepack enable pnpm        # or: npm i -g pnpm
pnpm install                # approves the esbuild build script via pnpm-workspace.yaml allowBuilds
pnpm typecheck && pnpm test
pnpm --filter @devtools-mcp/extension build
pnpm --filter e2e exec playwright install chromium
pnpm test:e2e
```

Load the extension for manual testing: `chrome://extensions` → Developer mode → Load unpacked →
`packages/extension/.output/chrome-mv3`. Run `pnpm dev:relay` (the extension pairs with it on its own), then
`pnpm dev:demo` and visit http://localhost:5199.

## Layout and rules

See `CLAUDE.md` for the conventions every change must respect (single tool definition, fixed tool list,
relay-injected `tab`, no re-encoding, mutation gating, trust boundary). `docs/ARCHITECTURE.md` explains why.

## Adding a tool

1. `ToolMeta` in `packages/<tools-pkg>/src/descriptors.ts` (pure metadata; JSON Schema input; `capability`;
   `mutation`). The `ToolMeta` type and the shared `budgetSchema`/`pathSchema` fragments come from
   `@devtools-mcp/protocol`.
2. `defineTool({ ...meta, execute })` in `src/tools/`, registered in `create*Tools()`.
3. Unit test (jsdom). React tests import `./hook-first.js` first.
4. Rebuild the extension; add an e2e assertion in `e2e/tests`.
5. `pnpm docs:tools` to regenerate `docs/TOOLS.md`; mention the tool in `CHANGELOG.md`.

Tool descriptions are read by LLMs: say what the tool returns, when to use it, and what to call next.
Prefer paginated/summarised output with `expand` paths over dumping everything.

## Adding a capability (a new framework/library)

Create `packages/tools-<name>` mirroring `tools-tanstack-router` (discovery via a page global + a `watch*`
poller wrapping protocol's `watchGlobal`, `descriptors.ts`, `tools.ts`, tests). Wire it into `main.content.ts` (registry + capability watcher),
`relay.content.ts` (`MUTATION_TOOLS`), `relay/src/mcp.ts` (`RELAY_TOOL_METAS`), `relay/tsup.config.ts`
(`noExternal`), and add the capability name to `CAPABILITIES` in `packages/protocol/src/tool.ts`.

## Releasing the relay

Bump `version` in `packages/relay/package.json` **and** `RELAY_VERSION` in `packages/relay/src/index.ts` (the script
refuses to publish if they differ), update `CHANGELOG.md`, then:

```bash
cp .env.example .env      # once; put your npm token in NPM_TOKEN (git-ignored)
pnpm release:relay -- --dry-run   # typecheck, tests, build, show the tarball
pnpm release:relay                # publish agent-debug-mcp@<version> (--tag next for pre-releases; --otp <code> if your token needs 2FA)
git tag v<version> && git push --tags
```

The token is read from `.env` and passed to npm through a temporary `--userconfig`, so it never lands in
`~/.npmrc`. `pnpm --filter agent-debug-mcp build` alone produces `dist/cli.js`, `dist/index.js` and `dist/vite.js`
(workspace packages are bundled; `vite` stays external).

## Style

TypeScript strict, ESM, no default exports except WXT entrypoints. Errors are `DevtoolsError` with a hint.
Keep page-side code free of `chrome.*` (MAIN world has none) and keep `descriptors.ts` free of DOM imports.
