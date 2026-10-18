/**
 * Versão do `@usebridger/plugin-dashboard`, exibida no rodapé do app. Constante (e não lida do
 * `package.json` em runtime) para valer igual no fonte e no bundle. Não edite à mão: o
 * `pnpm version-packages` a reescreve (`packages/core/scripts/sync-version.ts`) e o
 * `version.test.ts` falha se divergir do `package.json`.
 */
export const DASHBOARD_VERSION = '0.2.0';
