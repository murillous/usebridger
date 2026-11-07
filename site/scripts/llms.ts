// Conjuntos do llms.txt por pacote e por tópico (issue #326). O `starlight-llms-txt` gera o índice,
// o full e o small, mas o `customSets` dele não deixa um conjunto apontar para os relacionados: os
// conjuntos daqui saem por rota própria (src/pages/llms/[...set].txt.ts), e o índice entra no
// `details` do plugin (astro.config.mjs).

/** Link extra de um conjunto, relativo à raiz do site (sem barra inicial). */
export interface LlmsLink {
  readonly label: string;
  readonly path: string;
  readonly description?: string;
}

export interface LlmsSet {
  /** `pacotes/<pasta>` ou `topicos/<nome>`; vira a URL `llms/<id>.txt`. */
  readonly id: string;
  readonly title: string;
  /** Uma linha: vai no índice e no topo do conjunto. */
  readonly description: string;
  /** Ids de página do site, na ordem de leitura; `pasta/**` pega a pasta toda. */
  readonly pages: readonly string[];
  /** Ids dos conjuntos para ler junto. */
  readonly related: readonly string[];
  readonly links?: readonly LlmsLink[];
}

const SPEC: LlmsLink = {
  label: 'Spec OpenAPI do core (JSON)',
  path: 'openapi.json',
  description: 'rotas, schemas, permissões (`x-permission`) e erros da API HTTP do core',
};

/** Referência da API (TypeDoc) de uma entrada pública, no `.md` da página. */
function apiRef(label: string, id: string): LlmsLink {
  return { label: `Referência da API: ${label}`, path: `api/usebridger/${id}.md` };
}

export const TOPICS: readonly LlmsSet[] = [
  {
    id: 'topicos/primeiro-bot',
    title: 'Primeiro bot',
    description: 'instalar, montar o `createBot` com transport, storage e plugins, parear e rodar',
    pages: [
      'comecando/o-que-e',
      'comecando/primeiro-bot',
      'conceitos/visao-geral',
      'conceitos/bot-e-sessao',
      'conceitos/mensagem',
      'pacotes/core/overview',
      'pacotes/core/bot',
      'conceitos/perguntas',
    ],
    related: ['topicos/plugin', 'topicos/config', 'topicos/producao', 'pacotes/transport-baileys'],
  },
  {
    id: 'topicos/plugin',
    title: 'Escrever um plugin',
    description:
      'manifesto, `setup`, eventos, mídia, services, scheduler, capabilities e o `create-bridger-plugin`',
    pages: [
      'comecando/primeiro-plugin',
      'guias',
      'guias/primeiro-plugin',
      'conceitos/plugins',
      'conceitos/distribuicao',
      'pacotes/core/plugins',
      'guias/eventos-e-midia',
      'pacotes/core/events',
      'guias/services',
      'pacotes/core/services',
      'guias/scheduler',
      'pacotes/core/scheduler',
      'guias/capabilities',
      'guias/portabilidade',
      'pacotes/core/actions',
      'guias/escape-hatch',
      'pacotes/core/unsafe',
      'pacotes/create-plugin/**',
    ],
    related: ['topicos/comandos', 'topicos/config', 'topicos/storage', 'topicos/testes'],
    links: [apiRef('@usebridger/core', 'core')],
  },
  {
    id: 'topicos/comandos',
    title: 'Comandos e conversas',
    description: '`command()`, args, papéis, middleware, conversas guiadas e formatação de texto',
    pages: [
      'guias/comandos',
      'pacotes/core/commands',
      'comecando/conversa-guiada',
      'pacotes/core/conversations',
      'pacotes/core/middleware',
      'pacotes/core/message',
      'pacotes/core/text',
      'pacotes/core/inbound-queue',
    ],
    related: ['topicos/plugin', 'topicos/testes', 'topicos/config'],
  },
  {
    id: 'topicos/config',
    title: 'Config e segredos',
    description:
      'schema Zod do plugin, camadas (env > arquivo > segredo > override > default), segredos cifrados e reload',
    pages: [
      'comecando/configuracao',
      'guias/config',
      'conceitos/configuracao',
      'pacotes/core/config',
      'pacotes/core/schemas',
    ],
    related: ['topicos/plugin', 'topicos/api-http', 'topicos/producao'],
  },
  {
    id: 'topicos/storage',
    title: 'Storage',
    description: 'KV e coleções do plugin, contrato do storage, SQLite e Postgres',
    pages: [
      'guias/storage',
      'pacotes/core/storage',
      'pacotes/storage-sqlite/**',
      'pacotes/storage-postgres/**',
    ],
    related: ['topicos/plugin', 'topicos/testes', 'topicos/producao'],
    links: [apiRef('contrato do storage', 'core/storage-contract')],
  },
  {
    id: 'topicos/api-http',
    title: 'API HTTP e painéis',
    description:
      'servidor HTTP, rotas de plugin, a API do core (auth, conexão, SSE, config, logs, auditoria), recursos e como montar um painel',
    pages: ['guias/painel', 'pacotes/core/http', 'pacotes/core/api', 'pacotes/core/audit'],
    related: ['topicos/config', 'topicos/producao', 'pacotes/plugin-metrics'],
    links: [SPEC, { label: 'Spec OpenAPI navegável', path: 'openapi/' }],
  },
  {
    id: 'topicos/testes',
    title: 'Testes',
    description:
      '`@usebridger/testing`, transport falso, perfis de plataforma e matchers do Vitest',
    pages: ['guias/testes', 'conceitos/testes', 'pacotes/testing/**'],
    related: ['topicos/plugin', 'topicos/comandos', 'topicos/storage'],
    links: [apiRef('@usebridger/testing', 'testing')],
  },
  {
    id: 'topicos/producao',
    title: 'Produção e operação',
    description:
      'supervisor, sinais, `/health`, logs estruturados, filas de saída, auditoria, métricas e backup',
    pages: [
      'comecando/producao',
      'conceitos/operacao',
      'pacotes/core/logger',
      'pacotes/core/log-events',
      'pacotes/core/outbound-queue',
      'pacotes/core/audit',
      'pacotes/plugin-metrics/**',
    ],
    related: ['topicos/api-http', 'topicos/storage', 'topicos/config'],
  },
];

