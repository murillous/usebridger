---
"@usebridger/core": minor
---

Contrato de log estruturado (ADR 0118, #230). **Quebra de API antes do 1.0.**

- **Formato da linha:** `level` em texto (`"info"`, `"error"`) e `time` em ISO 8601 UTC, no lugar do número do pino e do epoch ms. `pid` e `hostname` saem. Quem parseia o JSON atual precisa se ajustar.
- **`log.event(evento, campos?)`** e **`defineLogEvent({ name, level, message })`**: o evento fixa o nível e a mensagem, e a linha sai com o campo `event` (`command.timeout`, `connection.closed`), estável para filtro e alerta. O nome segue `<área>.<coisa>.<verbo>` em kebab-case; fora disso, `defineLogEvent` lança. `log.<nível>(mensagem, campos)` continua valendo. **Quebra:** `event` é método obrigatório de `Logger`, então um `config.logger` próprio ou um fake de teste precisa implementá-lo.
- **Todas as linhas do core** saem por evento, com mensagem fixa e os valores em campos. A lista está em `docs/log-events.md`; evento novo é minor, renomear ou remover quebra. A tabela de boot vai no campo `report` dos eventos `plugin.boot.report`/`plugin.boot.review`.
- **Bindings base:** toda linha do bot leva `bot` (a `session`); `createBot({ logBindings })` acrescenta `service`, `version` e `env`.
- **Dicionário de campos tipado** (`StandardLogFields`): `err`, `plugin`, `transport`, `chat`, `sender`, `messageId`, `command`, `step`, `role`, `route`, `status`, `reason`, `durationMs`, `trace`. **Quebra:** o binding por mensagem `chatId` passa a `chat` (também no sinal `log`), `senderId` a `sender`, e o nome do evento do barramento ou do transport, que ia em `event`, passa a `eventName`.
- **`pretty`:** esconde o `event` e os bindings base, e põe texto de várias linhas (a tabela de boot) abaixo da linha.
- Exportados: `defineLogEvent` e os tipos `LogEvent`, `LogEventName`, `EmitLevel` e `StandardLogFields`.
