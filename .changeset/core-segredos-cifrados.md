---
"@usebridger/core": minor
---

Segredos cifrados no storage, editáveis em runtime (ADR 0121). Nova camada `secret` (`env > arquivo > secret > override > default`), cifrada com AES-256-GCM pela chave `BRIDGER_SECRET_KEY` (32 bytes em base64; `BRIDGER_SECRET_KEY_PREVIOUS` migra os envelopes no boot, na rotação). `bot.config` e `ctx.admin.config` ganham `setSecret(plugin, path, value)`, `clearSecret(plugin, path)` e `secretsWritable`. `ConfigSource` ganha `'secret'`, `PluginConfigIssue.kind` ganha `'shadowed'` e `'undecryptable'`, e o JSON Schema marca o campo secreto com `x-bridger-set-secret: true` quando há chave mestra. `maskedJsonSchema` aceita `secretsWritable` como 2º argumento. `setSecret` e `clearSecret` sobre plugin desligado gravam e pulam o reload (devolvem `undefined`); o plugin lê o valor ao ser ligado.
