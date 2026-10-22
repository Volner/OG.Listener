import { parseHistoryFiles } from './lib/history.js';
self.onmessage = async ({ data }) => {
  try { self.postMessage({ dataset: await parseHistoryFiles(data.files) }); }
  catch (error) { self.postMessage({ error: error.message || 'Не удалось прочитать архив.' }); }
};
