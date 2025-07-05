const webpack = require('webpack');
const { exec } = require('child_process');
const path = require('path');
const HtmlWebpackPlugin = require("html-webpack-plugin");
const CopyWebpackPlugin = require("copy-webpack-plugin");

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';
  const inputDir = 'src';
  const outputDir = 'www';

  const bundle = {
    name: 'bundle',
    entry: path.resolve(__dirname, inputDir, 'js/index.ts'),
    output: {
      path: path.resolve(__dirname, outputDir),
      filename: "assets/js/" + (isProd ? "bundle.[contenthash].js" : "bundle.js"),
      clean: true,
    },
    externals: {
      $: 'jquery',
	    d3: 'd3',
      '@popperjs/core': 'Popper',
      bootstrap: 'Bootstrap'
    },
    resolve: {
      // Add '.ts' and '.tsx' as a resolvable extension.
      fallback: { 'crypto': false, 'fs': false, 'path': require.resolve('path-browserify') },
      extensions: [".webpack.js", ".web.js", ".ts", ".tsx", ".js"]
    },
    module: {
      rules: [
        // all files with a '.ts' or '.tsx' extension will be handled by 'ts-loader'
        { test: /\.tsx?$/, use: "ts-loader" },
        { test: /\.css$/, use: ['style-loader', 'css-loader'] },
        { test: /\.woff(\?v=\d+\.\d+\.\d+)?$/, use: "url-loader?limit=10000&mimetype=application/font-woff" },
        { test: /\.ttf(\?v=\d+\.\d+\.\d+)?$/, use: "url-loader?limit=10000&mimetype=application/octet-stream" },
        { test: /\.eot(\?v=\d+\.\d+\.\d+)?$/, use: "file-loader" },
        { test: /\.svg(\?v=\d+\.\d+\.\d+)?$/, use: "url-loader?limit=10000&mimetype=image/svg+xml" },
        { test: /\.(ttf|eot|svg|woff(2)?)(\?[a-z0-9=&.]+)?$/, use: 'file-loader' },
        { test: /\.m?js/, resolve: { fullySpecified: false } },
        { test: /\.wasm$/, type: "asset/resource", generator: { filename: "assets/js/[name][ext]" } },
      ]
    },
    plugins: [
      new webpack.optimize.AggressiveMergingPlugin(),
      new HtmlWebpackPlugin({
        template: path.resolve(__dirname, inputDir, 'play.html'),
        filename: "play.html",
        inject: "body",
        minify: isProd,
      }), 
      new CopyWebpackPlugin({
        patterns: [
          {
            // copy all static assets
            from: path.resolve(__dirname, inputDir),
            to: path.resolve(__dirname, outputDir),
            globOptions: {
              ignore: [
                inputDir + '/play.html',
                inputDir + '/js/**',
                // inputDir + '/css/application.css',
                // inmputDir + '/css/themes/**'
              ],
            },
          }
        ],
      }),
    ],
    optimization: {
      minimize: isProd,
    },
    experiments: {
      asyncWebAssembly: true,
    },
    devServer: {
      client: {
        progress: true,
      },
      devMiddleware: {
        writeToDisk: true,
      },
      static: {
        directory: outputDir,
      },
      historyApiFallback: {
        rewrites: [
          { from: /^\/play/, to: 'play.html' },
        ],
      },
      compress: true,
      port: 8080,
    }
  };

  const serviceWorker = {
    name: 'service-worker',
    dependencies: ['bundle'],
    stats: 'errors-warnings', 
    entry: path.resolve(__dirname, inputDir, 'js/service-worker.js'),
    target: 'webworker',
    output: {
      filename: 'service-worker.js',
      path: path.resolve(__dirname, outputDir),
    },
    plugins: [
      {
        apply: (compiler) => {
          compiler.hooks.done.tap('RunAfterBuildPlugin', () => {
            exec(`node "${path.resolve(__dirname, 'scripts/inject-sw-manifest.js')}`, (err, stdout, stderr) => {
              if (stdout) console.log(stdout);
              if (stderr) console.error(stderr);
            });
          });
        }
      }
    ]
  };

  return [bundle, serviceWorker];
}
