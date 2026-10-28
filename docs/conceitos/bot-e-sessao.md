# Bot e sessão

Esta página explica as peças que você passa ao `createBot`, o que é uma sessão, como o bot
pareia e se recupera de quedas, e como rodar vários bots, escolher o banco e expor HTTP.

## O mínimo para subir um bot

Só o transport é obrigatório: `createBot({ transport })` sobe um bot sem plugins, com os dados em
memória. O `@usebridger/core` não traz transport; ele vem de outro pacote, então o mínimo instalado
é **core + um transport**:

| Pacote | Plataforma |
| --- | --- |
| `@usebridger/transport-baileys` | WhatsApp, pareado por QR ou código |
| `@usebridger/transport-telegram` | Telegram, com o token do @BotFather |
| `@usebridger/transport-web` | Chat web dentro de um sistema seu, por WebSocket e JWT |

Storage, plugins, servidor HTTP, API, autenticação e dashboard são opcionais. Um bot útil tem
também storage e plugins:

```ts
import { createBot } from '@usebridger/core';
import { sqlite } from '@usebridger/storage-sqlite';
import { baileys } from '@usebridger/transport-baileys';

const bot = createBot({
  transport: baileys({ pairing: 'qr' }),
  storage: sqlite({ path: 'data/bot.sqlite' }),
  plugins: [ping],
});
await bot.start();
```

O passo a passo está em [Seu primeiro bot](/usebridger/comecando/primeiro-bot/).

## O que cada peça faz

| Peça | Papel | Sem ela |
| --- | --- | --- |
| `transport` | Fala com a plataforma: recebe, envia, declara capabilities | obrigatória |
| `storage` | Guarda os dados dos plugins, os jobs do scheduler, os overrides de config e as credenciais da sessão | tudo em memória, com aviso no log; um restart pede pareamento de novo |
| `plugins` | O comportamento do bot | o bot conecta e não responde nada |
| `logger` | Linhas JSON (ou `pretty`) com os segredos censurados | o bot cria um, no nível `logLevel` |
| `http` | O servidor HTTP do processo, para rotas de plugin, webhooks e `/health` | `ctx.http` lança, e transports que precisam de HTTP (web) não sobem |
| `api` | A API do core sob `/api` (conexão, plugins, config, logs, auditoria) e a autenticação dela (`api.auth`) | sem `http`, não há API nem login; com `http` e sem `api.auth`, a API fica aberta e o bot só sobe em loopback (`127.0.0.1`) |

O transport entra como **fábrica** (`baileys({ ... })` devolve uma), não como objeto pronto: o
bot a chama com o que só ele tem, como as credenciais da sessão no storage e um logger com o nome
do transport. Assim você não costura o auth state à mão, e o core consegue limpá-lo quando a
plataforma desconecta a sessão.

## Sessão

A **sessão** é o número (ou a conta) que um bot opera, e o nome dela (`session`, padrão
`'default'`) é o escopo de tudo o que o bot persiste: dados dos plugins, jobs, overrides de config
e credenciais. Dois bots com sessões diferentes no mesmo banco não se enxergam.

## Pareamento: QR ou código

No WhatsApp, a sessão se pareia uma vez, e as credenciais ficam no storage. Há dois jeitos:

- **QR** (`pairing: 'qr'`): cada QR vira o evento `connection.qr`, e um plugin o mostra no
  terminal. Bom para a máquina de desenvolvimento.
- **Código** (`pairing: { phone: '5511999999999' }`): o transport pede um código de 8 caracteres
  para o número (só dígitos, com DDI) e emite `connection.pairing-code`. A pessoa digita o código
  no celular, em *Aparelhos conectados → Conectar com número de telefone*. Melhor num servidor,
  onde ler um QR no log é incômodo.

```ts
baileys({ pairing: { phone: '5511999999999' } });
```

Os dois chegam como evento, e não como callback do transport, para o mesmo plugin de pareamento
servir aos dois. Com a API ligada, dá para parear por código e desvincular o número sem reiniciar
o bot (`POST /api/connection/pairing-code` e `POST /api/connection/logout`), e acompanhar o QR ao
vivo pelo stream `GET /api/events`. O dashboard faz isso por você.

Telegram e web não têm pareamento: o token do @BotFather ou o JWT do seu sistema já são a
credencial.

## Quando a sessão cai

A regra é: **queda de rede nunca apaga credenciais**. Perder a conexão, um erro do servidor ou um
motivo desconhecido levam a reconectar sem limite de tentativas, com espera crescente (5 s, 10 s,
até 15 s entre tentativas). Um bot que apagasse a sessão depois de N falhas pediria um pareamento
manual a cada instabilidade de rede.

As credenciais só são apagadas quando a própria plataforma diz que elas não valem mais:

| Motivo | O que o bot faz |
| --- | --- |
| Logout (desconectado pelo celular) | Apaga as credenciais e começa um pareamento novo |
| QRs demais sem ninguém parear | Recomeça o pareamento do zero |
| Credencial recusada num transport **sem** pareamento (token inválido) | Para, com log em `fatal`: ninguém pode parear, alguém precisa corrigir a config |
| Erro de configuração (`fatal`: porta ocupada, permissão) | Para, com log em `fatal` |
| Outra conexão assumiu a sessão (`replaced`) | Para, com log em `error`, em vez de dois processos se derrubarem em laço |

