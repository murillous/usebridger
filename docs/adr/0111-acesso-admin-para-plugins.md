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

- `PluginContext.admin: PluginAdmin | undefined`, com `PluginAdmin = { plugins, config }`:
  delega às instâncias de `bot.plugins` (`BotPlugins`) e `bot.config` (`BotPluginConfigs`), sem
  reimplementação da lógica. Só duas diferenças: a recusa sobre si mesmo (abaixo) e o `live`.
- `reload`/`disable`/`enable` e `setOverrides` passam pelo `live` do contexto (ADR 0033): depois
  do `dispose` (setup que estourou o prazo, plugin admin desligado) rejeitam com
  `ContextExpiredError`. As leituras (`plugins()`, `describe`, `jsonSchema`) ficam livres.
- Só os plugins em `createBot({ adminPlugins })` recebem o objeto; os demais, `undefined`. Nome
  que não existe entre os plugins gera `warn` no boot, como `disabledPlugins`.
- `admin.plugins.reload`/`disable` e `admin.config.setOverrides` sobre o próprio plugin rejeitam
  com `PluginHostStateError`: ele desceria no meio da própria chamada (`setOverrides` recarrega).
  `enable` e as leituras não têm restrição. O resto segue o comportamento de `bot.plugins` e
  `bot.config`.
- Tudo o que sai pelo `ctx.admin` (retornos e erros rejeitados) é uma cópia com os segredos do
  bot trocados por `[REDACTED]`, os mesmos que o logger censura: uma mensagem como
  "invalid key sk-…" de um `setup` ou de uma issue de config não chega crua ao cliente do
  dashboard. O `Error` copiado mantém o protótipo (`instanceof` vale; `Error.isError(copia)` dá
  `false`) e os campos próprios (`cause`, `issues`, `detail`, `stack` censurado). Getters e
  `toJSON` do protótipo viram campos de dado já censurados (ou são omitidos se lançam), então
  `#privado` não quebra a serialização. `Map`/`Set` são recriados e instância de outra classe vira
  objeto simples com as propriedades próprias; caixas `String`/`Number`/`Boolean` viram o
  primitivo; objeto ilegível (Proxy que lança) vira `'[unreadable]'`; nada devolve a referência
  original. Chaves `Symbol` são descartadas. A
  máscara fica no `ctx.admin`; `bot.plugins`/`bot.config` não mudam. Foi escolhida em vez de
  expor um `redact`, para o consumidor não precisar lembrar de chamá-lo.
- `PluginConfigIssue` ganha `kind: 'secret' | 'invalid'`, para o dashboard distinguir a recusa de
  override secreto da validação sem ler o texto.

## Consequências

- Não dê `await` em ação de admin dentro do próprio `setup`/`teardown`: a fila do host roda uma
  operação por vez, então o plugin trava até o prazo e cai como `setup-failed`. Use as ações a
  partir de comandos, rotas e jobs.
- Campo novo no `PluginContext` é minor; mocks de contexto fora do core passam a exigir `admin`.
- Plugin em `adminPlugins` tem poder sobre todos os outros: a lista é parte da config de
  confiança do app.
- O plugin ainda pode derrubar a si mesmo indiretamente (ex.: via dependente); a recusa cobre só
  a chamada direta.
