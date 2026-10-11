import { describe, expectTypeOf, it } from 'vitest';
import type { AcceptSpec } from './command.ts';

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
});
