const assert = require('node:assert/strict');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { test } = require('node:test');
const vm = require('node:vm');

const source = readFileSync(join(__dirname, '..', 'sw.js'), 'utf8');
const origin = 'https://practice.example';

function worker() {
  const handlers = new Map(), stores = new Map();
  let offline = false, cacheWriteError = false;
  const key = request => new URL(typeof request === 'string' ? request : request.url, `${origin}/`).href;
  const fetch = async request => {
    if (offline) throw new TypeError('Network unavailable');
    return new Response(key(request).endsWith('.js') ? 'console.log("fresh")' : '<h1>Fresh app</h1>');
  };
  const caches = {
    async keys() { return [...stores.keys()]; },
    async delete(name) { return stores.delete(name); },
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(requests) { for (const request of requests) entries.set(key(request), await fetch(request)); },
        async match(request) { return entries.get(key(request))?.clone(); },
        async put(request, response) {
          if (cacheWriteError) throw new Error('Cache quota exceeded');
          entries.set(key(request), response.clone());
        },
      };
    },
    async match(request) {
      for (const entries of stores.values()) if (entries.has(key(request))) return entries.get(key(request)).clone();
    },
  };
  vm.runInNewContext(source, {
    caches, fetch, URL,
    self: {
      location: { origin },
      clients: { async claim() {} },
      async skipWaiting() {},
      addEventListener: (event, fn) => handlers.set(event, fn),
    },
  });
  return {
    caches,
    offline() { offline = true; },
    blockCacheWrites() { cacheWriteError = true; },
    async lifecycle(name) {
      const pending = [];
      handlers.get(name)({ waitUntil: promise => pending.push(promise) });
      await Promise.all(pending);
    },
    async request(path, { method = 'GET', mode = 'cors' } = {}) {
      const pending = [];
      let response;
      handlers.get('fetch')({
        request: { url: key(path), method, mode },
        waitUntil: promise => pending.push(promise),
        respondWith: promise => { response = promise; },
      });
      const result = await response;
      await Promise.all(pending);
      return result;
    },
  };
}

test('activation deletes only old Shruti Box caches on a shared origin', async () => {
  const w = worker();
  await w.caches.open('other-app-cache');
  await w.caches.open('shrutibox-v1');
  await w.lifecycle('install');
  await w.lifecycle('activate');
  const names = await w.caches.keys();
  assert.equal(names.includes('other-app-cache'), true);
  assert.equal(names.includes('shrutibox-v1'), false);
  assert.equal(names.length, 2);
});

test('offline navigation can open the cached application shell', async () => {
  const w = worker();
  await w.lifecycle('install');
  w.offline();
  assert.match(await (await w.request('./index.html?practice=1', { mode: 'navigate' })).text(), /Fresh app/);
});

test('offline missing scripts never receive HTML from the navigation fallback', async () => {
  const w = worker();
  await w.lifecycle('install');
  w.offline();
  await assert.rejects(w.request('./missing-script.js'), /Network unavailable/);
});

test('online navigation refreshes a stale cached application', async () => {
  const w = worker();
  await w.lifecycle('install');
  const [name] = await w.caches.keys();
  const cache = await w.caches.open(name);
  await cache.put('./index.html', new Response('<h1>Stale app</h1>'));
  assert.match(await (await w.request('./index.html', { mode: 'navigate' })).text(), /Fresh app/);
  assert.match(await (await cache.match('./index.html')).text(), /Fresh app/);
});

test('non-GET and external requests retain normal browser network behavior', async () => {
  const w = worker();
  assert.equal(await w.request('./submit', { method: 'POST' }), undefined);
  assert.equal(await w.request('https://fonts.example/style.css'), undefined);
});

test('a failed runtime cache write still returns the network response', async () => {
  const w = worker();
  await w.lifecycle('install');
  w.blockCacheWrites();
  assert.match(await (await w.request('./new-script.js')).text(), /fresh/);
});
