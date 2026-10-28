import path from 'node:path';
import { pathToFileURL } from 'node:url';

let server;
let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  const timeout = setTimeout(() => process.exit(1), 10_000);
  try { await server?.close(); } finally { clearTimeout(timeout); process.exit(0); }
}
process.on('message', (message) => { if (message === 'stop') stop(); });
process.on('disconnect', stop);
process.on('SIGTERM', stop);
process.on('SIGINT', stop);

try {
  const { startServer } = await import(pathToFileURL(path.join(process.env.SP_PWA_GAME, 'server/index.js')).href);
  server = await startServer({
    port: Number(process.env.SP_PWA_PORT), host: process.env.SP_PWA_HOST,
    pluginsDir: process.env.SP_PWA_PLUGINS,
  });
  process.send?.({ ready: true, port: server.port });
} catch (error) {
  process.send?.({ error: error.message });
  console.error(error);
  process.exit(1);
}
