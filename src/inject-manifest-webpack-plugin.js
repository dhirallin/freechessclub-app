const workboxBuild = require('workbox-build');

class InjectManifestPlugin {
    apply(compiler) {
        compiler.hooks.beforeRun.tapAsync('InjectManifestPlugin', (compiler, callback) => {
            workboxBuild.injectManifest({
                swSrc: __dirname + '/service-worker.js',
                swDest: './service-worker.js',
                globDirectory: process.cwd(),
                globPatterns: [
                    'play.html',
                    'assets/**/*.{html,js,css,png,jpg,svg,json,bin,tsv,ico}'
                ],
            })
            .then(() => {
              callback();
            })
            .catch((error) => {
              console.error('Error generating service worker:', error);
              callback(error);
           });
        })                
    }
}

module.exports = InjectManifestPlugin;