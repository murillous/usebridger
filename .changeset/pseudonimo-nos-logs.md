---
"@usebridger/core": minor
---

Pseudônimo estável do usuário nos logs (ADR 0119, #231). **Muda o valor de `chat` e `sender`.**

- **`chat` e `sender`** de toda linha do bot (core, transports, plugins, sinal `log`) saem como pseudônimo `u_…`/`g_…` (HMAC-SHA256 truncado em 16 bytes), com chave derivada por HKDF da `BRIDGER_SECRET_KEY`. O mesmo id dá o mesmo pseudônimo entre restarts; trocar a chave mestra muda todos. Sem a chave, vale só até o restart e o bot loga `bot.pseudonym.ephemeral`. Quem filtrava logs pelo id cru precisa buscar pelo pseudônimo.
- **`ctx.pseudonym(id, kind?)`** para o plugin logar algo do usuário sem expor o id.
- **Redação de reserva** no `createLogger`: JID (`@s.whatsapp.net`, `@g.us`, `@lid`) e telefone que escaparem em campo, mensagem ou `err` saem como `[REDACTED]`. Exporta `isPersonalId` e `redactPersonalIds`.
- **CLI `bridger-pseudonym [--group] <id>`** calcula o pseudônimo de um id com a `BRIDGER_SECRET_KEY` do ambiente.
