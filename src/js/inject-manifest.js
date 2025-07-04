const workboxBuild = require("workbox-build");

workboxBuild.injectManifest({
  swSrc: "./www/service-worker.js",
  swDest: "./www/service-worker.js",
  globDirectory: process.cwd(),
  globPatterns: [
    "www/play.html",
    "www/assets/**/*.{html,js,wasm,css,png,jpg,svg,json,bin,tsv,ico}",
  ],
});
