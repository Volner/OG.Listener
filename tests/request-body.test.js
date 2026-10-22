import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { readJsonBody } from '../server/request-body.js';

function stream(chunks, headers = {}) {
  const req = Readable.from(chunks);
  req.headers = { 'content-type': 'application/json', ...headers };
  return req;
}

test('JSON body reader supports native streams and host-parsed bodies without rereading them', async () => {
  assert.deepEqual(await readJsonBody(stream([Buffer.from('{"tracks":'), Buffer.from('[]}')])), { tracks: [] });
  const req = { headers: { 'content-type': 'application/json; charset=utf-8' }, body: { tracks: [] }, [Symbol.asyncIterator]() { assert.fail('The host already consumed this stream.'); } };
  assert.deepEqual(await readJsonBody(req), { tracks: [] });
});

test('JSON body size limits apply to declared, streamed and parsed UTF-8 payloads', async () => {
  await assert.rejects(readJsonBody(stream(['{}'], { 'content-length': '30' }), { maxBytes: 10 }), error => error.status === 413);
  await assert.rejects(readJsonBody(stream(['{"value":"', 'x'.repeat(20), '"}']), { maxBytes: 10 }), error => error.status === 413);
  await assert.rejects(readJsonBody({ headers: { 'content-type': 'application/json' }, body: { value: '\u044f'.repeat(6) } }, { maxBytes: 20 }), error => error.status === 413);
});

test('JSON body reader reports malformed JSON and failing host getters without leaking payloads', async () => {
  await assert.rejects(readJsonBody(stream(['secret-invalid-json'])), error => error.status === 400 && !error.message.includes('secret'));
  const req = { headers: { 'content-type': 'application/json' } };
  Object.defineProperty(req, 'body', { get() { throw new SyntaxError('private host detail'); } });
  await assert.rejects(readJsonBody(req), error => error.status === 400 && !error.message.includes('private'));
  await assert.rejects(readJsonBody(stream(['{}'], { 'content-type': 'text/plain' })), error => error.status === 415);
});
