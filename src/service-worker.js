import { precacheAndRoute, matchPrecache, cleanupOutdatedCaches } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { NetworkFirst } from 'workbox-strategies';

// pre-cache external resources
const externals = [
  {"url":"https://maxcdn.bootstrapcdn.com/font-awesome/4.7.0/css/font-awesome.min.css", "revision":"1"},
  {"url":"https://maxcdn.bootstrapcdn.com/font-awesome/4.7.0/fonts/fontawesome-webfont.woff2?v=4.7.0", "revision":"1"},
  {"url":"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.3.0/css/all.min.css", "revision":"1"},
  {"url":"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.3.0/webfonts/fa-solid-900.woff2", "revision":"1"},
  {"url":"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.3.0/webfonts/fa-regular-400.woff2", "revision":"1"},
  {"url":"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.3.0/webfonts/fa-brands-400.woff2", "revision":"1"},
  {"url":"https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/css/bootstrap.min.css", "revision":"1"},
  {"url":"https://fonts.googleapis.com/css2?family=Noto+Sans+Math&family=Noto+Sans+Symbols+2&display=swap", "revision":"1"},
  {"url":"https://code.jquery.com/jquery-3.7.0.slim.min.js", "revision":"1"},
  {"url":"https://cdn.jsdelivr.net/npm/@popperjs/core@2.11.6/dist/umd/popper.min.js", "revision":"1"},
  {"url":"https://cdn.jsdelivr.net/npm/bootstrap@5.2.3/dist/js/bootstrap.min.js", "revision":"1"},
  {"url":"https://cdn.jsdelivr.net/npm/d3@7.8.0/dist/d3.min.js", "revision":"1"},
  {"url":"https://fonts.gstatic.com/s/notosanssymbols2/v24/I_uyMoGduATTei9eI8daxVHDyfisHr71-vrgfE71.woff2","revision":"1"},
  {"url":"https://fonts.gstatic.com/s/notosansmath/v15/7Aump_cpkSecTWaHRlH2hyV5UEl981w.woff2","revision":"1"},
];

cleanupOutdatedCaches();

const urlParams = new URLSearchParams(self.location.search);
if(urlParams.get('env') === 'app') // Capacitor or Electron app, don't cache static assets or use network first strategy
  precacheAndRoute(externals);
else {
  // Use network first strategy for html, css and *.bundle.js, so the latest version is always fetched
  // even before the service-worker is updated
  const networkFirst = new NetworkFirst({
    cacheName: 'network-first-runtime-cache',
    plugins: [{
      cacheWillUpdate: async ({ response }) => {
        return response && response.status === 200 ? response : null;
      },
    }],
  });

  registerRoute(
    ({ request }) => request.destination === 'document' || request.destination === 'style'
        || (request.destination === 'script' && request.url.endsWith('bundle.js')),
    async (options) => {
      let response;
      try { response = await networkFirst.handle(options); }
      catch(error) {}

      if(!response) {
        // If both network and runtime cache fail, retrieve the file from the precache
        const precacheResponse = await matchPrecache(options.request.url);
        if(precacheResponse) 
          return precacheResponse;
      }

      return response || Response.error();
    }
  );

  // __WB_MANIFEST is injected by inject-manifest.js
  precacheAndRoute([...self.__WB_MANIFEST, ...externals]);
}

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim()); 
});

