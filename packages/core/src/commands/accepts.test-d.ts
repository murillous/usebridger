import { describe, expectTypeOf, it } from 'vitest';
import type { Media } from '#message/types.ts';
import {
  type AcceptedMessage,
  type AcceptSpec,
  type CommandContext,
  command,
  type MediaCommandContext,
} from './command.ts';

describe('AcceptSpec', () => {
  it('aceita o tipo, o citado e o mimetype nos tipos com mídia', () => {
    expectTypeOf<
      'document' | 'quoted:text' | 'document:application/pdf' | 'quoted:video:video/*'
    >().toExtend<AcceptSpec>();
  });

  it('recusa mimetype em tipo sem mídia ou sem a barra', () => {
    expectTypeOf<'text:text/plain'>().not.toExtend<AcceptSpec>();
    expectTypeOf<'document:pdf'>().not.toExtend<AcceptSpec>();
    expectTypeOf<'quoted:poll:a/b'>().not.toExtend<AcceptSpec>();
  });

  it("aceita 'args' só na própria mensagem", () => {
    expectTypeOf<'args'>().toExtend<AcceptSpec>();
    expectTypeOf<'quoted:args'>().not.toExtend<AcceptSpec>();
  });
});

describe('command: contexto do run pelo accepts', () => {
  it('só entradas com mídia: media e accepted garantidos', () => {
    command({
      name: 'imagem',
      accepts: ['sticker', 'quoted:sticker', 'document:application/pdf'],
      run(c) {
        expectTypeOf(c).toEqualTypeOf<MediaCommandContext>();
        expectTypeOf(c.media).toEqualTypeOf<Media>();
        expectTypeOf(c.accepted).toEqualTypeOf<AcceptedMessage>();
      },
    });
  });

  it('com entrada sem mídia, ou sem accepts, segue o contexto largo', () => {
    command({
      name: 'sticker',
      accepts: ['sticker', 'args'],
      run: (c) => expectTypeOf(c.media).toEqualTypeOf<Media | null>(),
    });
    command({
      name: 'ia',
      accepts: ['quoted:text'],
      run: (c) => expectTypeOf(c).toEqualTypeOf<CommandContext>(),
    });
    command({ name: 'ping', run: (c) => expectTypeOf(c).toEqualTypeOf<CommandContext>() });
  });
});
