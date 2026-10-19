# ADR 0082 — Plugins da Luma no LumaBot

**Status:** Aceito (2026-10-11), métricas e dashboard substituídos pelo **D103**
([ADR 0103](0103-plugins-oficiais-de-metricas-e-dashboard.md)) · Substitui os plugins oficiais do **D80**
([ADR 0080](0080-repositorios-separados.md)) · Mantém o **D19** ([ADR 0019](0019-dashboard-vira-plugin.md))

## Contexto

O D80 deixou no `usebridger` os plugins oficiais do M4 e do M5 (help, everyone, user-names,
utils, media, download, reminders, rank, ai, resumo, spontaneous, dashboard). Todos portam
funcionalidades do LumaBot. Escritos ao lado do kernel, eles veem o código-fonte do core, rodam
contra o workspace em vez do pacote publicado e puxam para a API pública atalhos que só a Luma
pede.

O que o Bridger precisa provar é outra coisa: que qualquer pessoa monta um chatbot instalando
os `@usebridger/*` do npm e escrevendo os plugins dela sobre os transports da biblioteca.

Alternativas consideradas: manter todos no kernel; levar só os da Luma (M5) e deixar os
genéricos do M4 como oficiais.

## Decisão

- **O kernel não publica plugins.** O `usebridger` fica com os `packages/*` (core, transports,
  storages, testing e o `create-bridger-plugin`), o `bench/` e o `tooling/`. O workspace deixa de
  ter `plugins/*`.
- **Os plugins do M4 e do M5 viram código do app** em `murillous/LumaBot`, em
  `apps/lumabot/src/plugins/<nome>`, escritos só com a API pública dos pacotes do npm. As issues
  deles vão para o `LumaBot`, com o M5-5 e o v1.0 que já estavam lá.
- Continua valendo a Luma como plugin (`plugin-ai`), o D19 (dashboard é plugin) e a checklist de
  paridade: muda onde o código mora, não a forma.
- Se a Luma precisar de algo que a API pública não dá, a issue é aberta no `usebridger`, e a
  solução entra no core e chega ao app por uma versão publicada.

## Consequências

- O LumaBot é a prova de que a biblioteca basta: um consumidor sem acesso ao código do core.
- Toda lacuna de API só chega ao app depois de um release, o que torna o ciclo mais lento.
- Sem plugins prontos no kernel, quem começa um bot parte do `create-bridger-plugin` e dos
  guias. Um plugin genérico pode voltar a ser oficial por um ADR novo, depois de provado no app.
- O release e o `pnpm check:packages` cobrem só os `packages/*`.
