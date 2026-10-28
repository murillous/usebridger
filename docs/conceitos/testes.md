# Testes

Esta página explica como o kit de testes (`@usebridger/testing`) funciona e o que ele garante.

O kit faz parte do contrato público, no mesmo nível dos tipos: um plugin que só se testa com um
WhatsApp de verdade não é um plugin que um terceiro consegue manter. O como-fazer está no guia [Testes](../guias/testes.md) e
na [referência do kit](../../packages/testing/docs/README.md).

## Sem rede: o bot inteiro, com um transport falso

`@usebridger/testing` não simula o plugin; ele sobe um **bot de verdade** sobre um
`FakeTransport`, que não abre conexão. `createTestBot({ plugins })` passa pelo mesmo boot, pelas
mesmas filas, pelo mesmo roteador e pela mesma fila de saída de produção. O que muda são os
padrões, escolhidos para o teste ser rápido e determinístico: log em silêncio, storage em memória,
fila de saída sem intervalo, sem reconexão e sem nenhuma variável `BRIDGER_*` da máquina.

```ts
import { createTestBot } from '@usebridger/testing';
import { expect, it } from 'vitest';
import { ola } from './index.ts';

it('cumprimenta', async () => {
  const bot = await createTestBot({ plugins: [ola] });
  await bot.receive({ text: '!ola' });
  expect(bot.sent).toContainText('Olá');
  await bot.stop();
});
```

A peça que torna isso confiável é o `receive()`: ele entrega a mensagem e só resolve quando o bot
**assentou**, isto é, quando tudo o que a mensagem causou terminou, inclusive envios feitos sem
`await` e comandos em segundo plano. Sem
isso, todo teste precisaria de um `sleep` e seria intermitente. Depois do `receive()`, `bot.sent`
já tem as respostas, e os matchers (`toContainText`, `toHaveReplied`) comparam o texto visível.

Testar pelo bot inteiro, e não chamando o `run` direto, pega os erros que vivem na fronteira:
papel errado, `accepts` que recusa, comando que outro plugin já registrou, capability que falta.

## Vários perfis de plataforma

O kit tem perfis de plataforma: `whatsapp`, `telegram`, `discord` e `web`, cada um com as
capabilities, os limites de tamanho e o formato de contato daquela plataforma. O do `whatsapp` é
conferido contra o que o transport Baileys declara, num teste do próprio transport. O `web`
também. Os perfis `telegram` e `discord` seguem o que se espera dessas plataformas: o transport
real do Telegram ainda não tem álbum nem enquete, que o perfil já inclui, então um teste verde no
perfil `telegram` não garante o envio disso no Telegram de verdade.

O plugin portátil roda o mesmo teste em todos:

```ts
import { createTestBot, PROFILE_NAMES } from '@usebridger/testing';
import { describe, expect, it } from 'vitest';

describe.each(PROFILE_NAMES)('no %s', (profile) => {
  it('cumprimenta', async () => {
    const bot = await createTestBot({ profile, plugins: [ola] });
    await bot.receive({ text: '!ola' });
    expect(bot.sent).toContainText(/Olá/);
    await bot.stop();
  });
});
```

Assim o teste mostra o que acontece onde não há reações (o caminho do `capabilities.has`), onde o
texto é dividido (o limite do Telegram) ou onde o contato não tem telefone (Discord). O template do
`create-bridger-plugin` já vem com essa matriz. Um plugin que exige uma capability ausente num
perfil faz o `createTestBot` rejeitar com `PluginBootError`, o que também é testável.

## Conversas, agendamentos e falhas

- **Conversas** são uma sequência de `receive`, cada um esperando o anterior assentar. A espera que
  vence (`onExpire`) se testa com os fake timers do Vitest: avance o relógio e espere o bot
  assentar. `bot.restart()` sobe um bot novo sobre o mesmo storage, para testar as esperas
  persistidas e tudo o que deve sobreviver a um deploy.
- **Botões** se testam com `bot.click(envio, 'rótulo')`, em qualquer perfil: onde há botão, o
  clique é a interação; onde não há, a lista numerada.
- **Agendamentos**: o `settled()` não espera jobs do scheduler, que podem estar marcados para
  daqui a dias. Teste o handler do job pelo efeito, com fake timers, ou chame a lógica dele direto.
- **Falhas**: um plugin que lança não derruba o teste, como não derruba o bot. Confira o efeito
  (a resposta de erro que o plugin manda) ou escute `plugin.error` no `bot.bot`. Para falhas de
  envio, de mídia ou de capability, o `FakeTransport` aceita a lista de capabilities e registra
  reações, edições e exclusões para conferir.
- **Config** entra por `pluginConfig` ou `env` nas opções do `createTestBot`, exatamente como no
  bot de produção.

## Fora do Vitest

O kit é do Vitest, que é o runner do monorepo e do template; ele registra os matchers ao ser
importado. Para usar o bot de teste num script ou num benchmark, `@usebridger/testing/bot` exporta
o mesmo sem os matchers e sem carregar o Vitest.

O próprio core não se testa com o kit: o kit depende do core, e o contrário faria um ciclo. O kit,
por sua vez, é testado contra o core real, passando pelo pipeline inteiro.
