---
'@usebridger/transport-baileys': minor
---

Os nomes de contatos que dão nome às menções, reações, votos e apagamentos agora persistem no auth state da sessão e sobrevivem ao restart. A leitura é lazy (só quando a memória não sabe o nome, com cache negativo) e a escrita é em lote com debounce, então o storage fica fora do caminho de cada mensagem. O logout apaga os nomes junto com as credenciais.
