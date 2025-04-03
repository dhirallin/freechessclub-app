import { precacheAndRoute } from 'workbox-precaching';
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

// Use network first strategy for html and css files (so we can modify them without having to re-inject the manifest)
registerRoute(
  ({ request }) => request.destination === 'document' || request.destination === 'style',
  new NetworkFirst({
    cacheName: 'html-css-cache',
    plugins: [{
      cacheWillUpdate: async ({ response }) => {
        return response && response.status === 200 ? response : null;
      },
    }],
  })
);

// __WB_MANIFEST is injected by inject-manifest.js
precacheAndRoute([...self.__WB_MANIFEST, ...externals]);

self.addEventListener('install', (event) => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(clients.claim()); 
});

