/* eslint-env node */
import { context } from 'esbuild';
import inlineWorker from 'esbuild-plugin-inline-worker';
import { htmlPlugin as html } from '@craftamap/esbuild-plugin-html';

const buildOptions = {
  entryPoints: ['src/ui.tsx', 'src/background-planner.ts'],
  bundle: true,
  platform: 'browser',
  target: 'es2022',
  minify: true,
  sourcemap: true,
  metafile: true,
  logLevel: 'debug',
  outdir: 'dist/ui',
  tsconfig: 'tsconfig.web.json',
  loader: { '.svg': 'file' },
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
  resolveExtensions: ['.mjs', '.js', '.ts', '.tsx', '.svg'],
};

(async() => {
  try {
    let ctx;
    if (process.env.BUILD_MODE === 'development') {
      // enables live-reloading
      ctx = await context({
        ...buildOptions,
        banner: { js: "new EventSource('/esbuild').addEventListener('change', () => location.reload());" }
      });
      await ctx.watch();
    } else {
      ctx = await context(buildOptions);
    }
    await ctx.serve({ servedir: 'dist/ui', port: 9080 });
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();

