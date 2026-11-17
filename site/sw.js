/* Offline service worker: precache everything, serve cache-first. */
'use strict';

// BUILD:START (written by tools/build_data.mjs — do not edit by hand)
const VERSION = '7643749bba18';
const PRECACHE = [
  "./",
  "./app.css",
  "./app.js",
  "./data/ordinances.json",
  "./icons/apple-touch-icon.png",
  "./icons/icon-192.png",
  "./icons/icon-512.png",
  "./icons/icon-maskable-512.png",
  "./index.html",
  "./manifest.webmanifest",
  "./search.js",
  "./sw.js"
];
// BUILD:END

const PREFIX = 'wayne-ordinances-';
const CACHE = PREFIX + VERSION;

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE)
      // cache: 'reload' skips the HTTP cache so a new version gets fresh files.
      .then((cache) => cache.addAll(PRECACHE.map((url) => new Request(url, { cache: 'reload' }))))
      .then(() => self.skipWaiting())
  );
});

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys.filter((k) => k.startsWith(PREFIX) && k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener('fetch', (event) => {
  const req = event.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  event.respondWith(
    caches.open(CACHE).then((cache) =>
      cache.match(req, { ignoreSearch: true }).then((hit) => {
        if (hit) return hit;
        if (req.mode === 'navigate') {
          return cache.match('./index.html').then((page) => page || fetch(req));
        }
        return fetch(req);
      })
    )
  );
});
