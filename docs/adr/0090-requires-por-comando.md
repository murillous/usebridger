# ADR 0090 — `requires` por comando

**Status:** Aceito (2026-10-11) · Detalha **D16** ([ADR 0016](0016-manifesto-do-plugin.md)) e
**D64** ([ADR 0064](0064-comandos-nativos.md)) · O `requires` do manifesto derruba o boot desde o [ADR 0102](0102-plugin-falho-derruba-o-boot.md);
o por comando segue este ADR

## Contexto

O `requires` é do plugin inteiro. Num plugin com comandos que enviam tipos diferentes, exigir tudo
no plugin derruba os comandos que funcionariam: o Discord perde imagem e PDF porque não envia
figurinha (murillous/LumaBot#265). Sem exigir, cada `run` começa conferindo
`ctx.capabilities`, e o plugin `media` do LumaBot repete isso nos cinco comandos (#47).

Pontos a decidir:

- **Não registrar ou recusar?** Registrar e recusar com `onReject` (`reason: 'capability'`) deixa
  o comando no menu nativo e no `ctx.commands.list()` (o `help` o mostraria) para depois dizer que
  não dá. Não registrar trata o comando como o kernel já trata o plugin pulado por `requires`.
- **E a validação?** Se o comando sem a capability nem chegar ao registro, um nome inválido só
  falharia no transport que tem a capability.

## Decisão

- `command({ requires: [...] })`, com as mesmas `Capability` do manifesto. Capability desconhecida
  lança `TypeError` na definição, também para os `commands` do manifesto.
- No bot, o `ctx.commands.add` confere `requires` contra as capabilities do transport. Sem alguma,
  o comando não é registrado: fica fora do roteador, do `ctx.commands.list()` e do menu nativo, e
  um log `info` registra `command` e `missing`. O resto do plugin sobe normalmente.
- A definição é validada antes da conferência, então nome, prazo e limite inválidos lançam em
  qualquer transport.
- O roteador solto ignora `requires`, como o `timeoutMs`: quem o usa fora do bot escolhe o que
  registra.
- Recusar com resposta fica de fora. O plugin que quiser avisar registra o comando sem `requires`
  e confere `ctx.capabilities` no `run`, como hoje.

## Consequências

- Um plugin com comandos de mídia variada roda em todo transport com o que dá, sem
  `if (!capabilities.has(...))` em cada `run`, e o menu da plataforma só mostra o que funciona.
- Quem digita um comando deixado de fora recebe o mesmo que de um comando inexistente. No log, a
  linha `info` do boot explica.
- O comando ausente não entra no relatório de boot dos plugins (`reason.kind`), só no log: o
  plugin carregou.
