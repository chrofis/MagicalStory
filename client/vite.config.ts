import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  build: {
    outDir: '../dist',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // React core
          if (id.includes('node_modules/react-dom')) {
            return 'vendor-react-dom';
          }
          if (id.includes('node_modules/react/') || id.includes('node_modules/react-router')) {
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
});
