import test from 'node:test';
import assert from 'node:assert/strict';
import { readRoute, routeHref, routeChangeEvents } from '../src/lib/routing.js';

test('Pages navigation stays inside the built base for both upload and library links', () => {
  for (const base of ['/', '/OG.Listener/', '/OG.Listener']) {
    const options = { hashRouting: true, base };
    const directory = base.endsWith('/') ? base : `${base}/`;
    for (const route of ['/', '/upload']) {
      const href = routeHref(route, options);
      assert.equal(href, `${directory}#${route}`);
      const opened = new URL(href, 'https://listener.example.test');
      assert.equal(opened.pathname, directory);
      assert.equal(readRoute(opened, options), route);
      // Refresh sends only the existing static index directory to the host.
      assert.equal(`${opened.origin}${opened.pathname}${opened.search}`, `https://listener.example.test${directory}`);
    }
  }
});

test('Pages reads the hash independently of repository path and supports browser history events', () => {
  assert.equal(readRoute({ pathname: '/repository/', hash: '' }, { hashRouting: true }), '/');
  assert.equal(readRoute({ pathname: '/repository/', hash: '#/upload' }, { hashRouting: true }), '/upload');
  assert.equal(readRoute({ pathname: '/', hash: '#https://evil.test' }, { hashRouting: true }), '/');
  assert.deepEqual(routeChangeEvents({ hashRouting: true }), ['popstate', 'hashchange']);
});

test('Node and development routing preserve the existing root and /upload URLs', () => {
  for (const route of ['/', '/upload']) {
    assert.equal(routeHref(route, { hashRouting: false, base: '/unused/' }), route);
    assert.equal(readRoute({ pathname: route, hash: '#/other' }, { hashRouting: false }), route);
  }
  assert.deepEqual(routeChangeEvents({ hashRouting: false }), ['popstate']);
});

test('Pages links reject offsite routes and invalid application bases', () => {
  for (const route of ['//evil.test', 'https://evil.test', '/unknown', '/upload#evil']) {
    assert.throws(() => routeHref(route, { hashRouting: true, base: '/repository/' }), /route/);
  }
  for (const base of ['https://evil.test/', '//evil.test/', 'relative/', '/repo/../', '/repo?query', '/repo#fragment', '/repo\\path']) {
    assert.throws(() => routeHref('/upload', { hashRouting: true, base }), /base/);
  }
});
