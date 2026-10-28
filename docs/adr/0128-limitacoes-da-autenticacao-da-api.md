# ADR 0128 — Limitações da autenticação da API: rate limit persistente, corridas, chaves órfãs e auth padrão

**Status:** Aceito (2026-10-26) · Substitui os trechos "Rate limit ... em memória do processo", "Corridas conhecidas", "A chave sobrevive ao rebaixamento ou desativação do criador" e "Auth opt-in ... Sem ela a API fica aberta" do [ADR 0127](0127-base-da-autenticacao-da-api.md)

## Contexto

A autenticação da API (#223, M7-4) entrou com limitações conhecidas, registradas no ADR 0127 e
marcadas com `shortcut:` no código. A #289 as fecha antes da virada v1.0: o rate limit vive na
memória do processo, há corridas que o storage sem transação entre documentos e sem índice unique
não impede, a API key sobrevive ao criador e a API sobe aberta quando falta `api.auth`.

## Decisão

- **Rate limit persistido**. As contagens de login, aceite de convite e troca de senha ficam no
  storage do bot, namespace `auth`, coleção `rateLimits`, com `Collection.increment` atômico.
  Sobrevivem a restart e valem entre processos que dividem o banco. A chave do documento é um hash
  (sem e-mail nem IP em claro). Janela vencida é zerada ao tocar a chave, e uma varredura, no máximo
  uma vez por janela por processo, apaga os documentos vencidos. O fallback em memória existe só
  sem storage (testes); o bot sempre passa o storage.
- **Corridas** (bootstrap criando dois owners, dois owners se desativando ou rebaixando e zerando os
  owners ativos, e-mail duplicado concorrente): o storage não tem transação entre documentos nem
  índice unique, então as operações tomam uma trava por documento na coleção `auth.locks`:
  `users` (bootstrap, createUser, recoverOwner) e `owners` (desativar e rebaixar).
  - `increment` com `insert` cria o documento da trava uma única vez; a tomada é um CAS por
    `update` condicional em `until`, com lease de 15 s que vence sozinho.
  - Espera de até 5 s; trava ocupada devolve 409 "conta em uso por outra operação".
  - Dentro da trava a regra é revalidada: e-mail repetido e último owner dão 409, e o perdedor do
    bootstrap leva 400 (o token já não vale).
  - Falha ao soltar a trava vai para o log (`auth.lock.release-failed`) sem trocar o resultado.
- **Chaves órfãs**. A permissão efetiva de uma API key é o **escopo da chave ∩ as permissões
  atuais do criador** (`createdBy`). Rebaixar o criador encolhe a chave (403 na operação);
  desativá-lo dá 401; reativar ou repromover restaura, sem recriar a chave.
  - `createdBy: null` (chave criada direto pelo `AuthStore`, sem passar pela API) vale pelo escopo
    próprio.
  - Chave criada por chave segue a cadeia: interseção com o efetivo do pai; pai revogado ou ausente
    dá 401; profundidade máxima 16.
  - A listagem mostra o escopo gravado; o `/auth/me` mostra o efetivo.
  - Substitui "A chave sobrevive ao rebaixamento ou desativação do criador".
- **Auth padrão**. Sem `api.auth`, a API só sobe se o `hostname` do servidor HTTP for loopback.
  A checagem roda no `createBot`, antes do start, e lança `BotConfigError` com mensagem clara.
  Loopback é 127.0.0.0/8, `::1` (inclusive formas equivalentes como `::ffff:127.0.0.1`) e
  `localhost` em qualquer caixa, via `BlockList`/`isIP` do `node:net`. Vale para qualquer servidor
  HTTP aberto, porque a API do core sempre vai junto: quem usa o webhook do transport-web fora de
  loopback precisa de `api.auth` ou de proxy reverso. Substitui "Auth opt-in ... Sem ela a API fica
  aberta".
- **`bridger owner-invite` com o bot no ar** é permitido. É seguro porque o `recoverOwner` da CLI
  toma as mesmas travas `users`/`owners` no storage que o bot, válidas entre processos; a
  atomicidade de cada operação isolada não bastaria. Testes: no SQLite, a CLI real roda em processo
  filho enquanto o bot grava (WAL + `busy_timeout`); no Postgres, dois clientes, e o caso só roda
  com `BRIDGER_TEST_POSTGRES_URL` configurado.

## Consequências

- **Quebra** quem expunha a API aberta (hostname não loopback sem `api.auth`): precisa configurar
  `api.auth`, usar proxy reverso ou voltar para loopback. Changeset `minor` no `@usebridger/core`
  (0.x).
- O rate limit custa escrita no storage a cada tentativa. Aceito: entre processos, no pior caso uma
  falha se perde.
- O lease supõe relógios sincronizados (NTP) e seção crítica bem abaixo de 15 s, sem fencing token.
  Travar custa escritas extras, e depois de uma queda essas rotas podem dar 409 por até ~15 s.
- A chave de um criador desativado para de funcionar sem ser apagada: o efeito é reversível, mas
  "ativa" na listagem depende do criador (por isso o `/auth/me` mostra o efetivo).
- Os `shortcut:` correspondentes saem do código e a doc do COMO acompanha.

## Alternativas descartadas

- **Rate limit em memória**: reinício zera as contagens e vários processos não dividem o limite.
- **Revogar automaticamente as chaves do criador desativado**: irreversível; reativar o usuário não
  traria as chaves de volta.
- **Só sinalizar a chave órfã na listagem**: a chave continuaria valendo.
- **Exigir `api.auth` sempre**: quebra o desenvolvimento local em loopback.
- **Só avisar quando a API sobe exposta sem auth**: o aviso passa despercebido e a API fica aberta.
- **Recusar `owner-invite` quando a trava `session:<nome>` está tomada**: impede um uso seguro e
  legítimo, já que a CLI só faz escritas atômicas.
