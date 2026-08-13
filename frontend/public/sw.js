const CACHE_NAME = 'transense-shell-v1'
const SHELL_ASSETS = ['/', '/manifest.webmanifest', '/icons/transense-mark.svg', '/logos/Logo-Transense.png', '/fonts/PlusJakartaSans-VariableFont_wght.ttf']

self.addEventListener('install', (event) => {
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(SHELL_ASSETS)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', (event) => {
  event.waitUntil(
    caches.keys().then((keys) => Promise.all(
      keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)),
    )).then(() => self.clients.claim()),
  )
})

self.addEventListener('fetch', (event) => {
  if (event.request.method !== 'GET' || new URL(event.request.url).origin !== self.location.origin) {
    return
  }

  event.respondWith(
    fetch(event.request).then((response) => {
      const responseCopy = response.clone()
      caches.open(CACHE_NAME).then((cache) => cache.put(event.request, responseCopy))
      return response
    }).catch(() => caches.match(event.request).then((cachedResponse) => cachedResponse || caches.match('/'))),
  )
})
