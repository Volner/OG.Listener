import { defineConfig, loadEnv } from 'vite';
import { createLocalApi } from './server/local-api.js';
import { createAudienceApi } from './server/audience.mjs';
import { assertPublicAssets } from './scripts/check-public.mjs';
import { readPagesConfig } from './scripts/pages-config.mjs';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const pages = mode === 'pages' ? readPagesConfig(env) : null;
  const key = Symbol.for('og-listener.local-api.instances');
  const instances = globalThis[key] ||= new Map();
  function attach(server) {
    const root = server.config.root;
    const beforeReady = instances.get(root)?.close();
    const api = createLocalApi({ root, env, beforeReady, audienceHandler: createAudienceApi({ env }) });
    instances.set(root, api);
    server.middlewares.use(api.middleware);
    server.httpServer?.once('close', () => {
      void api.close().finally(() => { if (instances.get(root) === api) instances.delete(root); });
    });
  }
  const plugin = {
    name: 'og-listener-local-api',
    async buildStart() { await assertPublicAssets(process.cwd()); },
    configureServer: pages ? undefined : attach,
    configurePreviewServer: pages ? undefined : attach,
  };
  return { base: pages?.base || '/', plugins: [plugin], server: { fs: { deny: ['.env', '.env.*', '*.{crt,pem}', '**/.git/**', '**/upload/**', '**/private-data/**'] } } };
});
