# Perguntas frequentes

Cada pergunta aponta para a página que a responde. As respostas não se repetem aqui, para não
envelhecerem em dois lugares.

## Visão geral

- [O Bridger é SDK, framework ou kernel? Quem chama quem?](visao-geral.md#sdk-framework-ou-kernel-quem-chama-quem)
- [No que ele se parece e no que difere de Baileys, whatsapp-web.js, BuilderBot, Koishi, NoneBot2 e Chat SDK?](comparacao.md)
- [Quando **não** usar o Bridger?](visao-geral.md#quando-não-usar)
- [O que é core e o que é plugin? Por que o escopo do core é fechado?](visao-geral.md#o-que-é-core-e-o-que-é-plugin)
- [Quais plataformas são suportadas hoje e quais estão planejadas?](visao-geral.md#plataformas)
- [O que garante a estabilidade da API antes do 1.0?](visao-geral.md#estabilidade-antes-do-10)

## Montando um bot

- [Qual o mínimo para subir um bot?](bot-e-sessao.md#o-mínimo-para-subir-um-bot)
- [O que cada peça (`transport`, `storage`, `plugins`, `logger`, `http`) faz?](bot-e-sessao.md#o-que-cada-peça-faz)
- [Como parear: QR ou código?](bot-e-sessao.md#pareamento-qr-ou-código)
- [O que acontece se a sessão cair ou for desconectada?](bot-e-sessao.md#quando-a-sessão-cai)
- [Posso rodar vários números no mesmo processo? E vários processos com a mesma sessão?](bot-e-sessao.md#vários-bots-e-vários-processos)
- [SQLite ou Postgres? Quando trocar?](bot-e-sessao.md#sqlite-ou-postgres)
- [Como subir o HTTP e expor rotas?](bot-e-sessao.md#http)
- [Por que o kernel não tem autenticação, e o que fazer a respeito?](bot-e-sessao.md#por-que-o-kernel-não-tem-autenticação)

## Escrevendo plugins

- [Qual a diferença entre `commands`/`on` no manifesto e o `setup`?](plugins.md#manifesto-e-setup)
- [Como escolher o `requires` mínimo, e quando conferir `ctx.capabilities` em vez de exigir?](plugins.md#exigir-uma-capability-ou-conferir)
- [Como um plugin usa outro (`services`, `dependsOn`, `after`, `priority`)?](plugins.md#um-plugin-que-usa-outro)
- [Como um plugin **estende** outro?](plugins.md#estender-outro-plugin)
- [Como guardar dados (`ctx.storage`, coleções, tenant, `shared`)?](plugins.md#onde-guardar-dados)
- [Como fazer uma conversa de vários passos? E se o usuário digitar um comando no meio, ou não responder?](mensagem.md#conversa-de-vários-passos)
- [Como agendar algo? O que sobrevive a um restart?](plugins.md#agendar-e-o-que-sobrevive-a-um-restart)
- [Como mandar mídia, botões, enquetes e reações, e o que acontece numa plataforma sem esse recurso?](plugins.md#mídia-botões-enquetes-e-reações)
- [Como escrever texto formatado que funciona em qualquer plataforma (`fmt`)?](plugins.md#texto-formatado-em-qualquer-plataforma)
- [Como tratar erros e cancelamento (`signal`, prazos, `ContextExpiredError`)?](mensagem.md#prazos-e-cancelamento)
- [Por que um comando lento atrasa as outras mensagens do chat?](mensagem.md#fila-de-entrada-um-chat-por-vez)
- [Quando usar `ctx.unsafe`, e qual o preço?](plugins.md#escape-hatch-e-o-preço-dele)

## Distribuindo plugins

- [Como criar um plugin num repositório próprio e publicá-lo no npm (público ou privado)?](distribuicao.md#num-repositório-próprio-publicado-no-npm)
- [Como plugar um plugin publicado num bot?](distribuicao.md#plugar-no-bot)
- [E durante o desenvolvimento (`link:`)?](distribuicao.md#durante-o-desenvolvimento)
- [Como versionar o plugin em relação ao core (`peerDependencies`, `engine`)?](distribuicao.md#versão-do-plugin-em-relação-ao-core)
- [Como plugins carregados de pasta (`pluginDirs`) diferem dos de npm?](distribuicao.md#plugins-de-pasta)

## Configuração

- [De onde vem a config, e qual a precedência?](configuracao.md#de-onde-vem-a-config-e-a-precedência)
- [Como marcar segredos, e por que eles não entram por override?](configuracao.md#segredos)
- [Como sobrescrever os textos que o plugin manda (`messages`)?](configuracao.md#os-textos-que-o-plugin-manda)
- [O que acontece com uma config inválida, no boot e em runtime?](configuracao.md#config-inválida)
- [Como um painel gera formulários a partir do schema?](configuracao.md#formulários-a-partir-do-schema)

## Testes

- [Como testar um plugin sem rede?](testes.md#sem-rede-o-bot-inteiro-com-um-transport-falso)
- [Como testar em vários perfis de plataforma?](testes.md#vários-perfis-de-plataforma)
- [Como testar conversas, agendamentos e falhas?](testes.md#conversas-agendamentos-e-falhas)

## Operação

- [Como ler a tabela de boot, e por que um plugin foi ignorado?](operacao.md#a-tabela-de-boot)
- [Como funciona a fila de saída (anti-ban, ritmo, retry)?](operacao.md#a-fila-de-saída-em-produção)
- [Quais métricas de performance o projeto mira?](operacao.md#métricas-de-performance)
- [Como migrar um bot existente para o Bridger aos poucos?](operacao.md#migrar-um-bot-existente-aos-poucos)
- [Como rodar em produção (supervisor, `/health`, logs, backup)?](/usebridger/comecando/producao/)

## Contribuindo

- [Como propor uma mudança no core (issue, ADR, PR)?](contribuindo.md#propor-uma-mudança-no-core)
- [Como escrever um transport novo?](contribuindo.md#escrever-um-transport)