export const PACKAGES: readonly LlmsSet[] = [
  {
    id: 'pacotes/core',
    title: '@usebridger/core',
    description: 'bot, plugins, comandos, config, storage, HTTP, API, logger e filas',
    pages: ['pacotes/core/**'],
    related: ['topicos/primeiro-bot', 'topicos/plugin', 'topicos/api-http'],
    links: [
      apiRef('@usebridger/core', 'core'),
      apiRef('@usebridger/core/adapter', 'core/adapter'),
      apiRef('@usebridger/core/storage/contract', 'core/storage-contract'),
      SPEC,
    ],
  },
  {
    id: 'pacotes/transport-baileys',
    title: '@usebridger/transport-baileys',
    description: 'WhatsApp via Baileys: pareamento por QR ou código, mídia e reconexão',
    pages: ['pacotes/transport-baileys/**'],
    related: ['topicos/primeiro-bot', 'topicos/producao'],
    links: [apiRef('@usebridger/transport-baileys', 'transport-baileys')],
  },
  {
    id: 'pacotes/transport-web',
    title: '@usebridger/transport-web',
    description: 'chat web: WebSocket com JWT, conversas e mídia por HTTP, e o cliente',
    pages: ['pacotes/transport-web/**'],
    related: ['topicos/primeiro-bot', 'topicos/api-http'],
    links: [
      apiRef('@usebridger/transport-web', 'transport-web'),
      apiRef('@usebridger/transport-web/client', 'transport-web/client'),
    ],
  },
  {
    id: 'pacotes/transport-telegram',
    title: '@usebridger/transport-telegram',
    description: 'Telegram via Bot API (grammY), por long polling',
    pages: ['pacotes/transport-telegram/**'],
    related: ['topicos/primeiro-bot', 'topicos/api-http'],
    links: [apiRef('@usebridger/transport-telegram', 'transport-telegram')],
  },
  {
    id: 'pacotes/storage-sqlite',
    title: '@usebridger/storage-sqlite',
    description: 'storage em SQLite (`node:sqlite`), para um processo',
    pages: ['pacotes/storage-sqlite/**'],
    related: ['topicos/storage', 'pacotes/storage-postgres'],
    links: [apiRef('@usebridger/storage-sqlite', 'storage-sqlite')],
  },
  {
    id: 'pacotes/storage-postgres',
    title: '@usebridger/storage-postgres',
    description: 'storage em Postgres, para vários processos dividindo o banco',
    pages: ['pacotes/storage-postgres/**'],
    related: ['topicos/storage', 'pacotes/storage-sqlite'],
    links: [apiRef('@usebridger/storage-postgres', 'storage-postgres')],
  },
  {
    id: 'pacotes/plugin-metrics',
    title: '@usebridger/plugin-metrics',
    description: 'métricas declarativas sobre o prom-client, histórico e `GET /metrics`',
    pages: ['pacotes/plugin-metrics/**'],
    related: ['topicos/producao', 'topicos/api-http'],
    links: [apiRef('@usebridger/plugin-metrics', 'plugin-metrics')],
  },
  {
    id: 'pacotes/testing',
    title: '@usebridger/testing',
    description: 'bot com transport falso, perfis de plataforma e matchers para o Vitest',
    pages: ['pacotes/testing/**'],
    related: ['topicos/testes', 'topicos/plugin'],
    links: [apiRef('@usebridger/testing', 'testing')],
  },
  {
    id: 'pacotes/create-plugin',
    title: 'create-bridger-plugin',
    description: 'gera um plugin pronto para desenvolver, testar e publicar',
    pages: ['pacotes/create-plugin/**'],
    related: ['topicos/plugin', 'topicos/testes'],
  },
];

