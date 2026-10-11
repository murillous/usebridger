---
'@usebridger/core': minor
---

Placeholders nas `messages` do plugin: `c.t('chave', { count: 2 })` no comando, no passo e no listener de mensagem preenche `{count}` e o `{prefix}` do chat. A sobrescrita pela config só pode usar os placeholders do texto padrão, mais `{prefix}`; um placeholder novo é `PluginConfigError` (ADR 0092).
