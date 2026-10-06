import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { visualizer } from 'rollup-plugin-visualizer';
import path from 'path';

// https://vitejs.dev/config/
export default ({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  // console.log('Loaded environment variables:', env.VITE_FRONTEND_URL, env.VITE_FRONTEND_PORT, env.VITE_BACKEND_URL, env.VITE_WS_URL);

  return defineConfig({
    base: '/',
    plugins: [
      visualizer({ open: env.VITE_DEBUG !== '0', gzipSize: true }),
      react({
        jsxImportSource: 'react',
      }),
    ],
    build: {
      // No explicit target: Vite's default ('baseline-widely-available')
      // avoids down-levelling syntax that every supported browser already has.
      minify: 'oxc',
      sourcemap: env.VITE_DEBUG === '1' ? 'inline' : false,
      cssCodeSplit: true,
      rolldownOptions: {
        treeshake: {
          // Keep side effects for i18n bootstrap modules; everything else remains aggressively tree-shaken.
          moduleSideEffects: (id) => {
            return (
              /src[\\/]i18n\.(jsx|tsx|js|ts)$/.test(id) ||
              /node_modules[\\/](i18next|react-i18next|i18next-http-backend|i18next-browser-languagedetector)/.test(
                id,
              )
            );
          },
          propertyReadSideEffects: false,
          unknownGlobalSideEffects: false,
        },
        output: {
          comments: { legal: false },
          codeSplitting: {
            groups: [
              // Long-lived, cacheable chunks for the core libraries.
              {
                name: 'vendor-react',
                test: /node_modules[\\/](react|react-dom|react-router|scheduler)[\\/]/,
                priority: 30,
              },
              {
                name: 'vendor-mui',
                test: /node_modules[\\/](@mui|@emotion)[\\/]/,
                priority: 20,
              },
              {
                name: 'vendor-i18n',
                test: /node_modules[\\/](i18next|react-i18next|i18next-[^\\/]+)[\\/]/,
                priority: 20,
              },
              {
                name: 'vendor-network',
                test: /node_modules[\\/](axios|jwt-decode)[\\/]/,
                priority: 20,
              },
              // Heavy libraries only some (lazy) routes need: one shared chunk
              // each, loaded on demand instead of with the first page.
              {
                name: 'vendor-plotly',
                test: /node_modules[\\/](plotly\.js|react-plotly\.js)[\\/]|src[\\/]plotly\.ts$/,
                priority: 20,
              },
              {
                name: 'vendor-leaflet',
                test: /node_modules[\\/](leaflet|react-leaflet|@react-leaflet)[\\/]/,
                priority: 20,
              },
              // Everything else the first page needs. Libraries used only by
              // lazy routes are left to rolldown's automatic splitting.
              {
                name: 'vendor',
                test: /node_modules/,
                tags: ['$initial'],
                priority: 10,
              },
            ],
          },
        },
      },
      reportCompressedSize: true,
      chunkSizeWarningLimit: 1000,
      assetsInlineLimit: 4096,
      modulePreload: { polyfill: false },
    },
    optimizeDeps: {
      include: [
        'react',
        'react-dom',
        'react-use-websocket',
        'react-data-table-component',
      ], // Add frequently used deps
    },
    define: {
      __APP_ENV__: JSON.stringify(env.APP_ENV),
      // Plotly's source modules reference Node's `global` (its prebuilt bundle defines it the same way).
      global: 'globalThis',
    },
    server: {
      host: env.VITE_FRONTEND_URL || '0.0.0.0',
      port: env.VITE_FRONTEND_PORT
        ? parseInt(env.VITE_FRONTEND_PORT, 10)
        : 3000,
    },
    resolve: {
      alias: [
        // react-plotly.js imports the full Plotly bundle; use our slim one (src/plotly.ts).
        {
          find: /^plotly\.js\/dist\/plotly$/,
          replacement: path.resolve(import.meta.dirname, 'src/plotly.ts'),
        },
        {
          find: /^maplibre-gl\/dist\/maplibre-gl\.css$/,
          replacement: path.resolve(import.meta.dirname, 'src/plotly-no-maplibre.css'),
        },
        // Plotly's source modules expect Node's Buffer; use the browser polyfill.
        { find: /^buffer$/, replacement: 'buffer/' },
        { find: '@', replacement:path.resolve(import.meta.dirname, 'src') },
        {
          find: /^~(.*)$/,
          replacement: '$1',
        },
      ],
    },
  });
};
