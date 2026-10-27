# ADR 0132 — Pseudônimo de volta ao id pela API, com mapa cifrado e consulta auditada

**Status:** Aceito (2026-10-27) · Substitui em parte o **D119**
([ADR 0119](0119-pseudonimo-estavel-nos-logs.md)) (a conversão "só do id ao pseudônimo") · Usa a
cifra do **D117** ([ADR 0117](0117-segredos-cifrados-editaveis-pelo-dashboard.md)), a auth do
**D127** ([ADR 0127](0127-base-da-autenticacao-da-api.md)) e a auditoria do **D122**
([ADR 0122](0122-log-de-auditoria-no-kernel.md))

## Contexto

O ADR 0119 tirou telefone e JID dos logs: `chat` e `sender` saem como pseudônimo, um HMAC que não
volta ao id. O caminho só ia do telefone ao pseudônimo (`bridger-pseudonym`). Para quem opera o bot
numa empresa, a pergunta comum é a contrária: o log mostra que `u_7Hq2…` disparou uma ação, e é
preciso saber quem é. O ADR 0119 já deixava essa ação para depois da auth da API (#223), atrás de
permissão e com auditoria.

Alternativas consideradas:

- **Opção para desligar o pseudônimo** (`chat` em claro no log): simples, mas espalha dado pessoal
  no Loki de quem desligar, com a retenção e o acesso do Loki, que o core não controla.
- **Remover o pseudônimo:** desfaz a decisão de LGPD do ADR 0119 para todo app.
- **Força bruta pelos contatos conhecidos** (calcular o pseudônimo de cada id e comparar): exige
  uma lista de contatos que o core não tem por transport, e não acha quem só apareceu no log.

## Decisão

- **Mapa reverso cifrado.** Cada pseudônimo calculado com a chave mestra (logger, `ctx.pseudonym`)
  grava `pseudônimo → id` no KV do kernel `$pseudonyms`, no escopo da sessão, o id em envelope AES-GCM com a
  `BRIDGER_SECRET_KEY` (o mesmo do ADR 0117), com AAD `pseudonym:<pseudônimo>`. A gravação não
  bloqueia o log: sai em segundo plano, uma vez por pseudônimo no processo (cache de até 10 mil;
  passou, recomeça, e regravar é idempotente). Falha vira `bot.pseudonym.map-failed` (`warn`) e o
  par é tentado de novo no próximo cálculo.
- **Sem chave mestra, sem mapa.** O pseudônimo é efêmero (ADR 0119) e não vale guardar; a rota
  responde 409.
- **Rotação.** A chave nova muda os pseudônimos (ADR 0119) e grava pares novos. Os antigos
  continuam resolvendo enquanto a chave anterior estiver em `BRIDGER_SECRET_KEY_PREVIOUS`.
- **Rota** `GET /api/pseudonyms/{pseudonym}` → `{ pseudonym, kind, id }`. Permissão
  `pseudonyms.resolve`: owner e admin a têm; o viewer não, porque não termina em `.read`. Formato
  inválido é 400; desconhecido é 404.
- **Auditoria de toda consulta**, achando ou não: `kernel.pseudonym.resolve`, com o ator da
  requisição, alvo `{ type: 'pseudonym', id }` e `details: { found }`. O id não entra no evento.

## Consequências

- Quem investiga vai do log ao contato sem que o log carregue telefone, e cada descoberta fica
  registrada com quem a fez.
- O storage passa a guardar, cifrado, um id por contato que apareceu no log. Quem tem o banco e a
  `BRIDGER_SECRET_KEY` chega aos ids, o mesmo nível de proteção dos segredos de plugin.
- shortcut: o mapa não expira nem é apagado por contato. O pedido de exclusão do titular (#225)
  precisa remover a entrada dele, e uma retenção (como a da auditoria) fica para quando a base
  crescer.
- O `config.logger` próprio do app continua recebendo só o pseudônimo; o mapa vem do cálculo, não
  do logger.