Enquanto a conexão está caída, a fila de saída pausa e segura as respostas por até 60 s; depois
disso elas rejeitam, e o bot segue tentando reconectar. O que fazer em produção está em
[Rodar em produção → Re-pareamento](/usebridger/comecando/producao/#re-pareamento).

## Vários bots e vários processos

**Vários números no mesmo processo: sim.** Cada `createBot` é uma instância isolada, com roteador,
filas, scheduler e logger próprios. Vários bots podem dividir a **mesma instância** de storage e de
HTTP, uma sessão cada. É também o caminho para atender várias plataformas: um bot por transport,
porque capabilities, fila de saída e reconexão são de um transport só.

```ts
const storage = sqlite({ path: 'data/bot.db' });
const zap = createBot({ session: 'whatsapp', transport: baileys(), storage, plugins });
const site = createBot({ session: 'site', transport: web({ auth }), storage, http, plugins });
await Promise.all([zap.start(), site.start()]);
```

Os dados de cada bot ficam na própria sessão. O plugin que quer um dado comum a todos usa
`ctx.storage.shared`, que é dele em qualquer sessão
([Plugins → dados](plugins.md#onde-guardar-dados)).

**A mesma sessão em vários processos: não.** Dois processos no mesmo número responderiam em dobro.
No `start()`, o bot trava a sessão no storage por 30 s e renova a trava a cada 10 s. Um segundo
processo espera até 30 s e falha sem conectar; um restart logo depois de um crash sobe sozinho,
quando a trava velha vence.

Isso limita a escala de **um** número a um processo, de propósito: a fila de entrada que mantém a
ordem das mensagens de um chat e a fila de saída que controla o ritmo anti-ban vivem em memória.
Dividi-las entre processos exigiria coordenação distribuída para resolver um problema que um
processo resolve com folga (veja as [metas de performance](operacao.md#métricas-de-performance)).

## SQLite ou Postgres

Os dois implementam o mesmo contrato e passam pela mesma suíte de testes, então trocar de um para
o outro não muda nenhum plugin.

- **SQLite** (`@usebridger/storage-sqlite`) é o padrão: um arquivo, nenhum serviço para operar,
  backup é copiar o arquivo. Usa o `node:sqlite` embutido no Node 24, sem dependência nativa.
  Serve à grande maioria dos bots, inclusive com vários números no mesmo processo.
- **Postgres** (`@usebridger/storage-postgres`) entra quando o banco precisa viver fora da máquina
  do bot: processos em máquinas diferentes (um por número) dividindo um banco, backup e réplica
  gerenciados, ou outros sistemas lendo os dados. As tabelas ficam num schema próprio
  (`bridger`), os documentos em `jsonb`, e as migrations rodam no boot sob um advisory lock, para
  dois processos subindo juntos não colidirem.

Não há migração automática de dados de um para o outro.

## HTTP

O core tem **um servidor HTTP por processo**, criado com `createHttp({ port })` e passado a todos
os bots, como o storage. A porta só abre se alguém registrar uma rota. Os caminhos são fixos por
dono: `/plugins/<nome>/...` para os plugins, `/transports/<nome>/...` para os transports (o chat
do transport web, webhooks), e `/sessions/<sessão>/...` na frente nas sessões que não são a
`default`. Há também `/health`, que responde 200 com todas as sessões rodando e 503 senão.

Um plugin registra rota com `ctx.http.route(method, path, handler)`, com `Request` e `Response`
da Web API. Detalhes em [HTTP](../../packages/core/docs/http.md).

### A API do core

Com `api` ligada, o core publica uma API HTTP descrita em OpenAPI (`GET /openapi.json`). Ela
cobre o que um painel precisa: estado da conexão e QR ao vivo, logs recentes, plugins (ligar e
desligar), config (com segredos mascarados), auditoria, usuários e API keys. Plugins podem
acrescentar operações e recursos próprios. O dashboard oficial é só um cliente dela.

```ts
const bot = createBot({
  transport,
  storage,
  http: createHttp({ port: 3000 }),
  // Sem `auth`, a API fica aberta e o bot só sobe em loopback.
  api: { auth: { bootstrapToken: appEnv.BRIDGER_BOOTSTRAP_TOKEN } },
});
```

O `bootstrapToken` (16 caracteres ou mais) serve só para criar o primeiro usuário `owner`. Depois,
o acesso é por login (cookie de sessão) ou por API key (`Authorization: Bearer ...`), com papéis
`owner`, `admin` e `viewer`. A referência completa está em [API](../../packages/core/docs/api.md).

### Por que o kernel não tem autenticação

O kernel não autentica as rotas dos plugins nem dos transports, porque não há um esquema que sirva a todos: o
webhook de uma plataforma confere uma assinatura dela, o painel quer sessão de login, a integração
com o ERP usa o token do ERP. Um esquema embutido seria o errado para a maioria e daria uma falsa
sensação de proteção para o resto. (A autenticação da API do core, acima, é separada e cobre só as
rotas dela.)

Então cada handler de plugin confere a própria credencial e recusa com 401 antes de fazer qualquer
coisa:

```ts
ctx.http.route('POST', '/webhook', async (req) => {
  if (req.headers.get('authorization') !== `Bearer ${ctx.config.webhookSecret}`) {
    return new Response('não autorizado', { status: 401 });
  }
  // ... trata o webhook
  return new Response('ok');
});
```

Na prática:

- guarde o token ou o segredo do webhook como campo `secret` da config do plugin
  ([Configuração](configuracao.md#segredos));
- não exponha a porta do bot direto na internet: ponha um proxy reverso na frente (TLS, limite de
  taxa e, se quiser, autenticação de borda), e deixe aberto só o que precisa ser público;
- o `/health` não traz dado sensível (só o estado das sessões), então pode ficar acessível ao
  supervisor.

O transport web é o exemplo: ele aceita a conexão do chat só com um JWT assinado pelo seu sistema.
