# Operação

O que acontece com o bot no ar e por quê. O passo a passo de processo, supervisor, logs e backup
está em [Rodar em produção](/usebridger/comecando/producao/).

## A tabela de boot

No `start()`, o bot decide quais plugins sobem, em ordem, e loga uma tabela com uma linha por
plugin: nome, versão e situação. A situação é `carregado`, `carregado; sem ...` ou `ignorado`, com
o motivo ([Plugins no core](../../packages/core/docs/plugins.md#boot-start)).

A decisão tem duas etapas, e a ordem importa:

1. **O que dá para saber sem rodar código.** Para todos os plugins, em ordem de dependência, o
   host confere `disabledPlugins`, a faixa `engine`, os `transports` declarados, as capabilities
   de `requires` e as dependências (`dependsOn` ausente, em versão fora da faixa ou que não
   subiu).
2. **O `setup` de cada um**, com prazo. Uma config inválida aparece aqui, como falha da fábrica de
   contexto.

Qualquer motivo que não seja `disabled` **para o boot**: o bot desce o que subiu, não conecta ao
transport, e o `start()` rejeita com `PluginBootError`, que lista cada plugin com o motivo. Se o
problema já aparece na etapa 1, nenhum `setup` roda; senão, todos os `setup`s rodam, para o erro
listar todas as falhas de uma vez ([ADR 0102](../adr/0102-plugin-falho-derruba-o-boot.md)).

Parar é a escolha do lado seguro. Um bot que sobe sem metade dos plugins parece saudável: o
`/health` diz 200, e o problema só aparece quando alguém manda o comando que não responde.
Quem quer subir sem um plugin de propósito diz isso com `disabledPlugins`, que deixa a linha
`ignorado (desabilitado)` na tabela, e tira da lista também quem depende dele.

Os motivos, e o que fazer com cada um:

| Motivo | Causa provável |
| --- | --- |
| `engine` | o plugin foi testado contra outra versão do core; atualize um dos dois |
| `transport` | o plugin declara `transports` e o bot usa outro; ele é de uma plataforma só |
| `capabilities` | o transport não tem o que o plugin exige em `requires` |
| `dependency-missing`, `dependency-version`, `dependency-skipped` | falta o plugin de que ele depende, numa versão aceita, carregado |
| `setup-failed` | o `setup` lançou ou estourou o prazo, ou a config é inválida; o erro original está no log |

Duas situações não param o boot. `carregado; sem ...` lista os comandos que ficaram de fora porque
exigem uma capability ou um service que falta: o plugin degrada por comando, de propósito
([ADR 0090](../adr/0090-requires-por-comando.md), [ADR 0099](../adr/0099-comando-que-exige-servico.md)).
E com o bot já no ar, um `reload`, `disable` ou `enable` que falha deixa só aquele plugin fora,
com o motivo na tabela, sem derrubar o processo.

## A fila de saída em produção

A fila de saída é a peça que protege o número de ban
([O caminho da mensagem → fila de saída](mensagem.md#fila-de-saída)). Em produção, o que se vê
dela:

- **Latência sob carga.** Com os padrões do WhatsApp (300 ms global, 1 s por chat), o bot envia
  cerca de 3 mensagens por segundo no total. Num pico, as respostas atrasam em vez de sair todas de
  uma vez. É o preço da política anti-ban, e quem aumenta o ritmo assume o risco.
- **Broadcast não atrasa resposta.** Envie avisos em massa com prioridade `low`: as respostas a
  comandos passam à frente, e o broadcast que enche a fila não recusa uma resposta.
- **Retry.** Falha transitória (rede, 5xx) tenta de novo com espera crescente; 429 espera a janela
  que a plataforma pediu; erro definitivo (400, 401, 403, 404) não tenta. Um envio que estoura o prazo não é
  repetido, para não duplicar.
- **Conexão caída.** A fila pausa e retoma no reconectar; depois de 60 s pausada, as respostas
  pendentes rejeitam, porque já não fazem sentido para quem perguntou.
- **Humanização** opcional: o transport mostra "digitando..." antes de enviar.

`bot.stats().outbound` dá os contadores (pendentes por prioridade, enviados, falhas, re-tentativas,
pausa) sem custo no caminho da mensagem. Detalhes em [Fila de saída](../../packages/core/docs/outbound-queue.md).

Um plugin lê os mesmos contadores com `ctx.stats()`, de entrada e de saída, sempre do próprio bot.
É um retrato do instante (gauge), não uma série: quem quer histórico amostra no próprio ritmo, num
job do scheduler ou a cada scrape, e guarda os valores
([ADR 0106](../adr/0106-observadores-do-core.md)).

Para medir latência e desfecho de cada unidade de trabalho, o plugin assina os sinais do core com
`ctx.observe`:

```ts
ctx.observe('message.handled', (s) => {
  // s.route: 'command' | 'step' | 'message'; s.status: 'ok' | 'failed' | 'refused' | 'timeout'
  // s.queuedMs: espera na fila de entrada; s.durationMs: tempo do handler
});
ctx.observe('outbound.sent', (s) => {
  // s.status: 'sent' | 'failed' | 'dropped'; s.queuedMs inclui taxa anti-ban e re-tentativas
  // s.replyTo: id da mensagem respondida, só nas respostas por ctx.reply
});
```

- **Síncrono e nunca aguardado.** O observador não segura o chat; uma promise devolvida não é
  aguardada, mas a rejeição dela também vira `plugin.error` com `phase: 'observer'`. Faça só a
  conta (somar num balde, empurrar num buffer) e deixe I/O para depois.
- **Erro isolado.** A exceção vira `plugin.error` com `phase: 'observer'`, e os demais
  observadores seguem.
- **Custo zero sem assinante.** Sem observador, o core não lê o relógio nem monta o sinal.
- **Por bot e por plugin.** Dois bots no processo não se veem, e a assinatura sai no dispose do
  plugin (ou pela função que `observe` devolve).
- O `message.handled` sai para o comando (com o nome canônico), o passo de conversa e os
  listeners de `message`; a edição e a mensagem barrada por middleware não geram sinal. Num
  comando com `background: true`, sai quando o `run` termina. O sinal só sai se havia observador
  quando a mensagem entrou na fila.
- O `outbound.sent` sai uma vez por `send`, depois da última parte de um texto dividido ou de um
  álbum. O `ctx.send` direto não traz `chatType` nem `replyTo`: o core só conhece o id do chat.
- `chatId`, `senderId` e `messageId` existem só em memória. Não os persista nem exporte.

## Métricas de performance

O projeto mede, no CI e sem rede, o custo do kernel em si
([ADR 0030](../adr/0030-metas-de-performance.md)):

| Métrica | Meta |
| --- | --- |
| Overhead do kernel por mensagem | p99 < 1 ms |
| Vazão sintética | ≥ 5.000 msg/s em 500 chats, num núcleo |
| Memória ociosa | < 80 MB |
| Crescimento de memória depois de 1 milhão de mensagens | ~0 |
| Boot até "pronto para conectar" com 20 plugins | < 500 ms |

Um PR que piora alguma métrica em mais de 10% falha. O benchmark roda base e commit testado no
mesmo runner, alternando a ordem, para o ruído da máquina não decidir
([ADR 0089](../adr/0089-benchmark-intercalado.md)).

Os números são do kernel: a vazão roda com a taxa anti-ban zerada, porque ela dominaria a medição.
O teto real de um bot de WhatsApp é o ritmo da fila de saída e o tempo dos plugins, não o kernel.

## Migrar um bot existente aos poucos

O Bridger nasceu de uma migração assim: o LumaBot seguiu em produção enquanto os plugins eram
portados um a um, do mais simples ao mais complexo, e a virada aconteceu quando um checklist de
paridade fechou ([ADR 0023](../adr/0023-migracao-incremental-legacy.md)). O mesmo caminho serve para
outros bots:

1. **Liste o que o bot faz** e transforme a lista no checklist de paridade. É o critério objetivo de
   quando virar.
2. **Comece pelo que é kernel no Bridger.** Fila, reconexão, ritmo de envio e persistência das
   credenciais saem do código do bot; não há o que portar.
3. **Porte um plugin por vez**, do mais simples ao mais complexo, cada um com teste no kit. O que o
   bot antigo fazia direto na biblioteca da plataforma vira chamada da API normalizada, ou fica no
   [escape hatch](plugins.md#escape-hatch-e-o-preço-dele) até haver API.
4. **Rode o novo num número de teste.** A mesma sessão não roda em dois processos, então o bot novo
   não divide o número com o antigo durante a migração.
5. **Vire na paridade:** pare o bot antigo, pareie o número de produção no novo e mantenha o
   antigo à mão até confiar.

Não há importador de dados: o que o bot antigo guardava é lido por um script que grava no storage
do Bridger, ou por um plugin na primeira subida.
