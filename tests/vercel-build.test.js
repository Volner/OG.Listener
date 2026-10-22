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
  assert.equal(Object.hasOwn(config.functions['api/index.js'], 'runtime'), false,
    'Vercel must infer its built-in Node runtime; functions.runtime is for versioned runtime packages');
  assert.deepEqual(config.rewrites, [
    { source: '/api/:path*', destination: '/api/index' },
    { source: '/healthz', destination: '/api/index' },
  ]);
});

test('Vercel preparation generates nonempty static output and can be repeated', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'og-listener-vercel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = await prepareVercel(root);
  assert.equal(output, path.join(root, '.vercel-static'));
  assert.deepEqual(await readdir(output), ['index.html']);
  const page = await readFile(path.join(output, 'index.html'), 'utf8');
  assert.match(page, /^<!doctype html>/i);
  assert.match(page, /<title>OG\.Listener API<\/title>/);
  assert.match(page, /href="\/healthz"/);
  assert.equal(await prepareVercel(root), output);
  assert.equal(await readFile(path.join(output, 'index.html'), 'utf8'), page);
});

test('Vercel preparation refuses unexpected files, modified output and private public assets', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'og-listener-vercel-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const output = await prepareVercel(root);
  await writeFile(path.join(output, 'private.json'), '{}');
  await assert.rejects(prepareVercel(root), /unexpected files/);
  await rm(path.join(output, 'private.json'));
  await writeFile(path.join(output, 'index.html'), '<h1>Personal data</h1>');
  await assert.rejects(prepareVercel(root), /unexpected content/);
  await mkdir(path.join(root, 'public'));
  await writeFile(path.join(root, 'public', 'export.json'), '{}');
  await assert.rejects(prepareVercel(root), /unexpected public assets/);
});
