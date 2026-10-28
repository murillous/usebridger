# Configuração

Esta página explica como a config de um plugin chega ao código dele: de onde vêm os valores, quem
vence quando há conflito, como guardar segredos e o que acontece com um valor inválido.

Cada plugin declara a própria config como um schema Zod no manifesto. O kernel junta os valores de
várias fontes, valida contra o schema e entrega ao plugin um objeto tipado em `ctx.config`. O
plugin nunca lê variável de ambiente nem arquivo. O tutorial é
[Configurar sem mexer no código](/usebridger/comecando/configuracao/).

```ts
import { definePlugin, secret } from '@usebridger/core';
import { z } from '@usebridger/core/zod';

export const ia = definePlugin({
  name: 'ia',
  version: '1.0.0',
  engine: '<1.0.0',
  config: z.object({
    modelo: z.string().default('flash'),
    apiKey: secret(z.string().min(8)), // obrigatório e secreto
  }),
  setup(ctx) {
    ctx.config.modelo; // string, com o default aplicado
  },
});
```

O schema é a fonte de tudo: o tipo do `ctx.config`, a validação, a conversão do texto das
variáveis de ambiente, os campos secretos e o formulário que um painel pode gerar. Por isso ele é
obrigatoriamente um `z.object`, importado de `@usebridger/core/zod`, a mesma cópia do Zod que o core
usa, para não haver duas cópias do Zod com tipos incompatíveis.

## De onde vem a config e a precedência

Há cinco camadas. Para cada campo, vale a primeira que tem valor:

| Ordem | Camada | Quem escreve | Exemplo |
| --- | --- | --- | --- |
| 1 | variável de ambiente | quem faz o deploy | `BRIDGER_STICKER__QUALITY=90` |
| 2 | arquivo (`pluginConfig`) | o app | `pluginConfig: { sticker: { quality: 80 } }` |
| 3 | segredo no storage, cifrado | um painel, em runtime (só campos `secret`) | `bot.config.setSecret('ia', 'apiKey', valor)` |
| 4 | override no storage | um painel, em runtime | `bot.config.setOverrides('sticker', { quality: 70 })` |
| 5 | default do schema | o autor do plugin | `z.number().default(85)` |

A ordem segue quem tem a última palavra. O deploy manda mais que o código (é o padrão de doze
fatores, e é onde o segredo de produção mora); o código do app manda mais que um clique no painel;
e o autor do plugin dá só o ponto de partida. Um override sombreado por uma variável de ambiente
gera `warn`, porque o painel mostraria um valor que não está valendo.

O nome da variável é `BRIDGER_<PLUGIN>__<CAMPO>`, com `__` entre níveis
(`BRIDGER_USER_NAMES__OPENAI__API_KEY`). O prefixo evita colisão com outras ferramentas, e o `__`
separa sem ambiguidade nome de plugin e de campo. Só campos do schema são lidos, e o texto é
convertido para o tipo do campo.

Mudar um override ou um segredo recarrega o plugin (`teardown` e `setup` de novo) sem reiniciar o
processo. Código novo, ao contrário, pede restart.

## Segredos

`secret(z.string())` marca um campo como segredo. A marca fica no schema, então vale em todo lugar
que lê o schema:

- o logger censura o valor em qualquer linha, inclusive depois de um reload que o troque;
- `bot.config.describe` mostra `'********'`;
- o JSON Schema exportado sai com `writeOnly` e `x-bridger-override: false`.

**Segredo não entra por override.** O override é gravado em texto puro no storage, e dali vai para
o arquivo do SQLite, para o Postgres e para todo backup deles. Por isso `setOverrides` recusa campo
secreto, e o erro aponta os caminhos certos:

- **variável de ambiente ou `pluginConfig`**: o jeito normal em produção;
- **`bot.config.setSecret(plugin, caminho, valor)`**: grava o segredo **cifrado** (AES-256-GCM) no
  storage, para um painel poder editá-lo. Pede a chave mestra `BRIDGER_SECRET_KEY` (32 bytes em
  base64; gere uma com `openssl rand -base64 32`). Sem a chave, `setSecret` rejeita e o resto
  segue funcionando.

```ts
await bot.config.setSecret('ia', 'apiKey', 'sk-...'); // cifrado no storage
await bot.config.clearSecret('ia', 'apiKey'); // remove
```

Guarde a chave fora do banco e do backup dele: quem tem os dois tem os segredos, e perder a chave
perde os segredos salvos desse jeito (variável de ambiente e arquivo não são afetados). Para trocar
a chave, suba o bot com a nova em `BRIDGER_SECRET_KEY` e a antiga em `BRIDGER_SECRET_KEY_PREVIOUS`:
no boot o core recifra tudo. Se o env ou o arquivo já definem o campo, `setSecret` recusa, porque
o valor salvo nunca valeria.

Um segredo só pode ficar em campo de objeto (em qualquer nível). Dentro de array, record ou union,
a config não o acharia para censurar, então o plugin é recusado; para uma lista secreta, marque o
campo inteiro.

## Os textos que o plugin manda

Não há i18n formal: os textos que o plugin mostra ao usuário ficam num objeto `messages` no
manifesto, e cada um pode ser sobrescrito pela config, com a mesma precedência dos campos
(`BRIDGER_AI__MESSAGES__THINKING`, `pluginConfig.ai.messages.thinking`). Isso cobre tanto a tradução quanto o tom de
voz de cada bot, sem o peso de catálogos por idioma.

```ts
definePlugin({
  name: 'ai',
  version: '1.0.0',
  engine: '<1.0.0',
  messages: { thinking: 'Pensando…' },
  commands: { ia: { run: (c) => c.t('thinking') } },
});
// o dono do bot troca o tom sem mexer no plugin:
// createBot({ pluginConfig: { ai: { messages: { thinking: 'Um instante...' } } } })
```

O texto aceita placeholders (`'Use {prefix}lembrar <minutos> <texto>'`), preenchidos por
`c.t(chave, valores)`; o `{prefix}` o kernel preenche com o prefixo do chat. A sobrescrita é
validada contra o texto padrão: ela pode mover ou omitir um placeholder, mas não pedir um que o
plugin não passa. O erro sai na config, e não na hora de responder.

## Config inválida

O momento muda o que acontece, de propósito:

| Quando | O que acontece |
| --- | --- |
| No boot | O boot para antes de conectar, com um erro que lista cada campo, a fonte e o motivo |
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

É assim que o dashboard monta a tela de config de qualquer plugin. A API HTTP do core expõe o
mesmo (`GET` e `PUT /api/plugins/<nome>/config`), então um painel seu também pode usá-lo. A
referência completa está em [Config de plugin](../../packages/core/docs/config.md).
