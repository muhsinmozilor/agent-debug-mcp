import { defineConfig } from 'tsup';
export default defineConfig({
  // cli: the relay binary; index: programmatic API; vite: the `agent-debug-mcp/vite` plugin (no relay code inside).
  entry: { cli: 'src/cli.ts', index: 'src/index.ts', vite: 'src/vite.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  dts: { entry: { index: 'src/index.ts', vite: 'src/vite.ts' } },
  clean: true,
  sourcemap: true,
  external: ['vite'],
  // Bundle workspace packages so the published tarball is self-contained.
  noExternal: ['@devtools-mcp/protocol', '@devtools-mcp/tools-react', '@devtools-mcp/tools-tanstack-query', '@devtools-mcp/tools-tanstack-router'],
  banner: { js: '#!/usr/bin/env node' },
});
