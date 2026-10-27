# ADR 0129 — Bridger se apresenta como framework; "core" no dia a dia, "microkernel" como arquitetura

**Status:** Aceito (2026-10-27) · Ajusta o rótulo do [ADR 0030](0030-biblioteca-sem-runner.md)
("O Bridger é uma biblioteca"), sem mudar a decisão de não ter runner

## Contexto

Desde o plano, o Bridger se descreve como **kernel**: no README, na `description` do
`@usebridger/core`, no site e no guia de conceitos ("Kernel é o nome que fica"). A palavra veio do
padrão de arquitetura *microkernel* (núcleo mínimo, todo o resto em plugin), que descreve bem o
projeto.

Como nome de produto, porém, ela atrapalha:

- Fora de quem conhece o padrão, "kernel" lembra o Linux e sugere algo de baixo nível. Quem
  procura uma forma de fazer bot procura "framework"; no ecossistema JS (Fastify, grammY,
  discord.js) ninguém se apresenta como kernel.
- O vocabulário não bate: o pacote se chama `@usebridger/core`, mas a descrição dele diz "Kernel
  do Bridger". A mesma peça tem dois nomes.
- O Bridger deixou de ser um pacote só. São core, transports, storages, kit de testes, scaffold e
  plugins oficiais, usados juntos, com convenções em comum (manifesto, config, papéis, API HTTP).
  Isso é um framework.

O ADR 0030 chamou o Bridger de biblioteca para dizer que não há runner. O próprio guia de
conceitos já reconhece a inversão de controle depois do `start()`: o core decide quando rodar os
plugins, que é a definição de framework.

Alternativas consideradas: manter "kernel" e explicar o termo; "biblioteca", que contradiz a
inversão de controle e não cobre o conjunto de pacotes; "SDK", que sugere um cliente de API.

## Decisão

- **Na vitrine, o Bridger é um framework**: README, `description` dos `package.json`, site de
  docs, `CONTRIBUTING.md` e o template do `create-bridger-plugin` o apresentam como "framework de
  bots de mensageria extensível por plugins".
- **"Core" é o nome da peça central**, igual ao pacote `@usebridger/core`. Texto novo usa "core"
  onde antes usaria "kernel".
- **"Microkernel" fica como descrição da arquitetura**, com contexto: o core só tem o
  indispensável e todo o resto é plugin ([ADR 0011](0011-escopo-do-core.md)).
- **Continua sem runner** (ADR 0030): o app importa `createBot` e chama `start()`. Framework aqui
  quer dizer inversão de controle e um conjunto de pacotes com convenções, não um CLI que descobre
  a config.

## Consequências

- A troca na vitrine entra agora, antes do 1.0, quando mais gente vai ler. O changeset do core
  registra a nova `description`.
- ADRs anteriores não são reescritos: são registro histórico e continuam dizendo "kernel".
- Docs de pacote, comentários e nomes internos (`kernel.test.ts`, "log sem `event` no kernel")
  migram para "core" aos poucos, quando o arquivo for mexido. Não há renomeação em massa:
  "kernel" ali não está errado, só fora do padrão.
