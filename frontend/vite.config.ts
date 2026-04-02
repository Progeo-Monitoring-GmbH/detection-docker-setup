import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import path from 'path';

// https://vitejs.dev/config/
export default ({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');

  return defineConfig({
    base: '/',
    plugins: [
      visualizer({ open: env.VITE_DEBUG !== '0' }),
      react({
        jsxImportSource: 'react',
      }),
    ],
    build: {
      target: 'es2020', // Adjust according to desired browser support
      minify: 'esbuild', // esbuild is fast and generally good enough
      sourcemap: !env.VITE_DEBUG ? 'inline' : false,
      cssCodeSplit: true,
      rollupOptions: {
        treeshake: {
          preset: 'recommended',
          moduleSideEffects: false, // assumes your deps mark sideEffects correctly
          propertyReadSideEffects: false,
          tryCatchDeoptimization: false,
          unknownGlobalSideEffects: false,
        },

        // output: {
        //   // Consistent hashed filenames
        //   entryFileNames: 'assets/entry-[name]-[hash].js',
        //   chunkFileNames: 'assets/chunk-[name]-[hash].js',
        //   assetFileNames: 'assets/[name]-[hash][extname]',
        //
        //   // Fine-grained, cache-friendly chunking strategy
        //   manualChunks(id) {
        //     // Big frameworks into their own long-lived chunks
        //     if (id.includes('node_modules')) {
        //       // Common UI libs
        //       if (
        //         /[\\/]@mui[\\/]|[\\/]antd[\\/]|[\\/]chakra-ui[\\/]/.test(id)
        //       ) {
        //         return 'ui-vendor';
        //       }
        //
        //       // Heavy data/graph libs
        //       if (/[\\/]d3[\\/]/.test(id)) {
        //         return 'd3-vendor';
        //       }
        //       if (/[\\/]three[\\/]/.test(id)) {
        //         return 'three-vendor';
        //       }
        //
        //       // Fallback: put the rest of node_modules into one vendor chunk
        //       return 'vendor';
        //     }
        //
        //     if (id.includes('/src/pages/')) {
        //       const m = id.split('/src/pages/')[1]?.split('/')[0];
        //       if (m) {
        //         return `page-${m}`;
        //       }
        //     }
        //   },
        // },
      },
      reportCompressedSize: true,
      chunkSizeWarningLimit: 1000,
      assetsInlineLimit: 4096,
      modulePreload: { polyfill: false },
    },
    optimizeDeps: {
      include: ['react', 'react-dom'], // Add frequently used deps
      // exclude: [
      //   'plotly.js',
      //   'plotly.js-dist',
      //   'plotly.js-dist-min',
      //   'react-plotly.js',
      // ],
    },
    define: {
      __APP_ENV__: JSON.stringify(env.APP_ENV),
    },
    server: {
      host: env.VITE_HOST || '0.0.0.0',
      port: env.VITE_PORT ? parseInt(env.VITE_PORT, 10) : 3000,
    },
    resolve: {
      alias: [
        { find: '@', replacement: path.resolve(__dirname, 'src') },
        {
          find: /^~(.*)$/,
          replacement: '$1',
        },
      ],
    },
  });
};
