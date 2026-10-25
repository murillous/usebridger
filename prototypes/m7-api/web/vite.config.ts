import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  plugins: [react()],
  server: { port: 15173, proxy: { '/api': { target: 'http://localhost:18787', rewrite: (p) => p.replace(/^\/api/, '') } } },
});
