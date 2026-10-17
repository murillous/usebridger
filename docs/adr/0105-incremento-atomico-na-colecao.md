# ADR 0105 — Incremento atômico na coleção

**Status:** Aceito (2026-10-16) · Detalha **D15** ([ADR 0015](0015-storage-kv-e-colecoes.md)) ·
Segue **D74** ([ADR 0074](0074-trava-de-sessao-entre-processos.md))

## Contexto

Contador em coleção (interações por chat, pontos) exige ler, somar e gravar. Dois `update`
concorrentes perdem soma, e "acha ou cria" (`find` + `insert`) cria dois documentos quando duas
chamadas chegam juntas (#134). O KV tem a mesma corrida e sem transação. O caso pede uma operação
atômica no storage, não mais cuidado do plugin.

## Decisão

- **`Collection.increment(where, campo, by?, { insert }?)`**, em vez de um `upsert` genérico. Cobre
  o caso da issue com a menor superfície; um `upsert` com atualização condicional exigiria uma
  linguagem de atualização (expressões sobre o documento), que o storage não tem nem precisa.
- **Método obrigatório na porta `Collection`.** Adapter de terceiros precisa implementá-lo; um
  método opcional empurraria a corrida de volta ao plugin, que não sabe qual adapter roda.
- **Atomicidade por adapter:**
  - memória: sem `await` entre a busca e a gravação, então o event loop não intercala;
  - SQLite: `BEGIN IMMEDIATE`, que trava a escrita entre conexões e processos;
  - Postgres: `SELECT ... FOR UPDATE` nas linhas casadas e, só com `insert`,
    `pg_advisory_xact_lock` por coleção, porque o JSON não tem unique para um `ON CONFLICT`.
    Incrementos com `insert` na mesma coleção são serializados.
- **O `insert` precisa casar com o `where`** (já com o campo somado), senão a chamada seguinte não
  o acharia e inseriria outro, o duplicado que a operação elimina. É validado e rejeitado com
  `TypeError`. A garantia vale entre chamadas de `increment`; um `insert` comum concorrente com a
  mesma chave pode duplicar.
- **Validação compartilhada no core** (`normalizeIncrement` e `incrementedValue` em
  `@usebridger/core/adapter`): `by` finito, campo válido e não `id`, alvo numérico (ausente e
  `null` valem 0) e soma finita (Infinity viraria `null` no JSON e zeraria o contador). Todo
  adapter rejeita igual e sem gravar nada.

## Consequências

- Adapter de terceiros quebra na atualização até implementar `increment` (minor com aviso no
  changeset).
- Postgres paga uma serialização por coleção nos incrementos com `insert`; sem `insert`, só as
  linhas casadas.
- Atualização que não seja soma (máximo, troca condicional) segue sem operação atômica.
