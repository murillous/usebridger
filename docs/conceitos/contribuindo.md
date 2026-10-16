# Contribuindo

As regras práticas (fork, branch, commits, definição de pronto) estão no
[CONTRIBUTING.md](../../CONTRIBUTING.md). Aqui está o porquê do caminho.

## Propor uma mudança no core

O caminho é **issue → ADR (quando há decisão) → PR**, nessa ordem.

1. **Issue primeiro.** Bug vem com os passos para reproduzir. Feature ou mudança de API espera o
   alinhamento antes do código, porque o escopo do core é fechado
   ([ADR 0013](../adr/0013-escopo-do-core.md)): muita coisa cabe melhor num plugin, e a primeira
   pergunta da revisão é "por que isso não é plugin?". Se a resposta é "porque falta API", a issue
   é sobre a API que falta, não sobre o recurso.
2. **ADR quando há decisão de arquitetura.** Um ADR registra contexto, alternativas consideradas,
   decisão e consequências ([formato](../adr/README.md#formato)). Ele existe porque o código diz o
   que foi feito, mas não o que foi descartado e por quê; sem esse registro, a mesma discussão volta
   a cada contribuidor novo. ADR aceito não é reescrito: mudar de ideia é um ADR novo que substitui
   o anterior, e o antigo passa a apontar para ele.
3. **PR contra a `develop`**, com testes para o comportamento novo, docs do como-fazer e um
   changeset se mudou um pacote publicado. Os testes existentes ficam intactos: um teste que parece
   errado é conversa com o mantenedor, não edição.

Nem toda mudança precisa de ADR. Corrigir um bug, melhorar uma mensagem de erro ou acrescentar um
exemplo não decide nada; trocar o comportamento de uma fila, acrescentar um campo ao contrato do
`Transport` ou mudar o que derruba o boot decide.

## Escrever um transport

Um transport é um adapter: traduz a plataforma para o modelo neutro e o modelo neutro para a
plataforma. O core não sabe nada dela além do que o transport declara
([ADR 0003](../adr/0003-transport-abstrato.md)).

O caminho curto é `defineTransport`, de `@usebridger/core/adapter`. Você descreve o nome, as
capabilities e os métodos, e o kernel monta o resto: o emissor de eventos, o `self`, a checagem de
capability antes de cada método e o `UnsupportedError` para o que não foi implementado
([ADR 0080](../adr/0080-acucar-para-o-autor-de-transport.md)). O resultado é uma fábrica, que recebe
do bot a sessão, o auth state, o logger e o HTTP ([ADR 0037](../adr/0037-transport-por-fabrica.md)).

As decisões que dão trabalho num transport novo:

- **Capabilities honestas.** Declare só o que a plataforma faz de verdade. O `createBot` confere se
  cada capability declarada tem o método dela. Um plugin confia na lista para escolher o caminho.
- **Ids estáveis.** O `chat.id` e o `id` do contato viram chave de storage, de espera de conversa e
  de limite de taxa. Eles não podem mudar entre reconexões
  ([ADR 0046](../adr/0046-ids-de-contato-e-metadata-de-grupo.md)).
- **Tipos sem equivalente** chegam como `unknown`, com o objeto original no `raw()`. No envio, o
  `default` do `switch` lança `UnsupportedError` ([ADR 0069](../adr/0069-unioes-de-tipo-antes-do-1-0.md)).
- **Motivo da queda.** Mapeie os erros da plataforma para os motivos de desconexão do core:
  credencial recusada, erro de configuração (`fatal`), conexão substituída, queda de rede. É disso
  que a política de reconexão decide entre reconectar, re-parear e parar
  ([ADR 0068](../adr/0068-desconexao-fatal-e-transport-sem-pareamento.md)).
- **Erros de envio.** Diga se o erro é re-tentável e, num 429, quanto esperar (`retryAfterMs`). Se a
  plataforma tem ritmo próprio, declare `pacing`
  ([ADR 0067](../adr/0067-retry-after-e-ritmo-do-transport.md)).
- **Formatação e limites.** Traduza a árvore do `fmt` para a marcação da plataforma e declare os
  limites de tamanho, para a fila dividir o texto ([ADR 0061](../adr/0061-texto-formatado-neutro.md)).

O guia de referência é [Transport](../../packages/core/docs/transport.md); o
[`transport-web`](../../packages/transport-web/docs/README.md) é o exemplo mais curto de um
transport completo. Um transport novo também ganha um perfil no kit de testes, conferido contra o
que ele declara ([ADR 0073](../adr/0073-kit-de-testes-multiplataforma.md)).

Transports para plataformas públicas (Telegram, Discord) entram neste repositório, sob Apache-2.0.
Se o seu transport precisa de algo que o contrato não tem, isso é uma mudança no core: abra a
issue antes, porque o mesmo campo vai servir aos outros transports
([ADR 0055](../adr/0055-plataformas-alvo-e-transport-web.md)).
