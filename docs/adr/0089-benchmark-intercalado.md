# ADR 0089 — Benchmark intercalado: base e commit testado se revezam, comparados pelo quartil bom

**Status:** Aceito (2026-10-11) · Detalha **D54** ([ADR 0054](0054-baseline-do-benchmark.md))

## Contexto

O benchmark varia mais que a tolerância de 10% (#55). Na #54, com o mesmo código, o `overhead`
foi de 0,15 a 0,31 ms entre execuções, e o `throughput` de 10,9 mil a 14 mil msg/s. Não deu para
dizer se o PR regrediu. Três causas:

- **Base e commit testado medidos em sequência.** O job rodava o benchmark inteiro na base e
  depois no commit testado. Qualquer mudança na máquina entre os dois (aquecimento, vizinho no
  runner, frequência da CPU) caía inteira num dos lados. No A/B local da #54, o commit testado
  sempre rodou por último e sempre saiu pior. O ADR 0054 já apontava esse passo como o seguinte.
- **A comparação usava a mediana de poucas execuções.** O `overhead` é o p99 de uma latência
  abaixo de 1 ms, e o 1% mais lento é onde caem as pausas de GC e as trocas de processo. Com 3
  execuções, a mediana pulava junto.
- **Máquina local sem preparo.** Governador `powersave`, outros processos disputando CPU, e nada
  documentava como medir localmente.

Alternativas para a estatística da comparação, medidas num A/B local com o mesmo código na base
e no commit testado:

- **Mediana com mais execuções.** Mais estável que com 3, mas carrega o ruído, que puxa para o
  lado ruim: nenhuma interferência deixa o código mais rápido do que ele é.
- **Melhor execução no sentido da meta** (a menor num teto, a maior num piso), a proposta da #55.
  Funcionou no `overhead` (±2%), mas no `boot` o mínimo de 25 execuções chegou a +7,4%: de vez em
  quando sai uma execução rápida demais num lado e não no outro, e ela decide a comparação.
- **Quartil bom** (o p25 num teto, o p75 num piso). Descarta as execuções lentas, que são ruído, e
  as rápidas demais, que são sorte. No mesmo A/B, o `boot` ficou em até +2,9%.
- **Mediana das latências no `overhead`, em vez do p99.** Estável, mas a comparação passaria a
  medir outra coisa que não a meta, e o cenário teria de devolver duas medidas. O quartil bom do
  p99 já fica dentro de ±5%.

## Decisão

- `pnpm bench --baseline <dir>` recebe um checkout buildado da base, no lugar do JSON de outra
  execução. Em cada cenário, o runner roda o `bench/dist/main.mjs` da base e o do commit testado
  alternados, um processo por execução. A ordem dentro do par inverte a cada rodada (B T, T B,
  B T...), para nenhum lado ficar sempre em segundo. O job de CI troca os dois passos por um
  build da base e um benchmark só.
- A comparação usa o quartil bom de cada lado, no sentido da meta. A meta continua pela mediana
  do commit testado.
- Mais execuções onde cada uma é barata: `boot` 25, `idle-memory` 15, `overhead` 9 e
  `throughput` 5 (cada execução dele leva ~16 s).
  O `memory-growth`, que não tem comparação (ADR 0054), roda só no commit testado.
- A base que não conhece um cenário (cenário novo no PR) responde `cenário desconhecido`, e o
  cenário passa sem comparação, como antes.
- O `bench/docs/README.md` ganha a seção "Medir localmente": governador `performance`, `taskset`
  (com o limite dele sem `isolcpus`) e o que fechar.

## Consequências

- Uma mudança na máquina durante o job pesa igual nos dois lados. No A/B local com o mesmo código
  na base e no commit testado, todos os cenários com `checksRegression` ficaram dentro de ±5%.
- O job dura o mesmo que antes (~5 min de benchmark local): as execuções a mais se pagam com a
  base deixando de rodar o `memory-growth` (~80 s), o cenário mais longo.
- O `--baseline <arquivo>` sai. Comparar com uma execução gravada de outro dia ou de outra máquina
  era justamente o que a variação entre momentos não permite.
- Um PR que muda o runner compara o runner novo com o antigo. Foi o caso deste: o runner antigo
  criava um schema Zod ao carregar (o leitor do baseline), o que aquecia o Zod antes do `boot` e
  tirava ~3 ms (12%) dele. Sem isso, o `boot` mede o primeiro uso do Zod pelas configs, como em
  produção, e a comparação deste PR mostra essa diferença uma vez.
- O quartil bom pode esconder uma regressão que só aparece nas execuções lentas (uma pausa de GC
  nova em parte dos processos, por exemplo). A meta, pela mediana, segue pegando o caso absoluto.
