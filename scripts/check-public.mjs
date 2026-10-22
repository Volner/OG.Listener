import { readdir } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

// A private export must never become a static asset, including a renamed export.
// Add deliberately public assets here when the application needs them.
const allowed = new Set(['favicon.svg']);

export async function assertPublicAssets(root = process.cwd()) {
  const directory = path.join(root, 'public');
  const unexpected = [];
  async function visit(relative = '') {
    let entries;
    try { entries = await readdir(path.join(directory, relative), { withFileTypes: true }); }
    catch (error) { if (error.code === 'ENOENT' && !relative) return; throw error; }
    for (const entry of entries) {
      const name = path.posix.join(relative, entry.name);
      if (entry.isDirectory()) await visit(name);
      else if (!entry.isFile() || !allowed.has(name)) unexpected.push(name);
    }
  }
  await visit();
  if (unexpected.length) throw new Error(`Build blocked: unexpected public assets (${unexpected.join(', ')}). Listening history and personal catalogues must stay outside public/.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  try { await assertPublicAssets(); console.log('Public assets checked: no bundled listening history.'); }
  catch (error) { console.error(error.message); process.exitCode = 1; }
}
