# ADR 0099 — Comando que exige serviço e `optionalDependsOn`

**Status:** Aceito (2026-10-13) · Detalha **D18** ([ADR 0018](0018-service-registry.md)),
**D41** ([ADR 0041](0041-reload-em-cascata.md)) e **D90** ([ADR 0090](0090-requires-por-comando.md)) · Provedor que falha no boot derruba o boot
desde o [ADR 0102](0102-plugin-falho-derruba-o-boot.md)

## Contexto

O `!downloadsticker` do plugin `download` do LumaBot usa o serviço `sticker` de forma opcional:
o `download` precisa carregar sem o `sticker`, e só esse comando depende dele (#84). Hoje:

- `dependsOn: { sticker }` derruba o `download` inteiro sem o `sticker`;
- sem `dependsOn`, o comando fica registrado, aparece na ajuda e no menu nativo e recusa no `run`
  com `if (!plugin.services.has('sticker'))`;
- registrar o comando no `setup` só se `has` responder `true` não basta: o `download` não
  recarrega quando o `sticker` sobe, falha, recarrega ou é desligado, e nem carrega depois dele
  sem um `after`.

Alternativas consideradas:

- **Visibilidade dinâmica no roteador**: o comando fica registrado e o roteador, o `list()` e o
  menu o escondem enquanto o serviço falta. Exige aviso de mudança no service registry, um estado
  novo de comando (registrado mas oculto) e reconferir a cada despacho. O ADR 0090 já escolheu
  "não registrar" para o comando que não pode rodar.
- **Ligar o serviço ao plugin pelo nome**: o comando citaria o serviço e o kernel descobriria o
  provedor para ordenar e cascatear. O registry só sabe quem provê o quê depois do `setup` do
  provedor, então a ordem do boot não sairia dele.
- **Só `optionalDependsOn`**: resolve ordem e cascata, mas o comando do manifesto não teria como
  ficar de fora, e o autor voltaria a registrar à mão no `setup`.

## Decisão

- `command({ services: [...] })`, com nomes de `Services`. No bot, o `ctx.commands.add` confere
  `services.has` de cada um logo depois do `requires`. Se algum falta, o comando não é registrado,
  como no ADR 0090: fora do roteador, do `ctx.commands.list()` e do menu nativo, log `warn` com
  `command` e `services`, e uma entrada em `unregistered` com `missing: []` e `services` com os
  que faltavam. A tabela de boot mostra `sem ds (serviço sticker)`. Nome que não é texto não vazio
  lança `TypeError` na definição. O roteador solto ignora o campo.
- `optionalDependsOn: { sticker: '^0.1.0' }` no manifesto, no formato do `dependsOn` (nome de
  plugin → faixa semver, com a mesma validação: faixa inválida é erro de manifesto). Ordena como o
  `dependsOn` (aresta na toposort e no ciclo), não impede a carga (ausente, ignorado, `setup`
  falho ou desligado) e entra na cascata do ADR 0041: `reload`, `disable` e `enable` do provedor
  descem e sobem o dependente opcional junto. O mesmo nome em `dependsOn` e `optionalDependsOn`
  é erro de manifesto. O aviso de `^0.0.z` do boot vale para os dois.
- Provedor carregado com versão fora da faixa também não impede a carga, e o boot avisa em `warn`
  (`dependency`, `range`, `version`). Ele continua na ordem e na cascata, e o serviço segue
  visível para o dependente (`has`, `get` e o `services` do comando). Tratá-lo como ausente
  exigiria esconder do registry, só para um plugin, um serviço já provido: um segundo estado de
  serviço, para um caso que o aviso já entrega ao operador.
- A conferência do `services` é só no registro. O que a refaz quando o provedor muda é o reload
  em cascata, que roda o `setup` (e o registro dos `commands` do manifesto) de novo.

## Consequências

- O comando que precisa de um serviço opcional some da ajuda e do menu sem `has` no `run`, e volta
  quando o provedor sobe, sem reiniciar o bot.
- O plugin com `optionalDependsOn` reinicia junto com o provedor, como o dependente do
  `dependsOn`: durante o reload, os comandos dele também ficam ausentes.
- Versão fora da faixa no opcional é aviso, não bloqueio: quem quer bloquear usa `dependsOn`.
- `services` sem `optionalDependsOn` (ou `dependsOn`) no provedor confere só no boot e depende da
  ordem de carga. A doc ensina os dois juntos.
- Serviço provido pelo próprio plugin conta se o `provide` vier antes do `add`; os `commands` do
  manifesto são registrados antes do `setup`, então não veem o que o próprio `setup` provê.
