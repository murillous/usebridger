# Plugins

Um plugin é um objeto criado por `definePlugin`: um **manifesto** (nome, versão, faixa do core, o
que ele exige) mais o comportamento. O kernel lê o manifesto antes de rodar qualquer código do
plugin, e é isso que permite recusar o incompatível no boot em vez de falhar no meio de uma
conversa ([ADR 0014](../adr/0014-manifesto-do-plugin.md)).

## Manifesto e setup

Há duas formas de declarar o comportamento, e elas levam ao mesmo lugar
([ADR 0075](../adr/0075-acucar-no-manifesto-do-plugin.md)):

- **`commands` e `on` no manifesto**: um objeto nome → comando e outro evento → listener. É a
  forma curta, e o que o template gera. O `run` que devolve texto responde.
- **`setup(ctx)`**: uma função que roda no boot com o contexto do plugin e registra o que quiser
  com `ctx.commands.add`, `ctx.events.on` e o resto da API.

Por dentro, o host registra os `commands` e os `on` do manifesto com as mesmas chamadas do
`setup`, antes do `setup` do plugin. Prazo, conflito de nome, teardown e reload são idênticos. A
forma curta não é outra API: é a mesma, sem a cerimônia.

Use o manifesto para o que é fixo, e o `setup` para o que depende de algo resolvido no boot:

- oferecer ou consumir um service, registrar handlers de job (`ctx.scheduler.on`), passos de
  conversa, papéis custom e rotas HTTP;
- vários listeners do mesmo evento, ou listener com filtro e prioridade;
- comandos que dependem da config.

As duas formas convivem no mesmo plugin.

## Exigir uma capability ou conferir

Cada transport declara capabilities, e o plugin escolhe como lidar com cada uma
([ADR 0008](../adr/0008-capabilities-do-transporte.md)):

- **Exigir em `requires`** quando o plugin não faz sentido sem ela. Um plugin de figurinhas sem
  `send.sticker` não tem o que fazer. Num transport sem a capability, o boot para antes de
  conectar e diz o que faltou; para subir o bot sem esse plugin, o operador o põe em
  `disabledPlugins` ([ADR 0098](../adr/0098-plugin-falho-derruba-o-boot.md)).
- **Conferir em `ctx.capabilities.has(...)`** quando ela é um extra. O plugin sobe em todo
  transport e usa o recurso onde ele existe, com outro caminho onde não existe.
- **Exigir num comando só**, com `command({ requires })`, quando um comando depende dela e o resto
  do plugin não. Sem a capability, só aquele comando fica de fora do roteador, da ajuda e do menu
  nativo ([ADR 0086](../adr/0086-requires-por-comando.md)).

A regra é **exigir o mínimo**: cada capability em `requires` tira o plugin de uma plataforma
inteira. `commands` no manifesto já soma `send.text`. Em runtime, usar uma capability que o
transport não tem rejeita com `UnsupportedError`; isso é a rede de segurança, não o caminho
normal.

## Mídia, botões, enquetes e reações

Mídia, botões, enquetes e reações são capabilities, e cada uma tem um comportamento definido onde
falta, escolhido pelo que faz sentido para quem está do outro lado:

| Recurso | Sem a capability |
| --- | --- |
| Enviar imagem, vídeo, áudio, documento, figurinha, álbum | Rejeita com `UnsupportedError`; exija em `requires` ou confira antes |
| Botões (`reply(texto, { actions })`) | O kernel acrescenta uma lista numerada ao texto e aceita o número como resposta ([ADR 0058](../adr/0058-acoes-e-botoes.md)) |
| Reação pelo atalho do contexto (`c.react`) | Não faz nada e registra em `debug`: a reação é enfeite ([ADR 0089](../adr/0089-react-do-contexto-tolerante.md)) |
| Reação por `ctx.send.react` | Rejeita: é o caminho de quem precisa saber se saiu |
| Enquete (`reply.poll`) | Rejeita; confira `polls` antes |
| Texto formatado | Sai sem a marcação, como texto visível |

