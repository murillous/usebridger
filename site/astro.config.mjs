import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
import starlightLlmsTxt from 'starlight-llms-txt';
import starlightTypeDoc, { typeDocSidebarGroup } from 'starlight-typedoc';
import { BASE } from './scripts/sync-content.ts';

// Astro só lê a config como `export default` (por isso a exceção no biome.json).
export default defineConfig({
  site: 'https://murillous.github.io',
  base: BASE,
  integrations: [
    starlight({
      title: 'Bridger',
      description: 'Kernel de bot de mensageria: transports, storage e plugins.',
      defaultLocale: 'root',
      locales: {
        root: { label: 'Português', lang: 'pt-BR' },
        en: { label: 'English', lang: 'en' },
      },
      social: [
        { icon: 'github', label: 'GitHub', href: 'https://github.com/murillous/usebridger' },
      ],
      // Link quebrado (rota ou âncora) falha o build.
      plugins: [
        starlightLinksValidator(),
        // Gera /llms.txt, /llms-full.txt e /llms-small.txt. As ADRs (registro histórico) e a API
        // gerada (que inflaria o full) saem do full/small e ficam só como conjuntos à parte listados no índice.
        // O `exclude` valer também para o full depende de patches/ (o plugin só o aplica ao small).
        starlightLlmsTxt({
          projectName: 'Bridger',
          description:
            'Kernel de bot de mensageria em TypeScript: core, transports, storages e plugins.',
          exclude: ['decisoes/**', 'api/**'],
          customSets: [
            {
              label: 'Decisões (ADRs)',
              paths: ['decisoes/**'],
              description: 'registro histórico das decisões de arquitetura',
            },
            {
              label: 'Referência da API',
              paths: ['api/**'],
              description: 'tipos e funções públicas de cada pacote, gerada do código',
            },
          ],
        }),
        // Entradas públicas dos pacotes: o plugin local nomeia cada módulo
        // pelo import público e o treatWarningsAsErrors falha o build se a lista divergir dos exports.
        starlightTypeDoc({
          entryPoints: [
            '../packages/core/src/index.ts',
            '../packages/core/src/adapter.ts',
            '../packages/core/src/storage/contract/index.ts',
            '../packages/core/src/zod.ts',
            '../packages/storage-sqlite/src/index.ts',
            '../packages/storage-postgres/src/index.ts',
            '../packages/transport-baileys/src/index.ts',
            '../packages/transport-web/src/index.ts',
            '../packages/transport-web/src/client.ts',
            '../packages/testing/src/index.ts',
            '../packages/testing/src/bot.ts',
          ],
          tsconfig: './tsconfig.typedoc.json',
          output: 'api',
          typeDoc: {
            entryPointStrategy: 'resolve',
            plugin: ['./module-names.js'],
            readme: 'none',
            // Starlight só trata `index` como índice da pasta; com o `README` padrão os links quebram.
            entryFileName: 'index',
            treatWarningsAsErrors: true,
            // O zod reexportado em core/zod não é nosso: sem isso o TypeDoc expande milhares de páginas.
            excludeExternals: true,
            externalPattern: ['**/node_modules/**'],
            // Uma página por entrada pública, com os símbolos como seções: uma por símbolo dava
            // ~350 páginas e uma sidebar ilegível; a busca acha o símbolo dentro da página.
            outputFileStrategy: 'modules',
            // Com tudo numa página, nomes repetidos ganham sufixo (`#botconfig-1`) que o slug do
            // Starlight não reproduz; âncoras HTML explícitas mantêm os links do TypeDoc válidos.
            useHTMLAnchors: true,
          },
        }),
      ],
      // Páginas sincronizadas trazem `editUrl` próprio apontando para o Markdown de origem; esta
      // base vale só para as escritas à mão em site/. Edita-se na develop: os PRs vão para ela
      // (ADR 0085), e a main só recebe o release.
      editLink: { baseUrl: 'https://github.com/murillous/usebridger/edit/develop/site/' },
      sidebar: [
        { label: 'Começando', items: [{ autogenerate: { directory: 'comecando' } }] },
        { label: 'Guias', items: [{ autogenerate: { directory: 'guias' } }] },
        {
          label: 'Referência',
          items: [
            { autogenerate: { directory: 'pacotes', collapsed: true } },
            { ...typeDocSidebarGroup, label: 'API', collapsed: true },
          ],
        },
        {
          label: 'Decisões',
          collapsed: true,
          items: [{ autogenerate: { directory: 'decisoes' } }],
        },
        { label: 'Contribuindo', items: [{ autogenerate: { directory: 'contribuindo' } }] },
      ],
    }),
  ],
});
