# ADR 0111 — Acesso admin para plugins autorizados

**Status:** Aceito (2026-10-17) · Detalha **D107** ([ADR 0107](0107-plugins-oficiais-de-metricas-e-dashboard.md)) ·
Usado pelo dashboard (**D108**, [ADR 0108](0108-abas-do-dashboard-por-ponto-de-extensao.md))

## Contexto

O dashboard precisa listar a tabela de plugins, ligar, desligar e recarregar plugins e editar a
config deles. Isso existe no core (`bot.plugins`, `bot.config`), mas o `PluginContext` não o
expõe, e um plugin não tem acesso ao objeto `Bot`. É um poder alto (derrubar qualquer plugin,
gravar override de config), que não pode ir a todo plugin.

## Opções consideradas

- **Allowlist no `createBot`** (`adminPlugins`) — **escolhida** pelo dono do repositório. Quem
  decide é o app, que já escolhe quais plugins carregar.
- **Campo no manifesto do plugin** — rejeitada: o plugin se autoconcederia o poder, e instalar
  um pacote de terceiros bastaria para obtê-lo.
- **Para todos os plugins** — rejeitada: qualquer plugin poderia desligar os demais.

## Decisão

- `PluginContext.admin: PluginAdmin | undefined`, com `PluginAdmin = { plugins, config }`: as
  mesmas instâncias de `bot.plugins` (`BotPlugins`) e `bot.config` (`BotPluginConfigs`), sem
  reimplementação.
- Só os plugins em `createBot({ adminPlugins })` recebem o objeto; os demais, `undefined`. Nome
  que não existe entre os plugins gera `warn` no boot, como `disabledPlugins`.
- `admin.plugins.reload`/`disable` e `admin.config.setOverrides` sobre o próprio plugin rejeitam
  com `PluginHostStateError`: ele desceria no meio da própria chamada (`setOverrides` recarrega).
  `enable` e as leituras não têm restrição. O resto segue o comportamento de `bot.plugins` e
  `bot.config`.

## Consequências

- Campo novo no `PluginContext` é minor; mocks de contexto fora do core passam a exigir `admin`.
- Plugin em `adminPlugins` tem poder sobre todos os outros: a lista é parte da config de
  confiança do app.
- O plugin ainda pode derrubar a si mesmo indiretamente (ex.: via dependente); a recusa cobre só
  a chamada direta.
