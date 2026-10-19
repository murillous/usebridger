# ADR 0111 — Status do bot no contexto: no ar desde, reconexões, expiração do QR e nome

**Status:** Aceito (2026-10-17) · Complementa **D106** ([ADR 0106](0106-sessao-e-status-de-conexao-no-contexto.md)) ·
Resolve lacunas do dashboard (**D104**) conforme o [ADR 0026](0026-open-core-repo-privado.md)

## Contexto

O card do bot na Visão geral do dashboard precisa de "No ar desde", Reconexões e "Expira em" do
QR, e o cabeçalho precisa do nome do bot (`luma · sessão default`) em vez do transport. O core
só entregava o último `ConnectionStatus` (ADR 0106); reconstruir contagem e horários só pelo
barramento falha no reload do plugin, pelo mesmo motivo do 0106.

## Decisão

- **`ctx.connectionInfo()`**: `{ connectedSince, reconnections, qrExpiresAt }`, todos
  `number | undefined` exceto `reconnections` (`number`). O core o atualiza no mesmo ponto do
  `recordStatus` (`transport-entry`).
  - `connectedSince`: ms epoch da abertura da conexão atual; `undefined` fora do ar. Um `open`
    repetido sem queda não o muda.
  - `reconnections`: aberturas depois da primeira; vale desde o boot do bot e não zera em
    reload de plugin.
  - `qrExpiresAt`: expiração do QR atual; limpo ao abrir ou cair.
- **`connection.qr` ganha `expiresAt?: number`** (ms epoch, opcional): só o transport sabe
  quando o QR morre. O Baileys o preenche (60 s o primeiro, 20 s os seguintes); sem o campo,
  `qrExpiresAt` fica `undefined` e a tela não mostra "Expira em". Mudança aditiva.
- **`BotConfig.name?: string`** e **`ctx.botName`**: rótulo de exibição do bot (`luma`). Só
  rótulo, não entra em storage nem chave (a identidade continua sendo a `session`). Sem config,
  o fallback é o `Transport.name`.
- O dashboard expõe `name`, `connectedSince`, `reconnections` e `qrExpiresAt` no `StatusView`
  (`GET /api/status`, snapshot e evento `qr` do WS). O cabeçalho mostra `name · sessão X`.

## Consequências

- Campos novos no `PluginContext` e no payload de `connection.qr` são minor; mocks do contexto
  fora do core passam a precisar de `connectionInfo` e `botName`.
- Não cobre a lista de sessões nem a fila de saída (fora do escopo, seguem como no 0106).
- Custo: um contador e dois números por bot.
