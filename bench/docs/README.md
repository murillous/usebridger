# Benchmark — documentação

Mede as metas de performance do [plano §7](../../BRIDGER_PLAN.md#7-metas-de-performance)
([ADR 0027](../../docs/adr/0027-metas-de-performance.md)) sobre o `FakeTransport`, sem rede.

## Rodar

Na raiz:

```sh
pnpm bench                              # todos os cenários (~3 min)
pnpm bench --only overhead,boot         # só alguns
pnpm bench --out resultado.json         # grava o resultado em JSON (caminho relativo a bench/)
pnpm bench --baseline ../../base        # compara com um checkout buildado da base, intercalado
```

O `pnpm bench` faz o build do workspace e roda `bench/dist/main.mjs`. O benchmark mede o código
compilado, como ele roda em produção: executar o `.ts` direto carrega o type stripping do Node,
que soma ~14 MB de RSS e estoura a meta de memória ociosa sem ter nada a ver com o kernel. Depois
de mudar o core, rode o `pnpm bench` da raiz (que refaz o build), e não o script do pacote.

Cada execução de cenário roda num processo novo: memória e boot dependem de o processo não ter
carregado nada antes. O valor reportado é a mediana das execuções, e é ela que vale para a meta.
Se algum cenário fica fora da meta, o comando sai com código 1.

```
overhead       0.158 ms (meta < 1; execuções: 0.171, 0.147, 0.161, 0.211, 0.159, 0.149, 0.158, 0.144, 0.156) ok
throughput     13763 msg/s (meta ≥ 5000; execuções: 13774, 13756, 13971, 13763, 13664) ok
idle-memory    74.1 MB (meta < 80; execuções: 74.3, 74.3, 74.2, 74.0, 74.0, 73.9, 74.0, 74.3, 74.2, 74.2, 73.7, 74.0, 73.7, 74.1, 74.2) ok
memory-growth  -0.202 MB (meta < 5; execuções: -0.202) ok
boot           27.2 ms (meta < 500; execuções: 32.7, 29.5, 25.8, 27.1, 27.7, 27.2, 27.4, 26.9, 26.7, 27.1, 27.6, 29.4, 28.3, 26.9, 27.3, 26.9, 27.6, 26.1, 26.4, 26.2, 27.6, 27.2, 29.5, 28.2, 26.0) ok
```

## Bot de referência

Todos os cenários usam o mesmo bot (`src/workload.ts`), montado com o `createTestBot`:

- 20 plugins, cada um com config Zod, `messages`, dois comandos e dois listeners. Os 19 últimos
  dependem do primeiro (`dependsOn`), para o boot ordenar um grafo.
- Middlewares oficiais (`ignoreSelf`, `sanitize`), mais `rateLimit` por remetente com teto alto,
  `chatFilter` com uma lista de bloqueio e um middleware do app.
- Fila de saída com `globalIntervalMs` e `chatIntervalMs` em 0
  ([ADR 0043](../../docs/adr/0043-espera-na-fila-de-saida-fora-do-prazo.md)): a taxa anti-ban é
  política e dominaria a medida.

A carga alterna três mensagens em 500 chats: `!ping` (comando que responde), `oi` (um listener
responde) e um texto que nenhum plugin responde. Um listener espera um ciclo do event loop, como
um plugin que faz I/O. Cada mensagem tem remetente próprio.

No fim, o cenário confere a carga: mensagens processadas, nenhuma descartada, nenhum
`plugin.error`, nenhum envio perdido e o número de respostas esperado. Um plugin ignorado no
boot também falha o cenário. Se algo diverge, ele lança em vez de reportar uma medida de outra
coisa.

## Cenários

| Cenário | Meta | O que mede |
| --- | --- | --- |
| `overhead` | p99 < 1 ms | Uma mensagem por vez, do `emit` do transport até o `bot.settled()`: middlewares, roteador, listeners e fila de saída. 20 mil mensagens depois de 5 mil de aquecimento |
| `overhead-observed` | p99 < 1 ms | O `overhead` com um observador vazio em `message.handled` e em `outbound.sent` (ADR 0102) |
| `overhead-metrics` | p99 < 1 ms | O `overhead` com o `plugin-metrics` carregado ([abaixo](#com-o-plugin-metrics)) |
| `throughput` | ≥ 5.000 msg/s | Rajadas de 5 mil mensagens (10 por chat), esperando o bot assentar entre elas. 200 mil mensagens depois de 20 mil de aquecimento |
| `throughput-metrics` | ≥ 5.000 msg/s | O `throughput` com o `plugin-metrics` carregado ([abaixo](#com-o-plugin-metrics)) |
| `idle-memory` | < 80 MB | RSS do processo com o bot no ar e ocioso, depois de um `gc()` |
| `memory-growth` | < 5 MB | Heap depois de 1M mensagens menos o heap depois de 100 mil de aquecimento, ambos após `gc()` |
| `boot` | < 500 ms | Do `createBot` ao fim do `start()` com os 20 plugins, num processo frio (sem contar o `import`) |

Como ler as metas:

- **`memory-growth` < 5 MB** é o "~0" do plano. O remetente novo a cada mensagem faz um `Map`
  por remetente que nunca se limpa (o `rateLimiter` do legacy) crescer com a carga. Um objeto
  pequeno retido por mensagem já passa de 45 MB em 1M mensagens; a folga de 5 MB absorve o ruído
  do heap.
- **`idle-memory`** mede o processo inteiro. Cerca de 45 MB são do próprio Node. O bot vem do
  `@usebridger/testing/bot`, que não importa o Vitest: o entry principal o carrega para registrar
  os matchers, o que soma ~6 MB que não são do kernel. No runner do CI (Linux), o RSS fica uns
  10 MB acima do medido no Windows.
- **`overhead`** inclui o custo do `settled()`, então é um teto do overhead real.

O `boot` mede também o primeiro uso do Zod pelas configs dos plugins, como num processo de
produção. Por isso o runner não cria schema Zod ao carregar: aquecido antes da medida, o Zod
tirava ~3 ms (12%) do `boot`.

## Com o plugin-metrics

`overhead-metrics` e `throughput-metrics` sobem o bot de referência com o `plugin-metrics`
oficial, com a config padrão e o storage em memória do `createTestBot`. Medem o caminho da
mensagem com os observadores dele em `message.handled` e `outbound.sent`: contadores, histograma
de duração e o rastreio de ativos. O flush periódico fica fora da janela medida: o workload
configura `flushIntervalMs` em 24 h, para o número não depender de quando o timer dispara. O
flush do `teardown` roda no `stop()`, depois da medida. O flush, o `query` e o `/metrics` não
entram nestes cenários.

Não há meta própria no plano §7: valem as do `overhead` e do `throughput`, e a regra de não
piorar mais de 10% sobre a base. Para medir só eles:

```sh
pnpm bench --only overhead,overhead-metrics,throughput,throughput-metrics
```

Linha de base no `plugin-metrics` 0.2.0 (Linux, desktop, sem preparar a máquina), com o bot sem
o plugin na mesma rodada para comparar:

```
overhead       0.201 ms (meta < 1; execuções: 0.251, 0.201, 0.202, 0.199, 0.208, 0.197, 0.191, 0.197, 0.201) ok
overhead-metrics 0.298 ms (meta < 1; execuções: 0.321, 0.304, 0.261, 0.294, 0.298, 0.260, 0.278, 0.309, 0.299) ok
throughput     11531 msg/s (meta ≥ 5000; execuções: 11446, 11708, 11621, 11284, 11531) ok
throughput-metrics 7798 msg/s (meta ≥ 5000; execuções: 7332, 7740, 7820, 7798, 7924) ok
```

O plugin custa ~48% no p99 do `overhead` e ~32% na vazão. As mudanças do redesenho da M6
(`prom-client`, histórico por delta) comparam com esta base pelo `pnpm bench --baseline`, com
um checkout de antes delas.

## Comparar com um baseline

Com `--baseline <dir>`, o runner recebe um checkout da base já buildado (`pnpm install` e
`pnpm build` nele) e roda o `bench/dist/main.mjs` dela junto com o seu, intercalados: em cada
cenário, base e commit testado se revezam execução a execução, e a ordem dentro do par inverte a
cada rodada (base, testado; testado, base; ...). Um aquecimento da máquina, um vizinho no runner
ou uma mudança de frequência da CPU no meio do benchmark pesam igual nos dois lados, em vez de
cair inteiros num deles ([ADR 0085](../../docs/adr/0085-benchmark-intercalado.md)).

A comparação usa o **quartil bom** de cada lado, no sentido da meta: o p25 num teto (`overhead`,
`idle-memory`, `boot`), o p75 num piso (`throughput`). O ruído da máquina puxa a medida para o lado
ruim, e a mediana carrega ele. A melhor execução também não serve: uma execução rápida demais
aparece num lado e não no outro. A mediana continua valendo para a meta. O comando sai com código
1 se um cenário piorou mais de 10%.

```
Comparação com o baseline, pelo quartil bom (tolerância 10%):
overhead       0.151 → 0.149 (-1.2% melhor; base: 0.168, 0.169, 0.156, 0.151, 0.163, 0.177, 0.156, 0.145, 0.141) ok
throughput     13884 → 13774 (+0.8% pior; base: 14059, 13800, 13884, 13825, 13686) ok
idle-memory    73.9 → 74.0 (+0.1% pior; base: 74.1, 74.1, 74.2, 74.0, 73.9, 74.0, 73.9, 73.5, 74.1, 73.8, 74.1, 74.0, 73.7, 73.9, 74.3) ok
memory-growth  -0.202 (vale só a meta)
boot           26.7 → 26.9 (+0.7% pior; base: 29.5, 28.6, 28.7, 28.1, 26.8, 25.6, 26.7, 27.2, 27.0, 27.0, 27.0, 26.7, 27.1, 25.9, 27.3, 27.1, 26.6, 27.3, 26.1, 26.7, 26.8, 26.8, 28.8, 27.7, 26.6) ok
```

- O `memory-growth` não entra na comparação (`checksRegression: false`), e a base nem roda nele.
  Perto de zero, 10% do baseline é menos que o ruído do heap. A meta de < 5 MB é a régua dele.
- Um cenário que a base não conhece passa sem comparação (`sem baseline`).
- O caminho é conferido antes de medir: sem o `bench/dist/main.mjs` na base, falha na hora.
- Um PR que muda o próprio runner compara o runner novo com o antigo. Se a mudança mexe no que
  roda antes da medida (como um import que aquece o Zod), a comparação daquele PR mede isso, e
  não o kernel.

Para medir o efeito de uma mudança na sua máquina, monte a base num `git worktree`:

```sh
git worktree add ../base develop
(cd ../base && pnpm install --frozen-lockfile && pnpm build)
pnpm bench --baseline ../../base     # relativo a bench/
git worktree remove ../base
```

## Medir localmente

O intercalado compensa a mudança da máquina ao longo do benchmark, mas não o ruído de cada
execução. Num notebook ou desktop em uso, prepare a máquina antes de medir:

- **Governador de CPU em `performance`**: no `powersave`, a frequência varia com a carga e a
  primeira execução de cada par sai mais lenta. `sudo cpupower frequency-set -g performance` (e
  volte para o anterior depois; `cpupower frequency-info` mostra qual é).
- **Um núcleo para o benchmark**: `taskset -c 3 pnpm bench --baseline ../../base`. Fixar o
  núcleo evita a migração entre núcleos, mas não tira outros processos dele. Só o `isolcpus` (no
  boot do kernel) reserva o núcleo de fato; `docker run --cpuset-cpus` tem a mesma limitação do
  `taskset`.
- **Feche o que pesa**: navegador, IDE indexando, build, sincronização de arquivos. Com o
  notebook, ligue na tomada.

Com a máquina preparada, duas comparações com o mesmo código na base e no commit testado ficam
dentro de ±5% em todos os cenários com `checksRegression`. Se não ficarem, o ruído da máquina
ainda é maior que o que você quer medir.

## No CI

O job `Benchmark` (`.github/workflows/ci.yml`) mede o baseline no próprio runner
([ADR 0050](../../docs/adr/0050-baseline-do-benchmark.md)), intercalado com o commit testado
([ADR 0085](../../docs/adr/0085-benchmark-intercalado.md)). Entre máquinas diferentes, a
variação passa dos 10%, então um baseline versionado ou de outro job não serviria.

1. `Build da base`: faz o build do primeiro pai do commit testado num `git worktree`. No PR, o
   primeiro pai do merge commit é a ponta da base; no push, é o commit anterior.
2. `Benchmark`: roda `pnpm bench --baseline` com o worktree da base.

O job falha se algum cenário ficar fora da meta ou piorar mais de 10%. Se a base não tem `bench/`,
vale só a meta. O log do passo `Benchmark` mostra a tabela da comparação, com as execuções da
base.

Se o job falhar com uma piora que você não esperava, rode a mesma comparação localmente (acima)
antes de concluir que é ruído.

## Adicionar um cenário

1. Escreva a função em `src/scenarios.ts`. Ela sobe o bot com `createWorkload()`, mede e chama
   `finish()` com o total de mensagens e de respostas.
2. Registre em `SCENARIOS` com a unidade, a meta (`max` ou `min`) e o número de execuções.
3. Teste em `src/scenarios.test.ts` com uma carga pequena.
