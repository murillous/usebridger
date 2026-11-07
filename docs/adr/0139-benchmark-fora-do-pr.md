# ADR 0139 — Benchmark fora do caminho do PR: push na develop/main e PR com o label `bench`

**Status:** Aceito (2026-11-07) · Altera em parte o **D50** ([ADR 0050](0050-baseline-do-benchmark.md))
(o job roda em todo PR) · Mantém o **D85** ([ADR 0085](0085-benchmark-intercalado.md))

## Contexto

O job `Benchmark` leva ~19 min, contra poucos minutos de todos os outros jobs do `ci.yml` somados
(#325). Ele faz o build da base num `git worktree` e roda base e commit testado intercalados, em
todo PR e todo push. O PR fica esperando por ele, e na prática o merge já seguia sem o resultado.

A maioria dos PRs não toca no caminho quente do core: docs, transports, plugins, CI.

## Decisão

- O job roda no push na `develop` e na `main`, comparando com o commit anterior, como já fazia.
- No PR, roda só com o label `bench`. O label vale a partir do próximo push do PR: o `ci.yml` não
  escuta o evento `labeled`, que rodaria a suíte inteira a cada label posto.
- PR que mexe no caminho quente (`packages/core`, `bench/`, dependência do core) leva o label.
- A régua não muda: piora > 10% ou cenário fora da meta falha o job, e o item 4 da definição de
  pronto continua valendo.

## Consequências

- O CI de PR sem o label fica no tempo do job mais lento entre os outros (~5 min).
- Uma regressão num PR sem o label aparece no push da `develop`, depois do merge, comparada com o
  commit anterior. Quem fez o merge corrige ou reverte.
- Com vários merges seguidos, cada push compara só com o anterior, e o `concurrency` do `ci.yml`
  cancela a run anterior da mesma ref. Uma regressão pode escapar se o push seguinte cancelar a run
  dela; o PR com o label continua sendo o lugar certo para medir mudança no core.
