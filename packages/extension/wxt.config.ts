import { defineConfig } from 'wxt';
import { DEV_MATCHES } from './src/lib/dev-matches';

export default defineConfig({
  srcDir: 'src',
  imports: false,
  manifestVersion: 3,
  // Store / release artifact: .output/agent-debug-mcp-<version>-chrome.zip (default would use the workspace package name).
  zip: { name: 'agent-debug-mcp' },
  manifest: {
    name: 'Agent Debug MCP',
    description: 'Expose React DevTools and TanStack Query/Router state to coding agents over MCP.',
    permissions: ['storage', 'alarms', 'scripting', 'tabs', 'debugger'],
    host_permissions: DEV_MATCHES,
    optional_host_permissions: ['<all_urls>'],
    minimum_chrome_version: '125', // chrome.debugger child sessions (DebuggerSession.sessionId) for the CDP bridge
    action: { default_title: 'Agent Debug MCP' },
  },
});
