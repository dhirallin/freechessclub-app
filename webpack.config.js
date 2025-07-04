const webpack = require('webpack');
const { exec } = require('child_process');
const path = require('path');
const HtmlWebpackPlugin = require("html-webpack-plugin");

module.exports = (env, argv) => {
  const isProd = argv.mode === 'production';
  const outputDir = path.resolve(__dirname, 'www');

  const serviceWorker = {
    name: 'service-worker',
    entry: './src/js/service-worker.js',
    target: 'webworker',
    output: {
      filename: 'service-worker.js',
      path: outputDir,
    },
    plugins: [
      {
        apply: (compiler) => {
          compiler.hooks.done.tap('RunAfterBuildPlugin', () => {
            exec(`node "${__dirname}/src/js/inject-manifest.js"`, (err, stdout, stderr) => {
              if (stdout) console.log(stdout);
              if (stderr) console.error(stderr);
            });
          });
        }
      }
    ]
  };

  const bundle = {
    name: 'bundle',
    entry: "./src/js/index.ts",
    output: {
      path: outputDir,
      filename: "assets/js/" + isProd ? "bundle.[contenthash].js" : "bundle.js",
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
        { test: /\.html$/, use: 'raw', exclude: /node_modules/},
        { test: /\.(ttf|eot|svg|woff(2)?)(\?[a-z0-9=&.]+)?$/, use: 'file-loader' },
        { test: /\.m?js/, resolve: { fullySpecified: false } },
        { test: /\.wasm$/, use: "file-loader?name=[name].[ext]" }
      ]
    },
    plugins: [
      new webpack.optimize.AggressiveMergingPlugin(),
      new HtmlWebpackPlugin({
        template: "./src/play.html",
        filename: "play.html",
        inject: "body",
      }),
    ],
    optimization: {
      minimize: true,
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

  return [serviceWorker, bundle];
}
