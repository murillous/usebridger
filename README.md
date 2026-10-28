# Bridger

**Bridger é um framework para bots de mensageria em TypeScript.** Ele cuida do que todo bot
precisa (filas, comandos, eventos, agendamento, config, storage) e não depende de uma plataforma:
você escolhe onde o bot roda (WhatsApp, Telegram, chat web) e escreve o comportamento dele em
plugins.

## Por que usar em vez de escrever o bot direto sobre Baileys, grammY etc.

- **Plugins portáveis**: o mesmo plugin roda em qualquer plataforma. Trocar o WhatsApp pelo
  Telegram é trocar o `transport`.
- **Filas de entrada e saída**: mensagens do mesmo chat em série, ritmo de envio controlado,
  retry e divisão de texto longo, o que ajuda a evitar bloqueio da conta.
- **Comandos prontos**: roteador com prefixo, argumentos, permissões e conversas guiadas
  (pergunta, resposta, próxima pergunta).
- **Config e segredos**: cada plugin declara o que é configurável (schema Zod); os valores vêm de
  variável de ambiente, e segredo nunca vai para o log.
- **Storage e scheduler**: dados dos plugins e jobs agendados em SQLite ou Postgres.
- **Dashboard e métricas**: plugins oficiais com painel web e métricas Prometheus.
- **Kit de testes**: teste o plugin sobre um transport falso, sem rede.

Exemplo real de um bot construído sobre o Bridger: [LumaBot](https://github.com/murillous/LumaBot).

## Pacotes

| Pacote | Para que serve |
| --- | --- |
| [`@usebridger/core`](packages/core/docs/README.md) | O centro do framework: `createBot`, filas, comandos, eventos, scheduler, HTTP |
| [`@usebridger/transport-baileys`](packages/transport-baileys/docs/README.md) | WhatsApp, via Baileys |
| [`@usebridger/transport-telegram`](packages/transport-telegram/docs/README.md) | Telegram, via grammY |
| [`@usebridger/transport-web`](packages/transport-web/docs/README.md) | Chat dentro de um sistema web seu (WebSocket com JWT) |
| [`@usebridger/storage-sqlite`](packages/storage-sqlite/docs/README.md) | Storage em SQLite, sem dependência nativa |
| [`@usebridger/storage-postgres`](packages/storage-postgres/docs/README.md) | Storage em Postgres, para vários processos |
| [`@usebridger/testing`](packages/testing/docs/README.md) | Kit de testes: bot com transport falso e matchers para o Vitest |
| [`create-bridger-plugin`](packages/create-plugin/docs/README.md) | Gera um plugin pronto para desenvolver, testar e publicar |
| [`@usebridger/plugin-metrics`](packages/plugin-metrics/docs/README.md) | Plugin oficial de métricas (Prometheus) |
| [`@usebridger/plugin-dashboard`](packages/plugin-dashboard/docs/README.md) | Plugin oficial com painel web do bot |

## Setup

Requer **Node 24 ou mais novo** (`node --version`). O Node 24 roda `.ts` direto, sem etapa de
build. Num projeto novo:

```sh
mkdir meu-bot && cd meu-bot
npm init -y
npm pkg set type=module
npm install @usebridger/core @usebridger/transport-baileys @usebridger/storage-sqlite qrcode-terminal
```

Com pnpm, troque `npm install` por `pnpm add`. O core e um transport são o mínimo; o storage
guarda a sessão do WhatsApp para não parear de novo a cada reinício. Para outra plataforma, troque
o transport (`@usebridger/transport-telegram`, `@usebridger/transport-web`).

## Primeiros passos

### Um bot com o comando `!ping`

Crie `main.ts`:

```ts
import { createBot, definePlugin } from '@usebridger/core';
import { sqlite } from '@usebridger/storage-sqlite';
import { baileys } from '@usebridger/transport-baileys';
import qrcode from 'qrcode-terminal';

// Um plugin é um objeto: nome, versão, a faixa do core que ele aceita e o que ele oferece.
const ping = definePlugin({
  name: 'ping',
  version: '1.0.0',
  engine: '<1.0.0',
  commands: {
    // `!ping` → o que o `run` devolver vira a resposta no mesmo chat.
    ping: { description: 'Responde pong', run: () => 'pong' },
  },
});

// O transport só avisa que há um QR para mostrar; quem exibe é um plugin.
const pareamento = definePlugin({
  name: 'pareamento',
  version: '1.0.0',
  engine: '<1.0.0',
  on: {
    'connection.qr': ({ payload }) => qrcode.generate(payload.qr, { small: true }),
  },
});

const bot = createBot({
  transport: baileys({ pairing: 'qr' }),
  storage: sqlite({ path: 'data/bot.sqlite' }),
  plugins: [pareamento, ping],
});

await bot.start();
```

```sh
node main.ts
```

No celular: WhatsApp, **Aparelhos conectados**, **Conectar um aparelho**, e leia o QR do terminal.
Depois, mande `!ping` ao número do bot, de outro contato: a resposta é `pong`. Nas próximas
execuções não há QR, porque as credenciais ficam no SQLite. Para parear por código em vez de QR e
para o passo a passo completo: [Seu primeiro bot](https://murillous.github.io/usebridger/comecando/primeiro-bot/).

### Um plugin como projeto próprio

```sh
npm create bridger-plugin@latest bridger-plugin-ola
cd bridger-plugin-ola
npm install
npm test
```

O gerador cria o plugin (`src/index.ts`), um teste e a configuração de build, prontos para
publicar no npm. Detalhes em [Seu primeiro plugin](https://murillous.github.io/usebridger/comecando/primeiro-plugin/).

## Para se aprofundar

- **Site de documentação**: <https://murillous.github.io/usebridger/> (começando, guias, pacotes e
  referência da API).
- **Guias do autor de plugin**: [`docs/guias/`](docs/guias/README.md) (comandos, config, storage,
  scheduler, testes, portabilidade).
- **Conceitos**: [`docs/conceitos/`](docs/conceitos/README.md) (visão geral, mensagem, plugins,
  operação).
- **Cada pacote**: `packages/<nome>/docs/`, por exemplo o [core](packages/core/docs/README.md).
- **Exemplos**: [`examples/`](examples) (bot, plugin, config, conversa guiada, produção).

## Contribuir

Veja o [`CONTRIBUTING.md`](CONTRIBUTING.md), que também traz o setup do monorepo, os comandos e as
convenções de código.

## Licença

[Apache-2.0](LICENSE).
