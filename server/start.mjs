import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { createProductionServer } from './http-server.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
// Environment variables provided by the host take precedence over the optional
// local file. Production containers receive their secrets at runtime only.
try { loadEnvFile(path.join(root, '.env.local')); } catch (error) {
  if (error.code !== 'ENOENT') { console.error('Unable to read local environment configuration.'); process.exit(1); }
}
const port = Number(process.env.PORT || 3000);
const host = process.env.HOST || '127.0.0.1';
if (!Number.isInteger(port) || port < 1 || port > 65535 || !/^[A-Za-z0-9.:[\]-]+$/.test(host)) {
  console.error('Provide a valid HOST and PORT (1-65535).');
  process.exit(1);
}
let app;
try {
  app = await createProductionServer({ root, env: process.env });
  await app.listen({ port, host });
  console.info(`OG.Listener is listening on port ${port}.`);
} catch {
  await app?.close();
  console.error('Unable to start OG.Listener. Verify server configuration; build the frontend when API_ONLY is false.');
  process.exit(1);
}
let exiting = false;
async function shutdown() {
  if (exiting) return;
  exiting = true;
  await app.close();
  process.exit(0);
}
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
