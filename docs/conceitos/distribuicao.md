# Distribuindo plugins

O kernel não publica plugins ([ADR 0086](../adr/0086-plugins-da-luma-no-lumabot.md)): todo plugin,
inclusive os do LumaBot, é código de quem o escreve, num repositório próprio ou dentro do app. Há
dois caminhos para um plugin chegar ao bot, e os dois produzem o mesmo objeto
([ADR 0007](../adr/0007-plugins-via-npm-e-pasta.md)).

## Num repositório próprio, publicado no npm

O scaffold cria o projeto pronto para publicar
([ADR 0081](../adr/0081-create-bridger-plugin.md)):

```sh
npm create bridger-plugin@latest bridger-plugin-ola
```

Ele traz o plugin na forma curta, teste em todos os perfis de plataforma, `tsdown` para gerar o
`dist/` com os tipos, e changesets para versão e changelog. O nome do manifesto sai do nome do
pacote sem escopo e sem o prefixo `bridger-plugin-`. O prefixo e a keyword `bridger-plugin` no
`package.json` existem para o plugin ser achado no npm.

Para publicar:

- **público:** `npm publish` (com escopo, `npm publish --access public` na primeira vez);
- **privado:** um pacote com escopo numa organização paga do npm, ou num registry privado
  (GitHub Packages, Verdaccio). O bot instala com o `.npmrc` apontando o escopo para o registry.
  É assim que os plugins e transports comerciais do projeto são distribuídos
  ([ADR 0029](../adr/0029-open-core-repo-privado.md)).

## Plugar no bot

Um plugin publicado é uma dependência comum: o app instala, importa e põe na lista.

```ts
import { ola } from 'bridger-plugin-ola';

const bot = createBot({ transport, storage, plugins: [ola] });
```

O app escolhe a ordem, quais plugins entram e a config de cada um. Não há descoberta automática
em `node_modules`: o que roda é o que está na lista, e uma dependência instalada por outro motivo
não vira plugin sem querer.

### Durante o desenvolvimento

Enquanto o plugin não está no npm, o bot o instala pela pasta:

```sh
# na pasta do plugin
npm run build
# na pasta do bot
npm install ../bridger-plugin-ola
```

O npm cria um link para a pasta, e o pnpm faz o mesmo com `"bridger-plugin-ola": "link:../bridger-plugin-ola"`
no `package.json`. Depois de mudar o plugin, rode o `build` de novo e reinicie o bot: não há
hot-reload de código ([ADR 0008](../adr/0008-sem-hot-reload.md)).

Num link, o plugin importa o `@usebridger/core` da pasta **dele** (a dev dependency), e o bot, o da
pasta do bot. Quase tudo funciona assim, porque o plugin é um objeto comum. O que compara
identidade quebra: um `err instanceof ContextExpiredError` no plugin não reconhece o erro lançado
pela cópia do bot. Para testar exatamente o que vai ao npm, use `npm pack` no plugin e instale o
`.tgz` no bot: o core vem só do bot, como em produção.

## Versão do plugin em relação ao core

O plugin declara o core em dois lugares, e cada um protege um momento diferente:

- **`peerDependencies` no `package.json`**: avisa na **instalação**. O core é peer, e não
  dependência, porque o bot precisa de uma cópia só do kernel, a que ele mesmo instalou.
- **`engine` no manifesto**: confere na **execução**, contra a versão do core que de fato carregou.
  Fora da faixa, o boot para e diz qual plugin e por quê
  ([ADR 0016](../adr/0016-manifesto-do-plugin.md)).

Mantenha as duas faixas iguais. No `0.x`, a regra do `^` do npm trava no minor: `^0.3.0` aceita só
`0.3.x`. O template começa com `<1.0.0`, que aceita qualquer `0.x`; um plugin que quer se proteger
de mudança incompatível num minor declara `^0.M.0`, com o minor contra o qual foi testado, e
publica uma versão nova a cada minor do core
([Plugins → qual `engine` declarar](../../packages/core/docs/plugins.md#qual-engine-declarar-no-0x)).
Na 1.0, as duas faixas passam a `^1.0.0`.

A versão do próprio plugin (`version` no manifesto) acompanha a do `package.json`. Ela é o que os
outros plugins conferem no `dependsOn`, então siga o semver: quebrou o service, sobe o major (ou o
minor, no `0.x`).

## Plugins de pasta

`pluginDirs: ['./plugins']` carrega todo arquivo `.ts`/`.js` (ou subpasta com `index.*`) da pasta.
É o caminho para plugins que vivem dentro do app e não vão ao npm. As diferenças para os de npm:

| | npm (`plugins`) | pasta (`pluginDirs`) |
| --- | --- | --- |
| Quem escolhe | o app importa cada um | todo módulo da pasta entra |
| Ordem padrão | a da lista | depois dos da lista, em ordem alfabética |
| Build | o pacote traz `dist/` | `.ts` roda pelo type stripping do Node 24 (só sintaxe apagável) |
| Versão e dependências | do pacote | do app |
| Erro de import | o app falha ao importar | `PluginDiscoveryError` no boot, com o caminho |

Ficam de fora arquivos que começam com `_` ou `.`, testes e `.d.ts`, então helpers vão num
`_util.ts`. Fora isso, o plugin é o mesmo: manifesto, `engine`, `requires`, config e teste iguais.
Um plugin de pasta que cresce vira pacote sem mudar o código.