A matriz do que cada transport suporta está em [Capabilities](../guias/capabilities.md#matriz-por-transport).

## Texto formatado em qualquer plataforma

Cada plataforma marca negrito de um jeito (`*a*`, `**a**`, HTML). O plugin portátil escreve com
os helpers do core, `` fmt`Notas de ${bold(nome)}` ``, que montam uma árvore neutra, e o
transport a traduz para a marcação dele, com o escape certo
([ADR 0057](../adr/0057-texto-formatado-neutro.md)).

Duas propriedades importam mais que a sintaxe: o valor interpolado é **literal** (um `*` digitado
pelo usuário não vira negrito nem quebra a marcação), e `mention(contato)` gera a menção certa em
cada plataforma. Texto cru continua aceito e vai como veio, para o plugin de uma plataforma só.

## Um plugin que usa outro

Plugins conversam por **services**, nunca importando o estado um do outro
([ADR 0016](../adr/0016-service-registry.md)):

- o provedor publica com `ctx.services.provide('traducao', impl)`;
- o consumidor declara `dependsOn: { traducao: '^1.0.0' }` e pega com `ctx.services.get`;
- o tipo vem por declaration merging na interface `Services`, exportada pelo pacote do provedor.

Por que um registry em vez de `import`? Porque o serviço é **uma instância viva**, com a config
e o storage do provedor, e pode ser recarregado. O `import` daria o código, não a instância que o
bot carregou. Quando o provedor recarrega, quem depende dele por `dependsOn` recarrega junto, para
não ficar segurando um serviço de um contexto já descartado
([ADR 0037](../adr/0037-reload-em-cascata.md)).

Os campos de ordem e dependência servem a coisas diferentes:

| Campo | Ordena a carga | Sem o outro plugin | Recarrega junto |
| --- | --- | --- | --- |
| `dependsOn` | sim | o boot para (ou o consumidor fica fora, num reload) | sim |
| `optionalDependsOn` | sim | sobe; confira com `ctx.services.has` | sim |
| `after` | sim | sobe | não |
| `priority` | entre os que não têm aresta, maior primeiro | — | não |

`command({ services: [...] })` faz pelo service o que o `requires` por comando faz pela
capability: sem o serviço, só aquele comando fica de fora
([ADR 0095](../adr/0095-comando-que-exige-servico.md)).

### Estender outro plugin

Quando outros plugins acrescentam peças a um serviço (etapas de um pipeline, formatos de um
exportador), o provedor abre um **ponto de extensão** e os outros contribuem com
`ctx.services.contribute(nome, peça)`. O kernel sabe de quem é cada contribuição e a retira
quando aquele plugin desce, recarrega ou é desligado, coisa que um `Set` guardado pelo provedor
não saberia fazer ([ADR 0092](../adr/0092-pontos-de-extensao-em-servicos.md)).

## Onde guardar dados

`ctx.storage` dá ao plugin um espaço só dele, com duas formas
([ADR 0013](../adr/0013-storage-kv-e-colecoes.md)):

- **KV**, para valores avulsos por chave (`kv.get`, `kv.set`);
- **coleções**, para documentos com filtro, ordenação, limite e índices declarados.

Não há SQL cru: a mesma chamada funciona no SQLite, no Postgres e na memória dos testes, e o
plugin não sabe qual está embaixo. Os valores são JSON e voltam sempre como cópia.

O escopo é automático em três níveis, para o plugin não precisar compor chaves:

- **sessão**: cada bot tem seus dados ([Bot e sessão](bot-e-sessao.md#sessão));
- **tenant**: num transport com clientes separados (o web, com o tenant vindo do token), o mesmo
  `ctx.storage` resolve os dados do cliente da mensagem corrente, inclusive em services e timers
  iniciados ali ([ADR 0068](../adr/0068-isolamento-por-tenant.md));
- **compartilhado**: `ctx.storage.shared` é do plugin em todas as sessões, para um dado comum a
  vários números ([ADR 0071](../adr/0071-varios-bots-e-escopo-compartilhado.md)).

O plugin nunca alcança os dados de outro plugin nem os do kernel. Para dividir dados, ofereça um
service.

## Agendar e o que sobrevive a um restart

`ctx.scheduler.at(quando, job, payload)` agenda, e `ctx.scheduler.on(job, handler)`, registrado no
`setup`, trata. O job fica no storage e dispara **pelo menos uma vez**: só sai depois que o
handler termina, então um crash no meio faz o job rodar de novo no boot. O handler deve tolerar
uma repetição rara ([Scheduler](../guias/scheduler.md#pelo-menos-uma-vez)).

| Sobrevive a um restart | Se perde |
| --- | --- |
| Dados do `ctx.storage` | `setTimeout` e estado em variáveis do plugin |
| Jobs do scheduler | Esperas de conversa sem `persist: true` |
| Esperas de conversa com `persist: true` | Botões enviados (o clique depois do restart é ignorado) |
| Overrides de config e credenciais da sessão | O que estava na fila de saída |

## Erros e cancelamento

O plugin não precisa de `try/catch` para proteger o bot: o kernel isola cada execução e reporta a
falha. Ele trata erro quando quer **dizer algo ao usuário** ou **tentar de novo**. O que o plugin
precisa respeitar é o `signal`: repassá-lo a `fetch` e SDKs, e não insistir em efeitos depois do
prazo, quando o contexto os recusa com `ContextExpiredError`. O modelo inteiro está em
[O caminho da mensagem → prazos](mensagem.md#prazos-e-cancelamento).

## Escape hatch e o preço dele

A API do core cobre o que as plataformas têm em comum. Para o resto, `ctx.unsafe.native` dá o
cliente da biblioteca (o socket do Baileys) e `ctx.unsafe.raw(message)` dá o objeto original da
mensagem, ambos como `unknown` ([ADR 0009](../adr/0009-escape-hatch-unsafe-native.md),
[ADR 0062](../adr/0062-objeto-bruto-da-mensagem.md)).

O preço:

- o plugin fica **preso ao transport**: declare `transports: ['baileys']`, para o boot recusá-lo
  nos outros em vez de ele quebrar;
- o tipo é seu: o formato da biblioteca muda sem o semver do Bridger;
- nada do kernel vale ali: um envio pelo socket pula a fila de saída, e com ela o ritmo anti-ban e
  o retry;
- o primeiro uso loga um `warn` com o plugin e o transport.

O aviso é proposital: o que os plugins buscam fora da API é o que vira API depois. Se o que falta é
comum a várias plataformas, abra uma issue, a lacuna é do core.
