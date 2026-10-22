import { lstat, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertPublicAssets } from './check-public.mjs';

// Vercel requires nonempty static output for this build configuration. Publish
// only this generated API landing page; the frontend belongs to GitHub Pages.
const API_PAGE = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <meta name="robots" content="noindex">
  <title>OG.Listener API</title>
</head>
<body>
  <main>
    <h1>OG.Listener API</h1>
    <p><a href="/healthz">Health check</a></p>
  </main>
</body>
</html>
`;

export async function prepareVercel(root = fileURLToPath(new URL('../', import.meta.url))) {
  await assertPublicAssets(root);
  const output = path.join(root, '.vercel-static');
  await mkdir(output, { recursive: true });
  const directory = await lstat(output);
  if (!directory.isDirectory() || directory.isSymbolicLink()) {
    throw new Error('Vercel API output must be a regular directory.');
  }
  const entries = await readdir(output, { withFileTypes: true });
  if (entries.some(entry => entry.name !== 'index.html' || !entry.isFile())) {
    throw new Error('Vercel API output contains unexpected files; only the generated index.html may be published.');
  }
  const index = path.join(output, 'index.html');
  if (entries.length) {
    if (await readFile(index, 'utf8') !== API_PAGE) {
      throw new Error('Vercel API index.html does not match the generated page; refusing to publish unexpected content.');
    }
  } else await writeFile(index, API_PAGE, { encoding: 'utf8', flag: 'wx' });
  return output;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await prepareVercel(); console.log('Vercel API prepared: generated API landing page.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
