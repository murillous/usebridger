import { MediaExpiredError } from '@usebridger/core';
import { describe, expect, it } from 'vitest';
import { expiredOr, mediaRefData, refMessage } from './media-ref.ts';

const key = { remoteJid: '120363000000000001@g.us', id: 'MSG1', fromMe: false, participant: 'a@s' };
const node = {
  mediaKey: new Uint8Array([1, 2, 3]),
  directPath: '/v/t62/abc',
  url: 'https://mmg.whatsapp.net/v/t62/abc',
  // Fica de fora da referência: não é preciso para baixar.
  jpegThumbnail: new Uint8Array(500),
};

describe('mediaRefData / refMessage', () => {
  it('guarda só o que o download precisa e volta ao WAMessage mínimo', () => {
    const data = mediaRefData(key, 'audioMessage', node);
    expect(data).toEqual({
      key,
      type: 'audioMessage',
      mediaKey: 'AQID',
      directPath: '/v/t62/abc',
      url: 'https://mmg.whatsapp.net/v/t62/abc',
    });

    const raw = refMessage(JSON.parse(JSON.stringify(data)));
    expect(raw.key).toEqual(key);
    expect(raw.message?.audioMessage).toEqual({
      mediaKey: Buffer.from([1, 2, 3]),
      directPath: '/v/t62/abc',
      url: 'https://mmg.whatsapp.net/v/t62/abc',
    });
  });

  it('sem media key ou caminho, ou fora dos tipos de mídia, não há referência', () => {
    expect(mediaRefData(key, 'audioMessage', { ...node, mediaKey: null })).toBeUndefined();
    expect(mediaRefData(key, 'audioMessage', { mediaKey: node.mediaKey })).toBeUndefined();
    expect(mediaRefData(key, 'locationMessage', node)).toBeUndefined();
    expect(mediaRefData({ ...key, id: null }, 'audioMessage', node)).toBeUndefined();
  });

  it('recusa dado malformado com TypeError', () => {
    expect(() => refMessage('abc')).toThrow(TypeError);
    expect(() => refMessage({ key, type: 'audioMessage', mediaKey: 'AQID' })).toThrow(TypeError);
    expect(() =>
      refMessage({ key, type: 'pollCreationMessage', mediaKey: 'AQID', url: 'x' }),
    ).toThrow(TypeError);
  });
});

/** O erro do Baileys é um `Boom`, com o código HTTP em `output.statusCode`. */
const boom = (message: string, statusCode: number) =>
  Object.assign(new Error(message), { output: { statusCode } });

describe('expiredOr', () => {
  it('404 e 410 viram MediaExpiredError, com o erro original na causa', () => {
    const notFound = boom('Media re-upload failed by device (NOT_FOUND)', 404);
    const expired = expiredOr(notFound);
    expect(expired).toBeInstanceOf(MediaExpiredError);
    expect((expired as Error).cause).toBe(notFound);
    expect(expiredOr(Object.assign(new Error('gone'), { status: 410 }))).toBeInstanceOf(
      MediaExpiredError,
    );
  });

  it('os outros erros passam como estão', () => {
    const error = boom('falha', 500);
    expect(expiredOr(error)).toBe(error);
    const plain = new Error('rede');
    expect(expiredOr(plain)).toBe(plain);
  });
});
