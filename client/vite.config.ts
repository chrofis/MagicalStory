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
              // React core — KEEP REACT, REACT-DOM, SCHEDULER, AND REACT-ROUTER IN ONE CHUNK.
              // React 19 + Rollup chunk-splitting: separating react / react-dom / scheduler
              // creates a circular-init order where vendor-other (anything that imports
              // React.forwardRef at module top level) runs before React has finished
              // evaluating, throwing "Cannot read properties of undefined (reading
              // 'forwardRef')". One atomic React chunk avoids the problem.
              if (
                id.includes('node_modules/react/') ||
                id.includes('node_modules/react-dom/') ||
                id.includes('node_modules/react-router') ||
                id.includes('node_modules/scheduler/') ||
                id.includes('node_modules/use-sync-external-store/')
              ) {
                return 'vendor-react';
              }
              // Firebase (large)
              if (id.includes('node_modules/firebase') || id.includes('node_modules/@firebase')) {
                return 'vendor-firebase';
              }
              // Icons (lucide-react is large)
              if (id.includes('node_modules/lucide-react')) {
                return 'vendor-icons';
              }
              // PDF generation
              if (id.includes('node_modules/html2pdf') || id.includes('node_modules/jspdf') || id.includes('node_modules/html2canvas')) {
                return 'vendor-pdf';
              }
              // Other node_modules
              if (id.includes('node_modules')) {
                return 'vendor-other';
              }
            },
          },
    },
  },
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
      '/images': {
        target: 'http://localhost:3000',
        changeOrigin: true,
      },
    },
  },
  };
});
