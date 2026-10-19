# Configuração

Cada plugin declara a própria config como um schema Zod no manifesto. O kernel junta os valores de
várias fontes, valida contra o schema e entrega ao plugin um objeto tipado em `ctx.config`. O
plugin nunca lê variável de ambiente nem arquivo ([ADR 0015](../adr/0015-config-por-plugin-zod.md)).
O tutorial é [Configurar sem mexer no código](/usebridger/comecando/configuracao/).

O schema é a fonte de tudo: o tipo do `ctx.config`, a validação, a conversão do texto das
variáveis de ambiente, os campos secretos e o formulário que um painel pode gerar. Por isso ele é
obrigatoriamente um `z.object`, importado de `@usebridger/core/zod`, a mesma cópia do Zod que o core
usa ([ADR 0091](../adr/0091-zod-no-subpath-do-core.md)).

## De onde vem a config e a precedência

Há quatro camadas. Para cada campo, vale a primeira que tem valor
([ADR 0028](../adr/0028-camadas-da-config-de-plugin.md)):

| Ordem | Camada | Quem escreve | Exemplo |
| --- | --- | --- | --- |
| 1 | variável de ambiente | quem faz o deploy | `BRIDGER_STICKER__QUALITY=90` |
| 2 | arquivo (`pluginConfig`) | o app | `pluginConfig: { sticker: { quality: 80 } }` |
| 3 | override no storage | um painel, em runtime | `bot.config.setOverrides('sticker', { quality: 70 })` |
| 4 | default do schema | o autor do plugin | `z.number().default(85)` |

A ordem segue quem tem a última palavra. O deploy manda mais que o código (é o padrão de doze
fatores, e é onde o segredo de produção mora); o código do app manda mais que um clique no painel;
e o autor do plugin dá só o ponto de partida. Um override sombreado por uma variável de ambiente
gera `warn`, porque o painel mostraria um valor que não está valendo.

O nome da variável é `BRIDGER_<PLUGIN>__<CAMPO>`, com `__` entre níveis
(`BRIDGER_USER_NAMES__OPENAI__API_KEY`). O prefixo evita colisão com outras ferramentas, e o `__`
separa sem ambiguidade nome de plugin e de campo. Só campos do schema são lidos, e o texto é
convertido para o tipo do campo.

Mudar um override recarrega o plugin (`teardown` e `setup` de novo) sem reiniciar o processo.
Código novo, ao contrário, pede restart ([ADR 0006](../adr/0006-sem-hot-reload.md)).

## Segredos

`secret(z.string())` marca um campo como segredo. A marca fica no schema, então vale em todo lugar
que lê o schema:

- o logger censura o valor em qualquer linha, inclusive depois de um reload que o troque;
- `bot.config.describe` mostra `'********'`;
- o JSON Schema exportado sai com `writeOnly` e `x-bridger-override: false`.

**Segredo não entra por override.** O override é gravado em texto puro no storage, e dali vai para
o arquivo do SQLite, para o Postgres e para todo backup deles. Um token colado num painel ficaria
espalhado nesses lugares sem ninguém perceber. Por isso `setOverrides` recusa campo secreto, e o
erro aponta a variável de ambiente e o caminho no `pluginConfig`, os dois lugares certos.

Um segredo só pode ficar em campo de objeto (em qualquer nível). Dentro de array, record ou union,
a config não o acharia para censurar, então o plugin é recusado; para uma lista secreta, marque o
campo inteiro.

## Os textos que o plugin manda

Não há i18n formal: os textos que o plugin mostra ao usuário ficam num objeto `messages` no
manifesto, e cada um pode ser sobrescrito pela config, com a mesma precedência dos campos
(`BRIDGER_AI__MESSAGES__THINKING`, `pluginConfig.ai.messages.thinking`)
([ADR 0022](../adr/0022-sem-i18n-objeto-messages.md)). Isso cobre tanto a tradução quanto o tom de
voz de cada bot, sem o peso de catálogos por idioma.

O texto aceita placeholders (`'Use {prefix}lembrar <minutos> <texto>'`), preenchidos por
`c.t(chave, valores)`; o `{prefix}` o kernel preenche com o prefixo do chat. A sobrescrita é
validada contra o texto padrão: ela pode mover ou omitir um placeholder, mas não pedir um que o
plugin não passa. O erro sai na config, e não na hora de responder
([ADR 0088](../adr/0088-placeholders-nas-messages.md)).

## Config inválida

O momento muda o que acontece, de propósito:

| Quando | O que acontece |
| --- | --- |
| No boot | O boot para antes de conectar, com um erro que lista cada campo, a fonte e o motivo ([ADR 0098](../adr/0098-plugin-falho-derruba-o-boot.md)) |
| Num `setOverrides` em runtime | A config nova é validada antes de salvar; inválida, é recusada e o plugin segue com a anterior |
| Num reload em runtime que falha | O plugin fica fora, com o motivo na tabela, e o bot segue no ar |

No boot ainda não há nada atendendo, então parar é barato e evita um bot que sobe sem metade dos
plugins sem ninguém notar. Em runtime, derrubar o processo por causa de um campo errado num painel
trocaria um plugin fora por um bot fora. A mensagem de erro nunca traz o valor recebido, porque
ele pode ser secreto.

## Formulários a partir do schema

`bot.config.jsonSchema(nome)` devolve o JSON Schema de entrada da config de um plugin. Um painel
gera o formulário a partir dele, sem conhecer o plugin: tipos, defaults, enums e descrições vêm do
Zod, e os campos secretos vêm marcados para o painel não oferecer edição. `bot.config.describe`
dá os valores atuais (com segredos mascarados) e a fonte de cada campo, para o painel mostrar que
um valor vem do ambiente e não pode ser mudado ali.

Esse é o caminho previsto para o painel, que é um plugin
([ADR 0019](../adr/0019-dashboard-vira-plugin.md)). A referência completa está em
[Config de plugin](../../packages/core/docs/config.md).
