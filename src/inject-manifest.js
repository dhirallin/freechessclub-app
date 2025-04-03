const workboxBuild = require("workbox-build");

workboxBuild.injectManifest({
  swSrc: "./service-worker.js",
  swDest: "./service-worker.js",
  globDirectory: process.cwd(),
  globPatterns: [
    "*.html",
    "assets/**/*.{html,js,css,png,jpg,svg,json,bin,tsv,ico}",
  ],
});
