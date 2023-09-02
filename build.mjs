// build.mjs
import esbuild from 'esbuild';
import inlineWorker from 'esbuild-plugin-inline-worker';
import { htmlPlugin as html } from '@craftamap/esbuild-plugin-html';

const buildOptions = {
  entryPoints: ['src/ui.tsx'],
  bundle: true,
  platform: 'browser',
  target: 'es2020',
  sourcemap: true,
  metafile: true,
  logLevel: 'debug',
  outdir: 'dist/ui',
  tsconfig: 'tsconfig.web.json',
  loader: {
    '.svg': 'file',
  },
  define: {
    IS_WEB: process.env.IS_WEB ?? '0',
  },
  plugins: [ inlineWorker(),
    html({ 
      files: [{
        entryPoints: [ 'src/ui.tsx'],
        filename: 'index.html',
        htmlTemplate: 'src/index.html',
        scriptLoading: 'defer',
      }]
    })
  ],
  resolveExtensions: ['.js', '.ts', '.tsx', '.svg', '.worker.js'],
};

(async () => {
  try {
    await esbuild.build(buildOptions);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();

