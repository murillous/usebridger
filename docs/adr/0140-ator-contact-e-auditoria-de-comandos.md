# ADR 0140 — Remetente como ator `contact` da auditoria e `kernel.command.*` para papel restrito

**Status:** Aceito (2026-11-17) · Issue #339 · Altera em parte o [ADR 0122](0122-log-de-auditoria-no-kernel.md)
(tabela de ator) · Depende do [ADR 0119](0119-pseudonimo-estavel-nos-logs.md) (pseudônimo)

## Contexto

O ADR 0122 prevê quatro atores: `system`, `plugin`, `user` e `contact`. Só os três primeiros
eram preenchidos. O único chamador de `runAsAuditSubject` era o guard HTTP, que põe um `user`.
Nada no fluxo de mensagem punha o remetente no escopo. Por isso todo `ctx.audit.record` feito a
partir de uma mensagem saía com `actor: plugin`. O plugin não escolhe o ator (de propósito), então
cada app guardava quem pediu numa chave própria de `details` (`contact`, `actor`, `sender`). O
campo indexado, `actor`, saía errado, e o filtro `actorKind: 'contact'` da API nunca casava.

O core também não auditava a execução de comando com papel restrito. O roteador conhece o papel e
o motivo da recusa (`CommandRejection.reason`), mas o evento `command` não leva nenhum dos dois.
Um plugin de app que assina `command` para auditar comandos de owner tem os problemas que o
ADR 0122 usou para descartar o `plugin-audit`: some com o plugin desligado, ocupa um nome de plugin
(`command`) para ter o prefixo da ação, e lê o papel depois do fato, quando o dono do comando pode
já ter sido desligado.

## Opções consideradas

**Quem é o titular no fluxo de mensagem.**

1. **O remetente, para tudo o que a mensagem dispara — recomendada.** O fluxo de entrada roda
   middleware, comando, passo, botão e listeners de `message` dentro de `runAsAuditSubject`. O
   `run` em segundo plano herda o escopo pelo `AsyncLocalStorage`.
2. Só o comando. Descartada: o passo de conversa e o listener de `message` também agem a pedido
   do remetente, e o ator deles continuaria errado.

**Id do contato.**

1. **Pseudônimo (ADR 0119) — recomendada.** A auditoria guarda o mesmo pseudônimo dos logs, e o
   `kernel.pseudonym.resolve` (ADR 0132) o desfaz quando preciso, auditado.
2. Id cru. Descartada: o log de auditoria vive anos e vai a exportação; o id cru é o telefone.

**Onde nasce o `kernel.command.*`.**

1. **Gancho do roteador (`onRestricted`) que o bot liga à auditoria — recomendada.** O roteador
   avisa no ponto da decisão (recusa pelo papel, antes do `onReject`) e no fim do `run`, com o
   papel da definição no dispatch. O roteador não depende da auditoria; a política (quais papéis
   entram, alvo, `details`) fica no bot.
2. No fluxo de entrada, a partir do `DispatchResult`. Descartada: o resultado não traz o papel, e
   uma recusa por papel cujo `onReject` lança chega como `failed`, indistinguível de um `run` que
   falhou.

**Quais papéis.**

1. **`owner` e papel custom — recomendada.** São os papéis de autorização de verdade.
2. Também `group-admin`. Descartada por ora: é o papel do dia a dia do grupo (`!prefixo`), encheria
   a cadeia de ruído. Pode virar opt-in se aparecer quem precise.

## Decisão

### Ator `contact`

O fluxo de entrada (`admit` em `bot/inbound-flow.ts`) roda o tratamento de cada mensagem, edição,
clique e comando nativo com `actor: { kind: 'contact', transport, id: <pseudônimo do remetente> }`.
O `ctx.audit.record` do plugin sai com esse ator e `via: <plugin>`, como o `user` no HTTP. O
remetente marcado como bot (`isBot`) entra como `contact` também: é quem mandou a mensagem (e o
`ignoreBots`, ligado por padrão, já o barra antes).

Ficam sem titular, como antes: o boot, o `setup`, o job do scheduler (o loop roda no contexto de
quem criou o serviço, mesmo para job agendado por um comando) e o `onExpire` de um passo, que
dispara pelo relógio e não por uma mensagem.

Tabela de ator do ADR 0122, atualizada:

| Contexto | Ator |
| --- | --- |
| core: boot, stop, job, expurgação | `system` |
| `record` de um plugin sem titular no escopo (boot, `setup`, job, `onExpire`) | `plugin` |
| tratamento de uma mensagem (middleware, comando, passo, botão, listener) | `contact` (e `via`) |
| request HTTP autenticado | `user` (e `via`) |

### `kernel.command.*`

O core grava, para comando com papel `owner` ou custom:

| Ação | Quando | `outcome` |
| --- | --- | --- |
| `kernel.command.run` | o `run` terminou | `success` ou `error` |
| `kernel.command.denied` | recusado pelo papel | `denied` |

- Ator: o contato. Alvo: `{ type: 'chat', id }`, com o pseudônimo quando a conversa é privada (o
  id do chat é o da pessoa) e o id do grupo quando é grupo.
- `details: { plugin, command, invokedAs, role }`. Nunca os argumentos: podem carregar texto do
  usuário (senha, chave).
- Recusa por `accepts` não entra: não é decisão de autorização.
- O passo de conversa de um comando restrito não gera `kernel.command.*`. O que o passo gravar já
  sai com o ator `contact`; um `kernel.command.step` fica para quando houver quem precise.

## Consequências

- Mudança de comportamento: eventos que saíam com `actor: plugin` a partir de uma mensagem passam
  a sair com `contact` e `via`. Quem filtrava por `actorId = <plugin>` filtra por `via` (vai no
  changeset).
- O app tira o ator de `details` e o plugin próprio de auditoria de comandos de owner.
- O `onRestricted` que lança vai ao log (`command.audit.failed`) e não muda o resultado do
  comando.
