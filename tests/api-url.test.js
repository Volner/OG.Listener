import test from 'node:test';
import assert from 'node:assert/strict';
import { apiUrl, normalizeApiBase } from '../src/lib/api-url.js';

test('API base accepts only an HTTPS origin and normalizes its optional trailing slash', () => {
  assert.equal(normalizeApiBase(), '');
  assert.equal(normalizeApiBase('  https://API.example.test:443/  '), 'https://api.example.test');
  assert.equal(normalizeApiBase('https://api.example.test:8443'), 'https://api.example.test:8443');
  for (const value of [
    'http://api.example.test', '//api.example.test', 'file:///tmp/api', 'not a URL',
    'https://user:password@api.example.test', 'https://@api.example.test',
    'https://api.example.test/api', 'https://api.example.test/.', 'https://api.example.test/%2e',
    'https://api.example.test?key=value', 'https://api.example.test?', 'https://api.example.test#',
    'https://api.example.test\\evil.test', 'https://api.\nexample.test',
  ]) assert.throws(() => normalizeApiBase(value), TypeError, value);
  assert.throws(() => normalizeApiBase({ origin: 'https://api.example.test' }), TypeError);
});

test('HTTP loopback requires an explicit development or test permission', () => {
  for (const value of ['http://localhost:3000', 'http://127.0.0.1:3000', 'http://127.0.0.2:3000', 'http://[::1]:3000']) {
    assert.throws(() => normalizeApiBase(value), /HTTPS/);
    assert.equal(normalizeApiBase(value, { allowLoopbackHttp: true }), new URL(value).origin);
  }
  for (const value of ['http://api.example.test', 'http://localhost.evil.test', 'http://192.168.1.1']) {
    assert.throws(() => normalizeApiBase(value, { allowLoopbackHttp: true }), /HTTPS/);
  }
});

test('API routes use the separately hosted origin and keep opaque track IDs intact', () => {
  const id = 'local:Artist / Song % title Песня';
  const path = `/api/tracks/${encodeURIComponent(id)}?${new URLSearchParams({ title: 'Song / 100%', full: 'true' })}`;
  assert.equal(apiUrl(path), path);
  assert.equal(apiUrl(path, 'https://api.example.test/'), `https://api.example.test${path}`);
  assert.equal(new URL(apiUrl(path, 'https://api.example.test')).origin, 'https://api.example.test');
  assert.equal(apiUrl('/api/catalog/resolve', 'https://api.example.test'), 'https://api.example.test/api/catalog/resolve');
  assert.equal(apiUrl('/api/audience/resolve', 'https://api.example.test'), 'https://api.example.test/api/audience/resolve');
});

test('API routes cannot replace the origin, escape /api, or introduce raw URL fragments', () => {
  for (const path of [
    'https://evil.test/api/tracks', '//evil.test/api/tracks', '/other/api', 'api/tracks',
    '/api/../other', '/api/%2e%2e/other', '/api/./tracks', '/api/\\evil.test',
    '/api/tracks#fragment', '/api/tracks with spaces', '/api/%broken',
  ]) assert.throws(() => apiUrl(path, 'https://api.example.test'), TypeError, path);
});
