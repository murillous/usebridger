# ADR 0131 — Plugins e config pela API: rotas do core sob `/api/plugins/{name}`, máscara de segredo e caminhos reservados

**Status:** Aceito (2026-10-27) · Detalha o **D125**
([ADR 0125](0125-api-http-do-core-e-dashboard-cliente.md)) (área plugins e config) · Complementa o
**D126** ([ADR 0126](0126-rotas-da-api-de-plugin-sob-api-plugins.md)) · Usa o **D117**
([ADR 0117](0117-segredos-cifrados-editaveis-pelo-dashboard.md))

## Contexto

Listar plugins, ligar e desligar e editar a config com segredos eram rotas do `plugin-dashboard`
(#277). O ADR 0125 as traz para a API do core. Três pontos ficavam em aberto:

- **Colisão de caminho.** As operações de plugin vivem em `/api/plugins/<nome>/...` (ADR 0126), e a
  issue põe as do core em `/api/plugins/{name}/config`, `/enable` e `/disable`. O core monta antes;
  a operação de um plugin no mesmo caminho ficaria sombreada sem aviso.
- **Segredo num formulário.** O `GET` devolve o segredo mascarado. Quem edita o resto do formulário
  devolve a máscara, e ela não pode virar o valor. O `setOverrides` recusa segredo, que o storage
  guardaria em texto puro; o segredo só se grava cifrado, pelo `setSecret`.
- **Ler a lista.** Só `plugins.manage` existia, e o `viewer` não veria os plugins.

Alternativas consideradas:

- **Rotas do core em outro prefixo** (`/api/admin/plugins/...`): sem colisão, mas o recurso
  `plugins` teria dois endereços, um do core e outro dos plugins, e a issue fixa o caminho.
- **Segredo por rota própria** (`PUT .../secrets/{path}`, como no dashboard): o cliente faz uma
  chamada por campo e trata a máscara à parte; o formulário gerado do JSON Schema deixa de ser um
  `PUT` só.
- **Escrita atômica nova no `PluginConfigs`** (overrides e segredos de uma vez, um reload só):
  duplicaria as checagens do `setSecret` (campo sombreado, chave mestra) num caso que hoje é raro.

## Decisão

- **Rotas**, montadas por sessão a partir do bot, como as de conexão (ADR 0129):
  - `GET /plugins` (`plugins.read`): `bootedAt` e a tabela de boot. O motivo do `skipped` sai como
    `{ kind, message }`, em texto censurado pelos segredos conhecidos, nunca o erro com `cause`.
  - `POST /plugins/{name}/enable` e `/disable` (`plugins.manage`): o plugin e os dependentes.
  - `GET /plugins/{name}/config` (`config.read`): `view` (config com segredos em `********`,
    `messages` e a fonte de cada campo), `schema` (JSON Schema da entrada), `secretsWritable`. Com
    a config atual inválida, `view: null` e `issues`.
  - `PUT /plugins/{name}/config` (`config.write`): o corpo substitui os overrides. Campo `secret`
    com a máscara, ou ausente, mantém o valor; com outro valor é segredo novo, cifrado pelo
    `setSecret`, e exige `secrets.write`. Os segredos saem dos overrides antes de gravar.
- **Permissão `plugins.read`** no core; o `viewer` a recebe, como toda `.read`.
- **Erros**: config recusada é 400 com `errors` (`path` do campo, `code` = `kind` do core); campo
  decidido pelo env ou pelo arquivo (`shadowed`) é 409; plugin desconhecido é 404; estado do host
  ou do bot que não permite a ação é 409.
- **Auditoria** pelo `bot.plugins`/`bot.config`, que já gravam `kernel.plugin.*`,
  `kernel.config.update` (diff mascarado) e `kernel.secret.update` (só o caminho). O ator é o da
  requisição (ADR 0127).
- **Caminhos reservados**: `ctx.http.api` lança `BotConfigError` para operação de plugin cujo
  primeiro segmento é `config`, `enable` ou `disable`.

## Consequências

- Um app edita a config inteira de um plugin num `PUT`, com o formulário gerado do JSON Schema.
- shortcut: o `PUT` não é atômico entre segredos e overrides. Grava os segredos primeiro (um
  override que só valida com o segredo novo passa) e depois os overrides; um override inválido
  depois de um segredo gravado deixa o segredo salvo, e cada gravação recarrega o plugin. Uma
  escrita única no `PluginConfigs` resolve se isso incomodar.
- Plugin que já registrava operação em `/config`, `/enable` ou `/disable` falha no `setup`. As
  operações de plugin chegaram no M7-3 e ainda não foram publicadas com esses caminhos.
- O `plugin-dashboard` ainda tem as próprias rotas; elas saem quando ele virar cliente da API
  (ADR 0125).
