# @usebridger/testing

Kit para testar plugins do [Bridger](https://www.npmjs.com/package/@usebridger/core) sem rede: um
bot de verdade sobre um transport falso, que guarda o que o bot envia, e matchers para o Vitest.

```sh
npm install -D @usebridger/testing vitest
```

```ts
import { createTestBot, fixtures } from '@usebridger/testing';
import { expect, it } from 'vitest';
import { sticker } from './index.ts';

it('imagem com !s vira figurinha', async () => {
  const bot = await createTestBot({ plugins: [sticker()] });

  await bot.receive({ text: '!s', image: fixtures.image() });

  expect(bot.sent).toContainSticker();
  await bot.stop();
});
```

Requer Node 24 ou mais novo.

- [Documentação](https://github.com/murillous/usebridger/blob/main/packages/testing/docs/README.md)

Licença [Apache-2.0](https://github.com/murillous/usebridger/blob/main/LICENSE).
