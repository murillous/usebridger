import { describe, expect, it, vi } from 'vitest';
import { createMedia } from '#message/media.ts';
import { createMediaRefs, type MediaRef } from '#message/media-ref.ts';
import type { JsonValue } from '#storage/types.ts';
import { type Capability, UnsupportedError } from '#transport/capabilities.ts';

function transport(capabilities: readonly Capability[] = ['media.ref']) {
  const mediaFromRef = vi.fn((data: JsonValue) => ({
    download: async () => Buffer.from(String(data)),
  }));
  return { name: 'fake', capabilities: new Set(capabilities), mediaFromRef };
}

const withRef = createMedia({
  mimetype: 'audio/ogg',
  size: 3,
  fileName: 'nota.ogg',
  ref: 'abc',
  download: async () => Buffer.from('abc'),
});

describe('createMediaRefs', () => {
  it('ref() devolve a referência JSON com os metadados da mídia', () => {
    const ref = createMediaRefs(transport()).ref(withRef);
    expect(ref).toEqual({
      transport: 'fake',
      mimetype: 'audio/ogg',
      size: 3,
      fileName: 'nota.ogg',
      data: 'abc',
    });
    // Sobrevive ao storage: é JSON puro.
    expect(JSON.parse(JSON.stringify(ref))).toEqual(ref);
  });

  it('a referência não aparece no JSON da mídia', () => {
    expect(JSON.stringify(withRef)).not.toContain('abc');
  });

  it('fromRef() devolve uma Media lazy que baixa pelo transport', async () => {
    const t = transport();
    const refs = createMediaRefs(t);
    const media = refs.fromRef(refs.ref(withRef));
    expect(t.mediaFromRef).toHaveBeenCalledWith('abc');
    expect(media).toMatchObject({ mimetype: 'audio/ogg', size: 3, fileName: 'nota.ogg' });
    await expect(media.download()).resolves.toEqual(Buffer.from('abc'));
    // A mídia reconstruída também tem referência.
    expect(refs.ref(media).data).toBe('abc');
  });

  it('sem a capability, ref() e fromRef() lançam UnsupportedError', () => {
    const refs = createMediaRefs(transport([]));
    expect(() => refs.ref(withRef)).toThrow(UnsupportedError);
    const ref: MediaRef = { transport: 'fake', mimetype: 'x', size: null, data: 'abc' };
    expect(() => refs.fromRef(ref)).toThrow(UnsupportedError);
  });

  it('mídia sem referência do transport lança UnsupportedError', () => {
    const plain = createMedia({ mimetype: 'x', download: async () => Buffer.alloc(0) });
    expect(() => createMediaRefs(transport()).ref(plain)).toThrow(UnsupportedError);
  });

  it('recusa referência de outro transport e referência malformada', () => {
    const refs = createMediaRefs(transport());
    expect(() =>
      refs.fromRef({ transport: 'outro', mimetype: 'x', size: null, data: 'abc' }),
    ).toThrow(/transport "outro"/);
    expect(() => refs.fromRef({ transport: 'fake' } as unknown as MediaRef)).toThrow(TypeError);
  });
});
