# ADR 0101 — Nomes de contatos no auth state

**Status:** Aceito (2026-10-15) · Detalha [ADR 0100](0100-mencao-com-tag-no-texto.md) e
[ADR 0049](0049-evento-de-comando.md)

## Contexto

O `ContactBook` do transport Baileys guarda em memória o nome de cada contato, e é ele que dá nome
às menções, reações, votos e apagamentos (#109). Zera no restart: depois de reiniciar, as menções
voltam a sair sem nome até cada pessoa falar de novo (#111). A persistência não pode pôr o storage
no caminho quente de cada mensagem.

## Decisão

- **Onde:** no `AuthStateStore` da sessão (`deps.auth`), tipo `bridger-contact-name`, id = JID
  normalizado, valor = o nome. O par LID ↔ telefone é uma entrada própria com o mesmo nome. Sem
  contrato novo no `TransportDeps`, isolado por sessão, apagado pelo `clear()` do logout e gravado
  em transação (`setKeys`).
- **Leitura read-through e lazy:** memória primeiro; quando ela não sabe o nome, uma consulta por
  id (o id e o telefone par num só `getKeys`). O resultado e a ausência ficam em cache (cache
  negativo, invalidado quando o id é observado), e leituras concorrentes dividem a Promise.
  Falha de leitura: `warn`, sem nome, e o id não é marcado como consultado.
- **Escrita write-behind:** `observe` marca como pendente só o que mudou, e um flush com debounce
  grava tudo num `setKeys`; o `disconnect()` também faz flush. Falha: `warn` e o lote volta, sem
  sobrescrever um valor mais novo.
- **Logout:** ao fechar por `logged-out`/`auth-failed`, o livro e o lote pendente são
  descartados antes de o kernel limpar o auth state, e uma leitura em andamento é ignorada.
- `contact.updated` não muda: nomes lidos do storage não emitem evento, e após o restart o contato
  conta como visto pela primeira vez.

## Alternativas descartadas

- **Storage novo no `TransportDeps`:** contrato novo no core, sem o isolamento por sessão nem o
  apagamento no logout que o auth state já dá.
- **Carregar tudo no connect:** o store não lista por tipo, e seriam milhares de contatos lidos
  de uma vez.
- **Gravar a cada mensagem:** storage no caminho quente de cada mensagem.

## Consequências

- Menção, reação e voto saem com nome já na primeira mensagem depois do restart.
- Uma leitura por id desconhecido por processo; o cache negativo cresce com os ids consultados.
- Uma janela de até 2 s de nomes novos pode se perder numa queda do processo sem `disconnect()`.
- Quem já tinha um `pushName` gravado pode ter o nome trocado pela agenda do aparelho se a
  sincronização inicial só trouxer `name` depois do restart (o livro em memória está vazio).
