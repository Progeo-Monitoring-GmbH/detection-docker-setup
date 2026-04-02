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
      },
      reportCompressedSize: true,
      chunkSizeWarningLimit: 1000,
      assetsInlineLimit: 4096,
      modulePreload: { polyfill: false },
    },
    optimizeDeps: {
      include: ['react', 'react-dom'], // Add frequently used deps
    },
    define: {
      __APP_ENV__: JSON.stringify(env.APP_ENV),
    },
    server: {
      host: env.VITE_FRONTEND_URL || '0.0.0.0',
      port: env.VITE_FRONTEND_PORT ? parseInt(env.VITE_FRONTEND_PORT, 10) : 3000,
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
