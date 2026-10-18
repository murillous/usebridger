# ADR 0114 — Duração do setup, contagem por ponto e horário do boot no report de plugins

**Status:** Aceito (2026-10-17) · Complementa **D112**
([ADR 0112](0112-tabela-de-plugins-com-dependencias-servicos-e-contribuicoes.md)) · Usa **D111**
([ADR 0111](0111-acesso-admin-para-plugins.md)) e **D99** ([ADR 0099](0099-dependencias-opcionais-e-servicos-por-comando.md))

## Contexto

A tela Plugins do dashboard (#180) ainda tinha lacunas que só o core resolve (ADR 0029): a duração
do `setup`, a contagem por ponto de extensão (`dashboard.tabs ×5`), o horário real do boot e o
`optionalDependsOn`, que o reload em cascata do core segue (ADR 0099) e o aviso "Salvar recarrega
X e N dependentes" da Config contava a menos.

## Decisão

- `PluginReportEntry` ganha `optionalDependsOn` (manifesto, só quando há) e, nas linhas
  `loaded`, `contributionCounts` (ponto → nº de contribuições do plugin), junto de `contributions`.
- A duração do contexto + `setup` e o horário do boot **não** entram na linha: a linha do plugin
  sem nada a dizer é comparada por igualdade em testes e por quem consome a tabela, e um número que
  varia a cada execução a quebraria. Vão em `bot.plugins` (e, igual, em `ctx.admin.plugins`):
  `setupDurations()` (nome → ms, só de plugin carregado; a do boot ou a do último reload) e
  `bootedAt` (epoch ms do fim do boot dos plugins; `undefined` antes do `start()`; reload não o
  muda). O host mede com `performance.now()`.
- O dashboard junta `setupMs` à linha de `GET /api/plugins`. `GET /api/plugins/boot` fica: a lista
  é um array puro, sem lugar para o horário; a rota agora só repassa o valor do core, em vez do
  horário do `setup` do dashboard (que reiniciava no reload em cascata).
- `dependentsOf` do web segue `dependsOn` e `optionalDependsOn`, como o core.

## Consequências

- Mudança aditiva; a tabela de boot em texto não muda.
- Plugin recarregado tem `setupDurations` novo; plugin desligado ou que falhou não tem.
