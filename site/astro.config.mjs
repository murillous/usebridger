import starlight from '@astrojs/starlight';
import { defineConfig } from 'astro/config';
import starlightLinksValidator from 'starlight-links-validator';
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
      plugins: [starlightLinksValidator()],
      // Páginas sincronizadas trazem `editUrl` próprio apontando para o Markdown de origem; esta
      // base vale só para as escritas à mão em site/.
      editLink: { baseUrl: 'https://github.com/murillous/usebridger/edit/main/site/' },
      sidebar: [
        { label: 'Guias', items: [{ autogenerate: { directory: 'guias' } }] },
        {
          label: 'Referência',
          items: [{ autogenerate: { directory: 'pacotes', collapsed: true } }],
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
