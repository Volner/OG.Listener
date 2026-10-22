import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { prepareVercel } from '../scripts/prepare-vercel.mjs';

test('Vercel configuration routes only the API and health endpoint into one bounded Node function', async () => {
  const config = JSON.parse(await readFile(new URL('../vercel.json', import.meta.url), 'utf8'));
  assert.equal(config.framework, null);
  assert.equal(config.fluid, true);
  assert.equal(config.installCommand, '');
  assert.equal(config.buildCommand, 'node scripts/prepare-vercel.mjs');
  assert.equal(config.outputDirectory, '.vercel-static');
  assert.deepEqual(Object.keys(config.functions), ['api/index.js']);
  assert.equal(config.functions['api/index.js'].maxDuration, 300);
  assert.deepEqual(config.rewrites, [
    { source: '/api/:path*', destination: '/api/index' },
    { source: '/healthz', destination: '/api/index' },
  ]);
});

test('Vercel preparation leaves static output empty and refuses unexpected files', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'og-listener-vercel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = await prepareVercel(root);
  assert.equal(output, path.join(root, '.vercel-static'));
  assert.deepEqual(await readdir(output), []);
  await writeFile(path.join(output, 'private.json'), '{}');
  await assert.rejects(prepareVercel(root), /empty directory/);
  await rm(path.join(output, 'private.json'));
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public', 'export.json'), '{}');
  await assert.rejects(prepareVercel(root), /unexpected public assets/);
});
