import { precacheAndRoute } from 'workbox-precaching';
import { registerRoute } from 'workbox-routing';
import { CacheFirst, NetworkFirst } from 'workbox-strategies';

externals = [
  {"url":"https://maxcdn.bootstrapcdn.com/font-awesome/4.7.0/fonts/fontawesome-webfont.woff2?v=4.7.0", "revision":"1"},
  {"url":"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.3.0/webfonts/fa-solid-900.woff2", "revision":"1"},
  {"url":"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.3.0/webfonts/fa-regular-400.woff2", "revision":"1"},
  {"url":"https://cdnjs.cloudflare.com/ajax/libs/font-awesome/6.3.0/webfonts/fa-brands-400.woff2", "revision":"1"},
];

// __WB_MANIFEST is injected by inject-manifest.js
precacheAndRoute([...self.__WB_MANIFEST, ...externals]);

/*
// Cache first strategy for images
registerRoute(
  ({ url }) => url.origin === 'https://example.com' && url.pathname.endsWith('.png'),
  new CacheFirst()
);

// Network first strategy for API requests
registerRoute(
  ({ url }) => url.origin === 'https://api.example.com',
  new NetworkFirst()
);
*/