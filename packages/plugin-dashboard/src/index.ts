import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { definePlugin, type PluginDefinition } from '@usebridger/core';
import { createStaticHandler } from '#static.ts';
import { DASHBOARD_VERSION } from '#version.ts';

// No pacote publicado o app fica em `dist/web`, ao lado do bundle; no fonte (`src/`), um nível acima.
const WEB_DIR = fileURLToPath(
  new URL(
    existsSync(new URL('./web/', import.meta.url)) ? './web/' : '../dist/web/',
    import.meta.url,
  ),
);

/**
 * Plugin oficial `dashboard` (ADR 0103, 0125): só serve o app web, cliente genérico da API do core.
 * Sem rota de dados, auth ou config próprias: tudo passa pela API, com a auth e as permissões dela.
 */
export const dashboard: PluginDefinition = definePlugin({
  name: 'dashboard',
  version: DASHBOARD_VERSION,
  engine: '<1.0.0',
  setup(ctx) {
    // Sem auth: são só estáticos. Os dados vêm da API, que recusa quem não pode.
    const serveApp = createStaticHandler(WEB_DIR, ctx.http.basePath);
    ctx.http.route('GET', '/', serveApp);
    ctx.http.route('GET', '/*', serveApp);
  },
});
