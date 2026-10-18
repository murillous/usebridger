// Tipagem dos pontos de extensão (#83) por declaration merging contra `@usebridger/core`, o
// mesmo especificador que um plugin usa.
import type { ExtensionPoint, ExtensionPointEntry, ServiceAccess } from '@usebridger/core';
import { describe, expectTypeOf, it } from 'vitest';

type StickerStep = (image: Uint8Array) => Promise<Uint8Array>;

declare module '@usebridger/core' {
  interface ExtensionPoints {
    'sticker.steps': StickerStep;
  }
}

declare const services: ServiceAccess;

describe('ExtensionPoints por declaration merging', () => {
  it('extensionPoint devolve a visão com o tipo declarado', () => {
    expectTypeOf(services.extensionPoint('sticker.steps')).toEqualTypeOf<
      ExtensionPoint<StickerStep>
    >();
    expectTypeOf(services.extensionPoint('sticker.steps').list()).toEqualTypeOf<
      readonly StickerStep[]
    >();
  });

  it('entries devolve o plugin dono e o valor tipado', () => {
    expectTypeOf(services.extensionPoint('sticker.steps').entries()).toEqualTypeOf<
      readonly ExtensionPointEntry<StickerStep>[]
    >();
  });

  it('contribute exige a contribuição com o tipo declarado', () => {
    services.contribute('sticker.steps', async (image) => image);
    // @ts-expect-error contribuição não bate com StickerStep
    services.contribute('sticker.steps', 'legenda');
  });

  it('ponto não declarado não compila', () => {
    // @ts-expect-error 'nao-declarado' não está em ExtensionPoints
    services.contribute('nao-declarado', () => undefined);
    // @ts-expect-error idem em extensionPoint
    services.extensionPoint('nao-declarado');
  });
});
