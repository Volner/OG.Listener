import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { assertPublicAssets } from '../scripts/check-public.mjs';

test('public asset guard rejects personal exports, including renamed or nested data', async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), 'og-public-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'public/data'), { recursive: true });
  await writeFile(path.join(root, 'public/favicon.svg'), '<svg/>');
  await assertPublicAssets(root);
  await writeFile(path.join(root, 'public/data/library.json'), '{"events":[[1,2,3]]}');
  await assert.rejects(assertPublicAssets(root), /Build blocked.*data\/library.json/);
});
