import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// `isSsrBuild` is true when running `vite build --ssr`. We disable manualChunks
// during the SSR build because Rollup marks node_modules as external in SSR mode,
// and you can't put externals into chunks.
export default defineConfig((env) => {
  const isSsrBuild = !!env.isSsrBuild;
  return {
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    // Emit manifest.json so the prerender script can resolve hashed asset filenames
    // when injecting <script> and <link rel="stylesheet"> into pre-rendered HTML.
    manifest: !isSsrBuild,
    rollupOptions: {
      input: isSsrBuild ? undefined : 'index.html',
      output: isSsrBuild
        ? undefined
        : {
            manualChunks(id) {
              // Big standalone libraries that don't talk to React → own chunks.
              if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) {
                return 'vendor-firebase';
              }
              if (id.includes('node_modules/lucide-react')) {
                return 'vendor-icons';
              }
              if (id.includes('node_modules/html2pdf') || id.includes('node_modules/jspdf') || id.includes('node_modules/html2canvas')) {
                return 'vendor-pdf';
              }

              // EVERYTHING ELSE from node_modules goes into one vendor-react chunk.
              //
              // Why a single chunk for React + every React-using library:
              //   Splitting vendor-react and vendor-other causes a circular import
              //   between them — React Router pulls helpers that live in vendor-other,
              //   vendor-other pulls React from vendor-react. Whichever chunk evaluates
              //   first sees `undefined` for the cyclic binding and crashes with
              //   "Cannot read properties of undefined (reading 'forwardRef')" the
              //   moment a library like @marsidev/react-turnstile calls
              //   `React.forwardRef(...)` at module init.
              //
              //   React 18 happened to mask the cycle; React 19's module structure
              //   exposes it. Bundling everything React-adjacent into one chunk
              //   eliminates the cycle by construction.
              if (id.includes('node_modules')) {
                return 'vendor-react';
              }
            },
          },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: process.env.DEV_API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
      '/images': {
        target: process.env.DEV_API_TARGET || 'http://localhost:3000',
        changeOrigin: true,
        secure: false,
      },
    },
  },
  };
});
