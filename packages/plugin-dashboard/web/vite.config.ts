import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `base: './'` mais o `<base href>` que o plugin injeta ao servir: o app funciona em qualquer
// `basePath` (`/plugins/dashboard` ou `/sessions/<s>/plugins/dashboard`), sem caminho fixo.
export default defineConfig({
  root: import.meta.dirname,
  base: './',
  plugins: [react()],
  // O Biome proíbe `../`; `#web/*` aponta para `web/src/*` (mesmo mapa no tsconfig).
  resolve: { alias: { '#web': `${import.meta.dirname}/src` } },
  build: { outDir: '../dist/web', emptyOutDir: true },
});
