// Minimal stand-in for the relay daemon: answers /health like the real one and dies on SIGTERM.
// Spawned by daemon.test.ts through ensureRelayDaemon({ spawnCmd: [node, thisFile] }).
import { createServer } from 'node:http';

const i = process.argv.indexOf('--port');
const port = Number(process.argv[i + 1]);
const version = process.env.FAKE_VERSION ?? '0.0.0-test';
const instanceId = `fake-${process.pid}-${Math.random().toString(36).slice(2)}`;

const server = createServer((_req, res) => {
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify({ name: 'agent-debug-mcp', version, instanceId }));
});
server.on('error', (e) => {
  // e.g. EADDRINUSE when another daemon won a startup race — exit like the real CLI does
  process.stderr.write(`${e.message}\n`);
  process.exit(1);
});
server.listen(port, '127.0.0.1');
process.on('SIGTERM', () => process.exit(0));
