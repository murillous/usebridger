# Bot e sessão

## O mínimo para subir um bot

Só o transport é obrigatório: `createBot({ transport })` sobe um bot sem plugins, com os dados em
memória. O `@usebridger/core` não traz transport; ele vem de outro pacote, então o mínimo instalado
é **core + um transport**:

| Pacote | Plataforma |
| --- | --- |
| `@usebridger/transport-baileys` | WhatsApp, pareado por QR ou código |
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
| `api` | A API do core sob `/api` (conexão, plugins, auditoria) e a autenticação dela (`api.auth`) | sem `http`, não há API nem login; com `http` e sem `api.auth`, a API fica aberta e o bot só sobe em loopback ([ADR 0128](../adr/0128-limitacoes-da-autenticacao-da-api.md)) |

O transport entra como **fábrica** (`baileys({ ... })` devolve uma), não como objeto pronto: o
bot a chama com o que só ele tem, como as credenciais da sessão no storage e um logger com o nome
do transport. Assim o app não costura o auth state à mão, e o kernel consegue limpá-lo quando a
plataforma desconecta a sessão ([ADR 0033](../adr/0033-transport-por-fabrica.md)).

## Sessão

A **sessão** é o número (ou a conta) que um bot opera, e o nome dela (`session`, padrão
`'default'`) é o escopo de tudo o que o bot persiste: dados dos plugins, jobs, overrides de config
e credenciais. Dois bots com sessões diferentes no mesmo banco não se enxergam
([ADR 0032](../adr/0032-escopo-de-sessao.md)).

## Pareamento: QR ou código

No WhatsApp, a sessão se pareia uma vez, e as credenciais ficam no storage. Há dois jeitos, e o
transport chama os dois de **pareamento**:

- **QR** (`pairing: 'qr'`): cada QR vira o evento `connection.qr`, e um plugin o mostra no
  terminal. Bom para a máquina de desenvolvimento.
- **Código** (`pairing: { phone }`): o transport pede um código de 8 caracteres para o número e
  emite `connection.pairing-code`. A pessoa digita o código no celular, em *Aparelhos conectados →
  Conectar com número de telefone*. Melhor num servidor, onde ler um QR no log é incômodo.

Os dois chegam como evento, e não como callback do transport, para o mesmo plugin de pareamento
servir aos dois e o kernel contá-los igual na política de reconexão
([ADR 0046](../adr/0046-codigo-de-pareamento.md)).

## Quando a sessão cai

A regra é: **queda de rede nunca apaga credenciais**. Perder a conexão, um erro do servidor ou um
motivo desconhecido levam a reconectar sem limite de tentativas, com espera crescente (5 s, 10 s,
até 15 s entre tentativas). Um bot que apagasse a sessão depois de N falhas pediria um pareamento
manual a cada instabilidade de rede ([ADR 0041](../adr/0041-queda-de-rede-nao-limpa-sessao.md)).

As credenciais só são apagadas quando a própria plataforma diz que elas não valem mais:

| Motivo | O que o bot faz |
| --- | --- |
| Logout (desconectado pelo celular) | Apaga as credenciais e começa um pareamento novo |
| QRs demais sem ninguém parear | Recomeça o pareamento do zero |
| Credencial recusada num transport **sem** pareamento (token inválido) | Para, com log em `fatal`: ninguém pode parear, alguém precisa corrigir a config |
| Erro de configuração (`fatal`: porta ocupada, permissão) | Para, com log em `fatal` |
| Outra conexão assumiu a sessão (`replaced`) | Para, com log em `error`, em vez de dois processos se derrubarem em laço |

