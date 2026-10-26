# ADR 0128 — Limitações da autenticação da API: rate limit persistente, corridas, chaves órfãs e auth padrão

**Status:** Aceito (2026-10-26) · Substitui os trechos "Rate limit ... em memória do processo", "Corridas conhecidas", "A chave sobrevive ao rebaixamento ou desativação do criador" e "Auth opt-in ... Sem ela a API fica aberta" do [ADR 0127](0127-base-da-autenticacao-da-api.md)

## Contexto

A autenticação da API (#223, M7-4) entrou com limitações conhecidas, registradas no ADR 0127 e
marcadas com `shortcut:` no código. A #289 as fecha antes da virada v1.0: o rate limit vive na
memória do processo, há corridas que o storage sem transação entre documentos e sem índice unique
não impede, a API key sobrevive ao criador e a API sobe aberta quando falta `api.auth`.

## Decisão

- **Rate limit persistido**. As contagens de login, aceite de convite e troca de senha ficam no
  storage do bot, namespace `auth`, coleção `rateLimits`, com `Collection.increment` atômico e
  expiração por janela. Sobrevivem a restart e valem entre processos que dividem o banco.
- **Corridas** (bootstrap criando dois owners, dois owners se desativando ou rebaixando e zerando os
  owners ativos, e-mail duplicado concorrente): checagem e escrita passam a ser atômicas, com as
  primitivas que o storage já tem (`increment` com `insert`, `update` condicional que devolve
  quantos documentos casaram). Em termos gerais, quem quer a vaga reserva/trava um documento no
  storage e só então escreve; quem perde a reserva recebe o erro de conflito. O mecanismo exato
  fica no código.
- **Chaves órfãs**. A permissão efetiva de uma API key é o **escopo da chave ∩ as permissões
  atuais do criador** (`createdBy`). Criador desativado ou inexistente: a chave não autentica
  (401). Reativar ou repromover o criador restaura a chave, sem recriá-la. Substitui "A chave
  sobrevive ao rebaixamento ou desativação do criador".
- **Auth padrão**. Sem `api.auth`, a API só sobe se o `hostname` do servidor HTTP for loopback
  (`127.0.0.1`, `::1`, `localhost`). Fora disso o start do bot falha com erro claro. Substitui
  "Auth opt-in ... Sem ela a API fica aberta".
- **`bridger owner-invite` com o bot no ar** é permitido. A CLI só grava documentos de auth com
  operações atômicas, e SQLite (WAL) e Postgres suportam dois processos no mesmo banco. Testes com
  dois handles no mesmo banco provam.

## Consequências

- **Quebra** quem expunha a API aberta (hostname não loopback sem `api.auth`): precisa configurar
  `api.auth` ou voltar para loopback. Pede changeset adequado no `@usebridger/core`.
- O rate limit passa a custar escrita no storage a cada tentativa, em troca de limite que não zera
  no restart.
- A chave de um criador desativado para de funcionar sem ser apagada: o efeito é reversível, mas
  quem audita a listagem de chaves precisa lembrar que "ativa" depende do criador.
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
