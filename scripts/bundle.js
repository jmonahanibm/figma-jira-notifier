'use strict';

/**
 * Builds the GUI into gui/dist/ — the one folder that the Express server, the
 * pkg binary and GitHub Pages all serve.
 *
 *   gui/app.js  (+ ./adapters, ../src/pipeline, differ, adf, figmaLinks)
 *       -> gui/dist/app.bundle.js     (esbuild, browser IIFE)
 *   gui/index.html, gui/style.css
 *       -> copied to gui/dist/
 */

const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');

const guiDir = path.join(__dirname, '..', 'gui');
const distDir = path.join(guiDir, 'dist');

async function main() {
  fs.rmSync(distDir, { recursive: true, force: true });
  fs.mkdirSync(distDir, { recursive: true });

  await esbuild.build({
    entryPoints: [path.join(guiDir, 'app.js')],
    outfile: path.join(distDir, 'app.bundle.js'),
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: ['es2020'],
    logLevel: 'info'
  });

  for (const file of ['index.html', 'style.css']) {
    fs.copyFileSync(path.join(guiDir, file), path.join(distDir, file));
  }
}

main().catch(err => {
  console.error(err);
  process.exit(1);
});
