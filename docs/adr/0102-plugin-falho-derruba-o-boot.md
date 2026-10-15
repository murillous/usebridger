# ADR 0102 — Plugin incompatível ou com `setup` falho derruba o boot

**Status:** Aceito (2026-10-15) · Substitui em parte **D10** ([ADR 0010](0010-capabilities-do-transporte.md)),
**D16** ([ADR 0016](0016-manifesto-do-plugin.md)), **D32** ([ADR 0032](0032-camadas-da-config-de-plugin.md))
e **D41** ([ADR 0041](0041-reload-em-cascata.md)) · Segue **D90**
([ADR 0090](0090-requires-por-comando.md)) e **D99** ([ADR 0099](0099-comando-que-exige-servico.md))

## Contexto

Até aqui, o plugin que não podia carregar não derrubava o boot: o loader o marcava `skipped`,
logava a tabela de boot em `warn` e o bot subia sem ele e sem quem dependia dele. Os motivos eram
`engine`, `transport`, `capabilities`, `dependency-missing`, `dependency-version`,
`dependency-skipped` e `setup-failed` (que inclui config inválida, ADR 0032). Só o manifesto
inválido, o nome repetido, o ciclo e o conflito de comando, papel ou serviço derrubavam o boot.

Na prática, um plugin com dependência ausente, `engine` desatualizado ou `setup` quebrado passava
despercebido em produção. O bot ficava "no ar", mas os comandos daquele plugin não existiam, e o
único sinal era uma linha de `warn` no meio do log de boot. Falhar cedo e alto é mais seguro do que
subir um bot pela metade.

Alternativas consideradas:

- **Manter o modo tolerante e subir o nível do log para `error`.** Continua sendo um bot pela
  metade, e quem olha só o processo (`systemd`, healthcheck) não vê nada.
- **Flag de modo tolerante (ex.: em dev).** Sem caso real hoje. O operador já tem
  `disabledPlugins` para subir sem um plugin de propósito.
- **Abortar no primeiro plugin falho.** Quem corrige teria que reiniciar uma vez por problema.

## Decisão

- **No boot, todo plugin que não carrega derruba o boot, exceto `disabled`.** Isso vale para
  `engine`, `transport`, `capabilities`, `dependency-missing`, `dependency-version`,
  `dependency-skipped` e `setup-failed` (inclusive timeout, falha da fábrica de contexto e config
  inválida). `disabled` é escolha explícita do operador e continua só na tabela.
- **Primeiro o estático, depois os `setup`s.** O host avalia as incompatibilidades de todos os
  plugins, em ordem topológica, antes de criar qualquer contexto. Se alguma derruba o boot, nenhum
  `setup` roda. Senão, roda os `setup`s de todos, mesmo depois de uma falha, para reportar todas
  de uma vez. Em seguida, desce (`teardown` + `dispose`, ordem inversa) quem subiu e rejeita.
- **Erro:** `PluginBootError` (API pública). Ele traz `failures`, as linhas `skipped` que
  derrubam, na ordem de carga, e `plugin`, `version` e `reason` da primeira, que é a raiz, já que
  os dependentes vêm depois. Em `setup-failed`, `cause` é o `PluginLifecycleError`. A mensagem
  lista `nome@versão: motivo` de cada falha (o texto de `describeSkipReason`) e lembra o
  `disabledPlugins`. A tabela só é logada quando os `setup`s rodaram: no aborto estático, ela
  mostraria "carregado" para quem nem chegou ao `setup`.
- **Conflito de nome continua saindo com o próprio erro** (`CommandConflictError`,
  `RoleConflictError`, `ServiceConflictError`; ADR 0007 e 0035). O `Bot` o tira do
  `PluginBootError`, porque ele diz o que colidiu.
- **O `Bot` não conecta o transport.** A rejeição do host cai no caminho de falha do boot que já
  existia: encerra o que subiu, sem chamar `connect()`, e `bot.start()` rejeita.
- **Runtime não muda.** `reload`, `disable` e `enable` com o bot no ar mantêm o comportamento do
  ADR 0041: o `setup` novo que falha ou o plugin ligado que é incompatível vira `skipped`, os
  dependentes por `dependsOn` viram `dependency-skipped`, e o bot segue. Derrubar um processo que
  já atende por causa de um reload pedido pelo dashboard trocaria um plugin fora por um bot fora.
- **O que continua sem derrubar o boot:**
  - o `requires` e o `services` **por comando** (ADR 0090 e 0099): o plugin sobe e só aquele
    comando fica de fora (`unregistered`, `carregado; sem ...` na tabela). A granularidade por
    comando existe para o plugin multiplataforma degradar por comando;
  - o provedor de `optionalDependsOn` ausente ou desligado. O provedor que falha no boot derruba o
    boot por ser ele próprio um plugin falho. Em runtime, o dependente opcional segue sem ele, como
    no ADR 0099.

Para rodar um app com vários transports e um plugin de uma plataforma só, ou sem um plugin cuja
dependência falta, o operador o desliga de propósito com `disabledPlugins`. Quem depende dele por
`dependsOn` também precisa sair da lista, senão vira `dependency-skipped` e derruba o boot.

## Consequências

- Um plugin quebrado aparece no deploy, não semanas depois, quando alguém tenta o comando.
- A tabela de boot deixa de ter linhas "ignorado" no boot que sobe, exceto `disabled`. Fora isso,
  elas só aparecem depois de um `reload`/`enable` em runtime.
- O kit de testes multiplataforma (ADR 0073): o plugin com `requires` de manifesto fora do perfil
  derruba o `createTestBot`. O autor que quer degradar por perfil move o `requires` para o comando.
- O `plugin.error` deixa de ser emitido para a falha de `setup` no boot, porque os listeners já
  desceram junto. A falha fica no log (`error`, com `plugin` e `phase`) e no `PluginBootError`.
- Mudança incompatível: o app que subia com um plugin "ignorado" passa a não subir até corrigir o
  plugin ou listá-lo em `disabledPlugins`.
