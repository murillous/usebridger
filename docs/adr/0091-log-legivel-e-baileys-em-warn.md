# ADR 0091 — Log legível no terminal e Baileys a partir de `warn`, com o libsignal

**Status:** Aceito (2026-10-11) · Detalha o logger do **D13** (escopo do core, plano §5) e
**D37** ([ADR 0037](0037-transport-por-fabrica.md))

## Contexto

Rodando o app, o terminal fica tomado pelo Baileys (#59):

- O `transport-baileys` repassa o logger do bot ao Baileys no mesmo nível, e o Baileys emite em
  `info` a sincronização de estado, o envio de pre-keys e as transições internas, em inglês.
- O estado da conexão o kernel já loga em PT (`conexão aberta`, `conexão fechada (motivo):
  reconectando em N ms`), mas some no meio das linhas do Baileys.
- O libsignal, que o Baileys usa para a criptografia, escreve direto no `console`, sem logger:
  `Closing session: SessionEntry {...}` despeja o registro inteiro da sessão, com as chaves, a
  cada troca de sessão.
- O logger escreve JSON, bom para agregador e ruim de ler ao vivo. A saída era encaminhar para o
  `pino-pretty`, uma dependência a mais no app e um processo a mais no terminal.

Traduzir as mensagens do Baileys foi descartado: o texto muda a cada versão rc, e a tradução
quebraria em silêncio.

## Decisão

- **`baileys({ logLevel })`**, padrão `'warn'`: piso para as linhas do próprio Baileys. Vale o mais
  alto entre ele e o nível do bot, também no `level` que o Baileys consulta para pular logs caros.
  `'debug'` ou `'trace'` para investigar o Baileys.
- **O `console` do libsignal vai para o logger do Baileys.** Enquanto há socket aberto, o
  transport troca `console.log/info/warn/error/debug` por um wrapper que olha só o chamador
  direto: se o arquivo é do pacote `libsignal`, a linha vai ao logger do Baileys com
  `source=libsignal` (`error` em `warn`, o resto em `debug`) e passa pelo mesmo piso. Senão,
  segue para o `console` original. Só os textos vão: os objetos de sessão carregam chaves.
- O desvio é um por processo, com contagem dos sockets abertos: o último a fechar devolve o
  `console` original, a menos que outro código o tenha trocado depois, caso em que o wrapper fica
  na cadeia e só repassa.
- Pelo caminho do arquivo, e não pelo texto, porque o texto muda entre versões e o caminho do
  pacote não. Um callback do app chamado de dentro do libsignal tem outro chamador direto e não é
  desviado.
- **`createLogger({ format: 'pretty' })`** e **`logFormat`** no bot: hora, nível, `[plugin]`, a
  mensagem, os campos em `chave=valor` e o `err` (stack e causas) recuado nas linhas seguintes.
  Cor pelo `util.styleText` do Node, só no stdout de um terminal e respeitando `NO_COLOR`.
- O `pretty` converte a linha JSON que sai do pino, depois da censura de segredos, num
  `LogDestination`. Não há segundo caminho de serialização: `err`, `redact` e `secrets` saem iguais.
- Formatador próprio em vez de `pino-pretty`: são poucas linhas, e o `pino-pretty` traria
  dependências e uma worker thread para o core. O padrão segue `'json'`.

## Consequências

- Em `info`, o terminal mostra o bot, os plugins e a conexão em PT; o Baileys só aparece quando
  avisa ou falha.
- Uma linha `info` do Baileys que ajudaria num diagnóstico fica escondida até alguém subir o
  `logLevel` do transport. É o preço do padrão silencioso.
- O transport mexe num global, o `console`. O efeito é restrito ao chamador do libsignal e dura
  só enquanto há socket, mas quem depura o `console` precisa saber que ele está embrulhado.
- Com várias sessões no processo, as linhas do libsignal vão para o logger do socket aberto mais
  recente: o libsignal não diz de qual sessão a linha é.
- Cada chamada de `console` com socket aberto captura um quadro de stack. O custo é desprezível
  para o `console`, que não está no caminho quente.
- O `pretty` faz um `JSON.parse` por linha emitida. É para o terminal em dev; em produção, o JSON
  segue sem custo extra.
