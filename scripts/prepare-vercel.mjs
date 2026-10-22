import { lstat, mkdir, readdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPublicAssets } from './check-public.mjs';

// Vercel deploys API functions only. Static frontend output belongs to Pages.
export async function prepareVercel(root = fileURLToPath(new URL('../', import.meta.url))) {
  await assertPublicAssets(root);
  const output = path.join(root, '.vercel-static');
  await mkdir(output, { recursive: true });
  const directory = await lstat(output);
  if (!directory.isDirectory() || directory.isSymbolicLink() || (await readdir(output)).length) {
    throw new Error('Vercel API output must be an empty directory; no frontend or personal files may be published here.');
  }
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await prepareVercel(); console.log('Vercel API prepared: static output is empty.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
