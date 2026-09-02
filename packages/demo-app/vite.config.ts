import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';
// The demo uses the Agent Debug MCP Vite plugin (from source, so no build step is needed) instead of assigning
// window.__TANSTACK_QUERY_CLIENT__ / __TANSTACK_ROUTER__ by hand — see packages/relay/src/vite.ts (agent-debug-mcp/vite).
import { agentDebugMcp } from '../relay/src/vite.ts';
export default defineConfig({ plugins: [react(), agentDebugMcp()], server: { port: 5199, strictPort: true } });
