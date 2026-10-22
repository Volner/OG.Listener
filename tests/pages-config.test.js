import test from 'node:test';
import assert from 'node:assert/strict';
import { readPagesConfig } from '../scripts/pages-config.mjs';

test('Pages requires an explicit HTTPS API origin before publishing', () => {
  assert.throws(() => readPagesConfig(), /VITE_API_BASE_URL/);
  for (const api of ['http://api.example.com', 'https://api.example.com/api', 'https://user:secret@api.example.com', 'https://api.example.com?token=secret']) {
    assert.throws(() => readPagesConfig({ VITE_API_BASE_URL: api }));
  }
});

test('Pages accepts a root domain or repository subpath and normalizes the trailing slash', () => {
  const env = { VITE_API_BASE_URL: 'https://api.example.com/' };
  assert.deepEqual(readPagesConfig(env), { apiBase: 'https://api.example.com', base: '/' });
  assert.equal(readPagesConfig({ ...env, VITE_BASE_PATH: '/OG.Listener' }).base, '/OG.Listener/');
  assert.equal(readPagesConfig({ ...env, VITE_BASE_PATH: '/OG.Listener/' }).base, '/OG.Listener/');
});

test('Pages rejects host overrides, traversal, fragments and malformed base paths', () => {
  const env = { VITE_API_BASE_URL: 'https://api.example.com' };
  for (const base of ['https://other.example', '//other.example/', '/repo/../', '/%2e%2e/', '/repo/%2f/', '/repo/%5c/', '/repo/?x=1', '/repo/#/upload', '/repo/%00/', '/repo/%', '/repo name/']) {
    assert.throws(() => readPagesConfig({ ...env, VITE_BASE_PATH: base }), base);
  }
});