export const LLMS_SETS: readonly LlmsSet[] = [...TOPICS, ...PACKAGES];

/** Se o id de página casa com o padrão: id exato, ou `pasta/**` para a pasta e o que está abaixo. */
export function matchesPage(pattern: string, id: string): boolean {
  if (!pattern.endsWith('/**')) return id === pattern;
  // O index da pasta tem o id da própria pasta (`pacotes/testing`), sem barra no fim.
  const dir = pattern.slice(0, -3);
  return id === dir || id.startsWith(`${dir}/`);
}

/** As páginas do conjunto, na ordem dos padrões e sem repetir; dentro de uma pasta, por id. */
export function pagesOf(set: LlmsSet, ids: readonly string[]): string[] {
  const sorted = [...ids].sort();
  const out = new Set<string>();
  for (const pattern of set.pages) {
    for (const id of sorted) if (matchesPage(pattern, id)) out.add(id);
  }
  return [...out];
}

/** URL do conjunto; `site` é a raiz do site com o base e a barra final. */
export function setUrl(site: string, id: string): string {
  return new URL(`llms/${id}.txt`, site).href;
}

function setOf(id: string): LlmsSet {
  const set = LLMS_SETS.find((s) => s.id === id);
  if (!set) throw new Error(`llms: conjunto '${id}' não existe`);
  return set;
}

function line(label: string, url: string, description?: string): string {
  return `- [${label}](${url})${description ? `: ${description}` : ''}`;
}

/** O topo de um conjunto: o que ele cobre e para onde ir depois. */
export function renderSetHeader(set: LlmsSet, site: string): string {
  const related = set.related.map((id) => {
    const other = setOf(id);
    return line(other.title, setUrl(site, id), other.description);
  });
  const links = (set.links ?? []).map((l) =>
    line(l.label, new URL(l.path, site).href, l.description),
  );
  return [
    `# Bridger: ${set.title}`,
    `> ${set.description}`,
    `Conjunto da documentação do Bridger para LLMs. Índice de todos os conjuntos: ${new URL('llms.txt', site).href}`,
    '## Leia também',
    [...related, ...links].join('\n'),
  ].join('\n\n');
}

/** Corpo do `/llms.txt` depois da descrição: o mapa de conjuntos por tópico e por pacote. */
export function renderIndex(site: string): string {
  const list = (sets: readonly LlmsSet[]) =>
    sets.map((s) => line(s.title, setUrl(site, s.id), s.description)).join('\n');
  return [
    'Um bot do Bridger junta um transport (WhatsApp via Baileys, Telegram, chat web), um storage ' +
      '(SQLite ou Postgres) e plugins, que trazem comandos, conversas, rotas HTTP e config validada ' +
      'por Zod. O core roda em Node 24+ e expõe uma API HTTP descrita em OpenAPI 3.2, para painéis ' +
      'e automação.',
    'Como ler: escolha o tópico da tarefa e leia o conjunto dele; cada conjunto lista os ' +
      'relacionados no topo. Para um pacote específico, use o conjunto do pacote. Cada página do ' +
      `site também existe sozinha em Markdown: troque a barra final da URL por \`.md\` (ex.: ${new URL('guias/comandos.md', site).href}).`,
    '## Tópicos',
    list(TOPICS),
    '## Pacotes',
    list(PACKAGES),
    '## API HTTP',
    [
      line(
        SPEC.label,
        new URL(SPEC.path, site).href,
        'a do seu app, com as rotas dos plugins, sai em `GET /openapi.json` ou `bridger openapi`',
      ),
      line('Spec OpenAPI navegável', new URL('openapi/', site).href),
    ].join('\n'),
  ].join('\n\n');
}