Enquanto a conexão está caída, a fila de saída pausa e segura as respostas por até 60 s; depois
disso elas rejeitam, e o bot segue tentando reconectar
([ADR 0035](../adr/0035-fila-de-saida-e-conexao.md), [ADR 0064](../adr/0064-desconexao-fatal-e-transport-sem-pareamento.md)).
O que fazer em produção está em [Rodar em produção → Re-pareamento](/usebridger/comecando/producao/#re-pareamento).

## Vários bots e vários processos

**Vários números no mesmo processo: sim.** Cada `createBot` é uma instância isolada, com roteador,
filas, scheduler e logger próprios. Vários bots podem dividir a **mesma instância** de storage e de
HTTP, uma sessão cada. É também o caminho para atender várias plataformas: um bot por transport,
porque capabilities, fila de saída e reconexão são de um transport só
([ADR 0071](../adr/0071-varios-bots-e-escopo-compartilhado.md)).

```ts
const storage = sqlite({ path: 'data/bot.db' });
const zap = createBot({ session: 'whatsapp', transport: baileys(), storage, plugins });
const site = createBot({ session: 'site', transport: web({ auth }), storage, http, plugins });
await Promise.all([zap.start(), site.start()]);
```

Os dados de cada bot ficam na própria sessão. O plugin que quer um dado comum a todos usa
`ctx.storage.shared`, que é dele em qualquer sessão
([Plugins → dados](plugins.md#onde-guardar-dados)).

**A mesma sessão em vários processos: não.** Dois processos no mesmo número responderiam em dobro
(o Discord aceita o mesmo token em vários gateways; o web não derruba a conexão antiga). No
`start()`, o bot trava a sessão no storage por 30 s e renova a trava a cada 10 s. Um segundo
processo espera até 30 s e falha sem conectar; um restart logo depois de um crash sobe sozinho,
quando a trava velha vence ([ADR 0070](../adr/0070-trava-de-sessao-entre-processos.md)).

Isso limita a escala de **um** número a um processo, de propósito: a fila de entrada que mantém a
ordem das mensagens de um chat e a fila de saída que controla o ritmo anti-ban vivem em memória.
Dividi-las entre processos exigiria coordenação distribuída para resolver um problema que um
processo resolve com folga (veja as [metas de performance](operacao.md#métricas-de-performance)).

## SQLite ou Postgres

Os dois implementam o mesmo `StoragePort` e passam pela mesma suíte de contrato, então trocar de
um para o outro não muda nenhum plugin ([ADR 0012](../adr/0012-storage-port-sqlite-postgres.md)).

- **SQLite** é o padrão: um arquivo, nenhum serviço para operar, backup é copiar o arquivo. Usa o
  `node:sqlite` embutido no Node 24, sem dependência nativa
  ([ADR 0047](../adr/0047-sqlite-via-node-sqlite.md)). Serve à grande maioria dos bots, inclusive
  com vários números no mesmo processo.
- **Postgres** entra quando o banco precisa viver fora da máquina do bot: processos em máquinas
  diferentes (um por número) dividindo um banco, backup e réplica gerenciados, ou outros sistemas
  lendo os dados. As tabelas ficam num schema próprio (`bridger`), os documentos em `jsonb`, e as
  migrations rodam no boot sob um advisory lock
  ([ADR 0074](../adr/0074-postgres-via-pg.md)).

Não há migração automática de dados de um para o outro.

## HTTP

O core tem **um servidor HTTP por processo**, criado com `createHttp({ port })` e passado a todos
os bots, como o storage. A porta só abre se alguém registrar uma rota. Os caminhos são fixos por
dono: `/plugins/<nome>/...` para os plugins, `/transports/<nome>/...` para os transports (o chat
do transport web, webhooks), e `/sessions/<sessão>/...` na frente nas sessões que não são a
`default`. Há também `/health`, que responde 200 com todas as sessões rodando e 503 senão
([ADR 0018](../adr/0018-http-unico-hono.md), [ADR 0072](../adr/0072-http-do-core.md)).

Um plugin registra rota com `ctx.http.route(method, path, handler)`, com `Request` e `Response`
da Web API; o Hono por baixo é detalhe interno. Detalhes em [HTTP](../../packages/core/docs/http.md).

### Por que o kernel não tem autenticação

O kernel não autentica rota nenhuma, porque não há um esquema que sirva a todos: o webhook de uma
plataforma confere uma assinatura dela, o painel quer sessão de login, a integração com o ERP usa
o token do ERP. Um esquema embutido seria o errado para a maioria e daria uma falsa sensação de
proteção para o resto.

Então cada handler confere a própria credencial e recusa com 401 antes de fazer qualquer coisa.
Na prática:

- guarde o token ou o segredo do webhook como campo `secret` da config do plugin
  ([Configuração](configuracao.md#segredos));
- não exponha a porta do bot direto na internet: ponha um proxy reverso na frente (TLS, limite de
  taxa e, se quiser, autenticação de borda), e deixe aberto só o que precisa ser público;
- o `/health` não traz dado sensível (só o estado das sessões), então pode ficar acessível ao
  supervisor.

O transport web é o exemplo: ele aceita a conexão do chat só com um JWT assinado pelo seu sistema
([ADR 0073](../adr/0073-transport-web.md)).
