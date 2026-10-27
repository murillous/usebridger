# Bridger — Plano do framework

> Documento de planejamento consolidado a partir da sessão de levantamento de requisitos
> de 2026-10-06. Fonte única de verdade para criar o GitHub Project (milestones, issues e
> sub-issues). As decisões estão em `docs/adr/`.

---

## Sumário

1. [Visão](#1-visão)
2. [Contexto: por que extrair um kernel do LumaBot](#2-contexto-por-que-extrair-um-kernel-do-lumabot)
3. [Diagnóstico do LumaBot atual](#3-diagnóstico-do-lumabot-atual)
4. [Decisões](#4-decisões)
5. [Arquitetura](#5-arquitetura)
6. [API pública (esboços)](#6-api-pública-esboços)
7. [Metas de performance](#7-metas-de-performance)
8. [Governança, licença e modelo comercial](#8-governança-licença-e-modelo-comercial)
9. [Roadmap](#9-roadmap)
10. [Checklist de paridade com o legacy](#10-checklist-de-paridade-com-o-legacy)
11. [Fora de escopo da v1](#11-fora-de-escopo-da-v1)
12. [Sugestão de organização do GitHub Project](#12-sugestão-de-organização-do-github-project)

---

## 1. Visão

**Bridger** é um framework para bots de mensageria (WhatsApp, Discord, Telegram e sistemas web
próprios, D51) em arquitetura de *microkernel* (D129): o core contém apenas o indispensável —
conexão, modelo de mensagem, roteamento, filas, armazenamento, configuração e ciclo de vida de
plugins. **Todo o resto é plugin.**

Objetivos:

- **A comunidade cria plugins sem conhecer o funcionamento interno.** O contrato público
  (tipos TypeScript + docs + kit de testes) é o produto.
- **Máximo de performance**, com metas mensuráveis e benchmark no CI.
- **Multiplataforma**: o core só conhece o contrato do `Transport`; o que é de cada plataforma
  fica no transport. Baileys no M2 e `transport-web` (chatbot dentro de sistemas próprios, como
  ERP e gestão escolar) no M3 validam o contrato antes do 1.0; Telegram e Discord vêm depois. API
  Oficial do WhatsApp (Cloud API), Twilio e Zenvia no futuro, para uso comercial.
- **Open core**: core e transports Baileys, web, Telegram e Discord públicos;
  transports comerciais de WhatsApp e integrações privadas.

Analogia guia — **mods de Minecraft**: plugins (mods) são feitos pela comunidade e rodam sobre
diferentes *runners* (Fabric, Forge, NeoForge ↔ Baileys, web, Telegram, Discord). Nem todo plugin
roda em todo transporte, e o plugin declara o que precisa.

O **LumaBot** deixa de ser o produto e passa a ser o **app de referência**: a Luma (IA com
persona) vira um plugin do Bridger, escrito no próprio `LumaBot` sobre os pacotes do npm (D82).

---

## 2. Contexto: por que extrair um kernel do LumaBot

O LumaBot é um bot de WhatsApp completo (Baileys 7, Gemini/OpenAI/DeepSeek, SQLite, Sharp,
FFmpeg, dashboard React) com arquitetura hexagonal, plugins e DI. A intenção já existia, mas a
implementação tem vazamentos que impedem que terceiros escrevam plugins sem ler o código
interno. Em vez de refatorar in-place (arrastando os débitos), o kernel nasce do zero num
monorepo, usando o LumaBot como **referência de leitura** e como **primeiro consumidor** que
valida que a API de plugins é suficiente.

### O que reaproveitar como referência

| Peça atual | Por que é boa | Destino |
|---|---|---|
| `src/infra/JidQueue.js` | Serializa o mesmo chat, paraleliza chats distintos — modelo de concorrência correto | Core (fila de entrada) |
| `src/infra/ReconnectionPolicy.js` | Separa decisão de execução | Core (quase como está) |
| `src/plugins/PluginManager.js` | Índice de comandos O(1), hooks de lifecycle | Ideia mantida, implementação refeita |
| `src/infra/Container.js` | DI lazy/singleton | Substituído por instância `Bot` + service registry tipado |
| `BaileysAdapter.unwrapMessage` | Desempacota ephemeral/viewOnce/documentWithCaption | `transport-baileys` |
| `src/core/ports/*` | Primeiros contratos de porta | Referência para `Transport` e `StoragePort` |

---

## 3. Diagnóstico do LumaBot atual

Débitos que **impedem** um kernel de verdade e que o Bridger deve corrigir por design:

| # | Débito | Evidência | Correção no Bridger |
|---|---|---|---|
| 1 | `MessagingPort` vaza o Baileys | `bot.socket`, `bot.raw`, `bot.innerMessage` usados em `GroupService`, `LumaHandler`, `ToolDispatcher`, `SpontaneousHandler` | Modelo de mensagem normalizado + `media.download()` + capabilities; escape hatch explícito `ctx.unsafe.native` |
| 2 | Comandos centralizados | `CommandRouter` é um `if` gigante sobre `COMMANDS`; criar comando = editar 3 arquivos do core; `includes()` gera falsos positivos | Comandos declarados pelo plugin; match por token inicial exato; conflito = erro no boot |
| 3 | Registro de plugins hardcoded | `MessageHandler.buildPluginManager()` importa `LumaHandler`, `AudioTranscriber`, `env` | Loader por config (npm) + `pluginDirs`; core não importa nenhuma feature |
| 4 | Estado global estático | `DatabaseService.*` em 11 arquivos; `SpontaneousHandler static #cooldowns`; `MessageHandler.#pm`; `Database.js` abre banco no import | Todo estado pendurado na instância `Bot`; zero side effect em import |
| 5 | DI pela metade | `Container`/`StoragePort` só usados em testes | `StoragePort` é o caminho real; services injetados via contexto |
| 6 | Dispatch sequencial sem isolamento | `onMessage` de todos os plugins com `await` em série; exceção ou trava afeta os demais | Listeners em paralelo, cada um com try/catch + timeout + log com nome do plugin |
| 7 | `MessageRouter` com múltiplas responsabilidades | Rate limit, sanitização, tracking de usuário e roteamento juntos; `rateLimiter` é um `Map` nunca limpo (vazamento) | Cada responsabilidade vira middleware; estruturas com expiração; teste de memória no benchmark |
| 8 | Higiene | 155 imports relativos; `export default` em `index.js`; `catch {}` vazio em `ConnectionManager.closeSafely`; `process.env` fora de `env.js` | Regras do Biome + aliases `@usebridger/*` + CI |
| 9 | Sem contrato de eventos | Só `messages.upsert` chega aos plugins | Barramento tipado: mensagem, reação, edição, deleção, grupo (entrada/saída/update), conexão, QR |
| 10 | Sem fila de saída | Só há rate limit de entrada; rajadas de envio arriscam ban | Fila de saída com taxa global/por chat, prioridade e retry |
| 11 | Auth em arquivos | `useMultiFileAuthState` (não recomendado pelo Baileys em produção) | Auth state no `StoragePort` (SQLite/Postgres) |
| 12 | Dashboard via stdout | Sinais `[LUMA_QR]`, `[LUMA_STATUS]` parseados de texto; processo filho | Dashboard vira plugin, cliente da API HTTP do core (D19, D125) |

---

## 4. Decisões

Cada decisão é um ADR em [`docs/adr/`](docs/adr/README.md) (`DNN` = `ADR 00NN`).

---

## 5. Arquitetura

### 5.1 Layout do monorepo

```
bridger/
├── packages/
│   ├── core/                 # @usebridger/core — o core
│   ├── transport-baileys/    # @usebridger/transport-baileys
│   ├── transport-web/        # @usebridger/transport-web (M3, D51)
│   ├── transport-telegram/   # @usebridger/transport-telegram (pós-v1)
│   ├── transport-discord/    # @usebridger/transport-discord (pós-v1)
│   ├── storage-sqlite/       # @usebridger/storage-sqlite (padrão)
│   ├── storage-postgres/     # @usebridger/storage-postgres
│   ├── testing/              # @usebridger/testing — FakeTransport, createTestBot, matchers
│   ├── plugin-metrics/       # @usebridger/plugin-metrics (D103)
│   ├── plugin-dashboard/     # @usebridger/plugin-dashboard (D103)
│   └── create-plugin/        # create-bridger-plugin — scaffold
├── bench/                    # benchmarks do CI
└── docs/
    ├── adr/                  # um ADR por decisão
    ├── guides/               # "primeiro plugin em 5 minutos", etc.
    └── api/                  # TypeDoc gerado
```

### 5.2 O que é core × plugin

**Core (`@usebridger/core`)**

| Componente | Responsabilidade |
|---|---|
| `Bot` | Instância raiz; dona de todo o estado; `start()`/`stop()` |
| Connection lifecycle | QR, pairing code, reconexão via policy (decisão separada da execução) |
| `Transport` (interface) | Contrato + capabilities; adapters em pacotes separados |
| Modelo de mensagem | Union discriminada, quoted, mentions, mídia lazy com cache |
| Fila de entrada | Por chat (serializa mesmo chat, paraleliza chats distintos) |
| Pipeline | Middlewares onion → comandos → listeners paralelos com `claim()` |
| Comandos | Declarativos: nome, aliases, prefixo configurável, `accepts`, `role`, parse de args |
| Barramento de eventos | Tipado; filtros declarativos (`message:image`, `{ quoted: 'audio' }`) |
| Lifecycle de plugins | Loader (npm + pasta), validação de manifesto, ordenação, `setup`/`teardown`, isolamento e timeout, tabela de boot |
| Service registry | `provides` / `ctx.services.get` |
| `StoragePort` | KV com namespace + coleções; auth state |
| Scheduler | Jobs persistidos no storage (um loop só para todo o bot) |
| Fila de saída | Rate global/por chat, prioridade, retry, humanização opcional |
| Config | Zod por plugin, precedência, secrets, reload de plugin |
| Papéis | owner / group-admin / everyone; middleware de allow/blocklist |
| HTTP | Hono sob demanda, `/health`, rotas namespaced |
| API HTTP | OpenAPI em `/openapi.json`, auth (usuários, API keys, papéis), SSE, `api.resources` (D125) |
| Logger | pino estruturado com `plugin` no contexto |

**Plugins oficiais** (no `usebridger`, D103): metrics e dashboard.

**Plugins da Luma** (no `LumaBot`, D82): help (gerado a partir dos comandos registrados), everyone (`@todos`),
user-names (resolução JID → nome/nick, provê service), media (sticker/imagem/GIF/PDF), download
(vídeo/áudio), reminders (usa o Scheduler), rank, ai (Luma: IA, personas, tools, histórico,
resumo, spontaneous, transcrição).

### 5.3 Fluxo de uma mensagem

```
Transport (Baileys, web...) ── evento bruto
        │
   normaliza → Message (union discriminada)
        │
   Fila de entrada por chat
        │
   Middlewares (onion, por prioridade)      ← ignore-self, rate limit, allow/blocklist,
        │                                     sanitização (middlewares do app)...
   Comando casou? (token inicial exato)
     ├─ sim → valida role (inclui papéis custom, D31) + accepts → run()  → mensagem consumida
     └─ não → listeners em paralelo (try/catch + timeout cada)
                 └─ ctx.claim() sinaliza "já respondi" aos de menor prioridade
        │
   ctx.reply()/send → Fila de saída (rate, prioridade, retry) → Transport
```

### 5.4 Regras de dependência

- `core` não importa nenhum transport, storage concreto nem plugin.
- Transports e storages dependem apenas de `core` (interfaces).
- Plugins dependem apenas da API pública de `core` (e de services de outros plugins via `dependsOn`).
- O app (`apps/lumabot`, no `LumaBot`) compõe config, transports e plugins próprios só com a API pública.
- Nenhum módulo tem side effect em import (abrir banco, ler env, criar diretório).

---

## 6. API pública (esboços)

> Esboços para orientar o design — nomes finais serão definidos nas issues do M1.

### 6.1 Composição do bot

O Bridger é uma biblioteca (D30): o app importa o core, compõe o bot e cuida do processo. Não
há runner nem arquivo de config descoberto por convenção.

```ts
// apps/lumabot/src/main.ts
import { createBot } from '@usebridger/core';
import { baileys } from '@usebridger/transport-baileys';
import { sqlite } from '@usebridger/storage-sqlite';
import { sticker } from '@usebridger/plugin-media';
import { ai } from '@usebridger/plugin-ai';

const bot = createBot({
  session: 'principal',                           // padrão 'default' (D32)
  transport: baileys({ pairing: 'qr' }),          // fábrica: recebe auth state e logger do bot (D33)
  storage: sqlite({ path: './data/bot.sqlite' }),
  owners: ['5511999999999'],
  prefix: '!',
  plugins: [sticker(), ai({ provider: 'gemini' })],
  pluginDirs: ['./plugins'],
  disabledPlugins: [],
  pluginConfig: { sticker: { quality: 90 } },     // env BRIDGER_STICKER__QUALITY vence (D28)
});

await bot.start();
process.once('SIGTERM', () => void bot.stop());
```

### 6.2 Definição de plugin (manifesto)

```ts
import { definePlugin, command } from '@usebridger/core';
import { z } from 'zod';

export const sticker = definePlugin({
  name: 'sticker',
  version: '1.2.0',
  engine: '^1.0.0',                              // semver do @usebridger/core
  requires: ['media.download', 'send.sticker'],  // capabilities do transporte
  transports: undefined,                         // opcional: fixa runner(s)
  dependsOn: { 'user-names': '^1.0.0' },         // opcional
  priority: 0,                                   // ou after: ['outro-plugin']

  config: z.object({
    quality: z.number().min(1).max(100).default(80),
  }),

  messages: {                                    // sobrescrevível via config (D22)
    needMedia: 'Mande ou responda uma imagem/vídeo 🙂',
  },

  setup(ctx) {
    ctx.commands.add(command({
      name: 'sticker', aliases: ['s'],
      accepts: ['image', 'video', 'quoted:image', 'quoted:video'],
      onReject: (c) => c.plugin.messages.needMedia,
      role: 'everyone',
      run: async (c) => {
        const buf = await c.media!.download();   // própria msg OU quoted, já resolvido
        await c.reply.sticker(buf);
      },
    }));
  },

  teardown(ctx) { /* libera recursos */ },
});
```

### 6.3 Modelo de mensagem

```ts
bot.on('message', async (ctx) => {
  const msg = ctx.message;
  msg.type   // 'text' | 'image' | 'video' | 'audio' | 'voice' | 'sticker'
             // | 'document' | 'location' | 'contact' | 'poll' | 'unknown'
  msg.text   // texto ou legenda; null se não houver
  msg.chat   // { id, isGroup }
  msg.sender // Contact

  if (msg.is('image')) {
    msg.media.mimetype; msg.media.size;
    await msg.media.download();  // Buffer, lazy + cache por mensagem
    await msg.media.stream();    // para arquivos grandes
  }

  msg.quoted                     // Message | null (mesmo tipo, recursivo)
  msg.mentions                   // Contact[]
  msg.isForwarded; msg.isViewOnce; msg.isEdited
});

bot.on('message:image', handler);
bot.on('message', { quoted: 'audio' }, handler);
```

### 6.4 Eventos

`message`, `message:<type>`, `message.edited`, `message.deleted`, `reaction`, `poll.vote` (D67),
`group.joined`, `group.left`, `group.participants`, `group.updated`,
`contact.updated` (D36), `connection.status`, `connection.qr`, `connection.pairing-code` (D46),
`command` (D45), `plugin.error`.

### 6.5 Contexto, claim e escape hatch

```ts
bot.on('message', { priority: -10 }, async (ctx) => {
  if (ctx.claimed) return;          // alguém de maior prioridade já respondeu
  ctx.claim();
  await ctx.reply('...');
});

ctx.unsafe.native                   // unknown; loga aviso; implica transports: ['baileys']

// Prazo (D29): o signal aborta quando o prazo do comando/listener/job estoura
run: async (c) => {
  const res = await fetch(url, { signal: c.signal });
  await c.reply(await res.text());  // depois do prazo: rejeita com ContextExpiredError
}
```

### 6.6 Storage

```ts
await ctx.storage.kv.set('lastRun', Date.now());
const reminders = ctx.storage.collection('reminders', { indexes: ['fireAt', 'chatId'] });
await reminders.insert({ chatId, fireAt, text });
await reminders.find({ where: { fireAt: { lte: Date.now() } }, orderBy: 'fireAt', limit: 50 });
```

### 6.7 Services entre plugins

```ts
// plugin 'ai'
definePlugin({ name: 'ai', setup(ctx) { ctx.services.provide('ai', aiService); } });

// declaration merging para tipagem
declare module '@usebridger/core' {
  interface Services { ai: AiService }
}

// plugin 'resumo'
definePlugin({ name: 'resumo', dependsOn: { ai: '^1.0.0' },
  setup(ctx) { const ai = ctx.services.get('ai'); } });
```

### 6.8 Scheduler, HTTP e papéis

```ts
ctx.scheduler.at(date, 'reminder.fire', payload);    // persistido
ctx.scheduler.on('reminder.fire', async (payload) => { ... });

ctx.http.route('POST', '/webhook', handler);          // → /plugins/<name>/webhook

command({ name: 'config', role: 'owner', run });
command({ name: 'ban', role: 'group-admin', run });   // requer capability 'groups'

// Papel custom (D31): definido por um plugin, usado por qualquer outro
ctx.roles.define('moderador', async (c) => moderadores.has(c.message.sender.id));
command({ name: 'mute', role: 'moderador', run });
```

### 6.9 Testes de plugin

```ts
import { createTestBot } from '@usebridger/testing';

const bot = await createTestBot({ plugins: [sticker()] });
await bot.receive({ text: '!s', image: fixtureBuffer });
expect(bot.sent).toContainSticker();
```

### 6.10 Capabilities por transport

Cada transport declara as próprias (D08). A lista é só a do core, e capability nova entra numa minor
(D66). Limites de tamanho não são capability: ficam em `Transport.limits` (D57, D61). As colunas do
Baileys e do web são o que eles declaram hoje (o web desde o D73); as do Telegram e do Discord são a
previsão, confirmada quando cada transport nascer, depois do v1.0.

| Capability | Baileys | Telegram | Discord | web |
|---|---|---|---|---|
| `actions` | — | ✓ | ✓ | ✓ |
| `groups` | ✓ | ✓ | ✓ | — |
| `groups.add` | ✓ | — | — | — |
| `groups.remove` | ✓ | ✓ | ✓ | — |
| `groups.promote` | ✓ | ✓ | — | — |
| `mentions` | ✓ | ✓ | ✓ | — |
| `reactions` | ✓ | ✓ | ✓ | — |
| `typing` | ✓ | ✓ | ✓ | ✓ |
| `send.text` | ✓ | ✓ | ✓ | ✓ |
| `send.image` | ✓ | ✓ | ✓ | ✓ |
| `send.video` | ✓ | ✓ | ✓ | ✓ |
| `send.audio` | ✓ | ✓ | ✓ | ✓ |
| `send.voice` | ✓ | ✓ | — | — |
| `send.sticker` | ✓ | ✓ | — | — |
| `send.document` | ✓ | ✓ | ✓ | ✓ |
| `send.album` | — | ✓ | ✓ | — |
| `send.template` | — | — | — | — |
| `media.download` | ✓ | ✓ | ✓ | ✓ |
| `message.edit` | ✓ | ✓ | ✓ | ✓ |
| `message.delete` | ✓ | ✓ | ✓ | ✓ |
| `polls` | ✓ | ✓ | ✓ | — |
| `quoted` | ✓ | ✓ | ✓ | ✓ |
| `pairing` | ✓ | — | — | — |

---

## 7. Metas de performance

Medidas no CI com `FakeTransport` (sem I/O de rede). PR falha se regredir mais de 10%.

| Métrica | Meta |
|---|---|
| Overhead do kernel por mensagem (middlewares + roteamento + dispatch) | p99 < 1 ms |
| Vazão sintética | ≥ 5.000 msg/s em 500 chats, 1 núcleo |
| Memória ociosa | < 80 MB |
| Crescimento de memória após 1M mensagens | ~0 (detecta vazamentos como o `rateLimiter` atual) |
| Boot até "pronto para conectar" com 20 plugins | < 500 ms |

---

## 8. Governança, licença e modelo comercial

- **Licença**: Apache-2.0 para `packages/*`; `legacy/` permanece MIT.
- **Open core**: transports comerciais de WhatsApp (Cloud API, Twilio, Zenvia), dashboard
  multi-número e integrações (CRM, sistemas do dono como ERP e gestão escolar) vivem num **repo
  privado** que consome os pacotes publicados num registry privado (GitHub Packages). Se o
  privado precisar de algo não exportado, falta API no core — nunca atalho interno. Os
  transports Discord, Telegram e web são públicos, neste monorepo (D51).
- **Versionamento**: Changesets; changelog por pacote no formato Keep a Changelog.
- **Estabilidade**: `0.x` livre até a 1.0; depois, `@deprecated` por ≥ 1 minor antes de remover;
  `@experimental` para APIs novas.
- **Documentação** (por pacote): COMO em `docs/`, PORQUE em `docs/adr/`, PROGRESSO em
  `CHANGELOG.md`.
- **Convenções**: ESM, named exports apenas, imports absolutos (`@usebridger/*`), comentários em
  PT-BR explicando o porquê, nunca engolir erros, nenhum `process.env` fora da camada de config.
  Codificadas no Biome e verificadas no CI.

---

## 9. Roadmap

Um ID por issue (`M1-2`; sub-issues `M1-2.1`), citado nos commits. M0 a M3 estão entregues. O M4,
o M5 (exceto M5-4 e M5-6) e a virada (V1-1, V1-2 e V1-4) vivem no `murillous/LumaBot` (D82).

### M0 — Fundação

- #M0-1 Criar monorepo
- #M0-2 Tooling de qualidade
- #M0-3 CI (GitHub Actions)
- #M0-4 Mover LumaBot para `legacy/`
- #M0-5 ADRs
- #M0-6 Licença e governança

### M1 — Core (`@usebridger/core`)

- #M1-1 Instância `Bot` e lifecycle
- #M1-2 Interface `Transport` e capabilities
- #M1-3 Modelo de mensagem
- #M1-4 Fila de entrada por chat
- #M1-5 Pipeline de middlewares
- #M1-6 Roteador de comandos
- #M1-7 Barramento de eventos
- #M1-8 Loader e lifecycle de plugins
- #M1-9 Service registry
- #M1-10 `StoragePort`
- #M1-11 Scheduler
- #M1-12 Fila de saída
- #M1-13 Config
- #M1-14 Logger
- #M1-15 Escape hatch
- #M1-16 Pipeline integrado no `Bot`
- #M1-17 API pública por público (D30)
- #M1-18 Métricas das filas no `Bot`
- #M1-19 Papéis custom nomeados (D31)
- #M1-20 Escopo de sessão (D32)
- #M1-21 Transport por fábrica (D33)

### M2 — Primeiro transporte, storage e kit de testes

- #M2-1 `@usebridger/transport-baileys`
- #M2-2 `@usebridger/storage-sqlite`
- #M2-3 `@usebridger/testing`
- #M2-4 Benchmark
- #M2-5 App mínimo

### M3 — Postgres, HTTP e experiência do autor

- #M3-1 `@usebridger/storage-postgres`
- #M3-2 HTTP do core
- #M3-3 `create-bridger-plugin`
- #M3-4 Documentação de autor
- #M3-5 `@usebridger/transport-web` (#287, D51, D73)

### M5 — Plugins oficiais (D103)

- #M5-4 `plugin-dashboard`
- #M5-6 `plugin-metrics` — serviço `metrics`, métricas do kernel pelos observadores do core (D102), `/metrics` Prometheus, retenção de 90 dias (D103)

### M6 — Métricas sobre o `prom-client` (D121)

- #M6-1 ADR 0121: `plugin-metrics` redesenhado sobre o `prom-client` (#233)
- #M6-2 Bench: linha de base do caminho de mensagem com o `plugin-metrics` (#234)
- #M6-3 Dashboard atual: remover a seção de métricas (#235)
- #M6-4 Serviço declarativo sobre o `prom-client` e `/metrics` da registry (#236)
- #M6-5 Histórico por hora e dia a partir do delta da registry (#237)
- #M6-6 `query` com `where`/`groupBy`, percentil interpolado e `catalog()` (#238)
- #M6-7 Métricas do runtime do Node no `/metrics` e no histórico (#239)
- #M6-8 `scrapeToken` no `GET /metrics` (#240)
- #M6-9 Reconhecedor de id pessoal do core no lugar do regex local (#241)

### M7 — API HTTP do core e dashboard como cliente (D125)

Tudo o que o dashboard mostra sai da API pública do core, descrita em OpenAPI: um app que consome
o Bridger chega às mesmas informações sem o `plugin-dashboard`. O dashboard vira cliente genérico,
sem rota nem auth próprias. Atendimento humano fica com cada app (ex.: Chatwoot), fora do kernel.

- #M7-1 Pesquisa e protótipo: OpenAPI a partir do Zod, SSE na spec e Refine (#273)
- #M7-2 ADR 0125: API HTTP do core em OpenAPI e dashboard como cliente (#274)
- #M7-3 Base da API HTTP, problem+json e `/openapi.json` (#275)
- #M7-4 Autenticação da API: usuários, sessões, API keys e papéis (#223)
- #M7-5 Conexão e tempo real por SSE: status, QR, pareamento, logs ao vivo (#276)
- #M7-6 Plugins e configuração na API, com segredos (#277)
- #M7-7 Histórico de logs e métricas na API (#278)
- #M7-8 Ponto de extensão `api.resources` no lugar do `dashboard.tabs` (#279)
- #M7-9 Auditoria na API: consulta, exportação e `verify` (#261)
- #M7-10 `plugin-dashboard` refeito como cliente genérico da API (#280)

### v1.0

- #V1-3 Release 1.0.0 de todos os pacotes públicos via Changesets, depois do contrato validado pelo `transport-web` (M3-5, D51)

### Pós-v1 (repo privado / backlog)

- `@usebridger/transport-telegram` (#288) e `@usebridger/transport-discord` (#289), públicos (D51)
- Transport Cloud API (WhatsApp oficial, privado): templates, janela de 24h
- Transports Twilio e Zenvia (privados)
- Dashboard central multi-número (lendo do Postgres)
- i18n formal (`ctx.t()`)
- Permissões declarativas de plugin (se houver marketplace público)

---

## 10. Checklist de paridade com o legacy

Vive no `murillous/LumaBot`, com o M4 e o M5 (D80, D82).

---

## 11. Fora de escopo da v1

- Hot-reload de código de plugin (D06)
- Worker threads / sandbox de plugins (D04)
- Multi-sessão por processo (D03)
- Transports além do Baileys e do web (D51): Telegram e Discord públicos, Cloud API, Twilio e
  Zenvia no repo privado
- i18n formal (D22)
- SQL cru na API pública de storage (D13)
- Marketplace de plugins

---

## 12. Sugestão de organização do GitHub Project

- **Milestones**: `M0 Fundação`, `M1 Core`, `M2 Baileys + SQLite + Testing`,
  `M3 Postgres + HTTP + DX`, `M4 Plugins`, `M5 Luma + Dashboard`, `M6 Métricas`,
  `M7 API e Dashboard`, `v1.0 Virada`.
- **Issues**: uma por item `#Mx-y` acima (épico/entrega), com os critérios de aceite.
- **Sub-issues**: os bullets dentro de cada item.
- **Labels**:
  - Área: `area:core`, `area:transport`, `area:storage`, `area:plugin`, `area:dx`,
    `area:docs`, `area:infra`, `area:legacy`
  - Tipo: `type:feature`, `type:debt`, `type:adr`, `type:bug`, `type:perf`
  - Outros: `good first issue`, `breaking`, `needs-adr`
- **Campos customizados** (Project v2): `Milestone`, `Pacote`, `Estimativa`, `Status`
  (Backlog → Ready → In progress → Review → Done).
- **Dependências**: M1 bloqueia M2; M1-7 bloqueia o estágio de listeners do M1-16; M2-3 (`testing`) bloqueia M4; M1-9 (services) e
  M4-3 (`user-names`) bloqueiam M5-1.
