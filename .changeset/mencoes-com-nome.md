---
'@usebridger/transport-baileys': minor
---

Menções com nome e tag (#109): cada item de `mentions` traz `tag` (o `@usuário` literal do texto, calculado pela mesma função que escreve a menção de saída) e `name` quando o contato já foi visto. O cache de nomes trata LID e telefone da mesma pessoa como apelidos e passa a aprender também com `contacts.upsert`, `contacts.update` e `messaging-history.set` (prioridade `notify`, `verifiedName`, depois o nome da agenda), emitindo `contact.updated` para nomes novos. Contato nunca visto segue com `name: null`; o cache é em memória.
