// build.mjs
import esbuild from 'esbuild';
import inlineWorkerPlugin from 'esbuild-plugin-inline-worker';
import svgPlugin from 'esbuild-plugin-svg'

const buildOptions = {
  entryPoints: ['src/ui.tsx'], // Entry point
  bundle: true,
  platform: 'browser', // Specify the platform
  target: 'es2020', // Specify the target environment
  outfile: 'dist/ui/main.js', // Output file
  tsconfig: 'tsconfig.web.json', // TypeScript config file
  jsxFactory: 'React.createElement', // Specify the JSX factory function
  jsxFragment: 'React.Fragment', // Specify the JSX fragment component
  sourcemap: true, // Generate source maps
  define: {
    IS_WEB: '0', // Define IS_WEB as 0
  },
  plugins: [inlineWorkerPlugin(), svgPlugin()], // Add the inline worker plugin
  resolveExtensions: ['.js', '.ts', '.tsx', '.json', '.svg', '.worker.js'], // Specify how to resolve extensions
};

(async () => {
  try {
    await esbuild.build(buildOptions);
  } catch (error) {
    console.error(error);
    process.exit(1);
  }
})();

