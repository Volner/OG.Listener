const invalid = (message, status = 400, code = 'invalid_json') => Object.assign(new Error(message), { status, code });

/** Supports native IncomingMessage streams and JSON already parsed by the host. */
export async function readJsonBody(req, { maxBytes = 1024 * 1024 } = {}) {
  if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) {
    throw invalid('Нужен Content-Type: application/json.', 415, 'unsupported_media_type');
  }
  if (Number(req.headers['content-length']) > maxBytes) throw invalid('Запрос слишком большой.', 413, 'body_too_large');
  // Vercel can consume the stream and expose a lazy parsed-body getter.
  let parsed;
  try { parsed = req.body; } catch { throw invalid('Некорректный JSON.'); }
  if (parsed !== undefined) {
    let encoded;
    try { encoded = JSON.stringify(parsed); } catch { throw invalid('Некорректный JSON.'); }
    if (encoded === undefined) throw invalid('Некорректный JSON.');
    if (Buffer.byteLength(encoded, 'utf8') > maxBytes) throw invalid('Запрос слишком большой.', 413, 'body_too_large');
    return parsed;
  }
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > maxBytes) throw invalid('Запрос слишком большой.', 413, 'body_too_large');
    chunks.push(bytes);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw invalid('Некорректный JSON.'); }
}
