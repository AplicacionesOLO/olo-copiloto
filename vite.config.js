import { defineConfig } from 'vite';

// En desarrollo Vite sirve la interfaz en :5173 y manda todo lo que empiece con
// /api al servidor Express de :3001. En producción Express sirve dist/ y las
// rutas /api desde el mismo puerto, así que no hace falta ningún proxy.
export default defineConfig({
  server: {
    port: 5173,
    proxy: {
      '/api': {
        target: 'http://localhost:3001',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
