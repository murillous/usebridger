import { proto } from 'baileys';
import { describe, expect, it } from 'vitest';
import { patchStickerAudioProto } from './sound-sticker.ts';

describe('sound-sticker proto', () => {
  it('codifica o campo 26 (AudioMessage) dentro de StickerMessage', () => {
    patchStickerAudioProto();
    patchStickerAudioProto();

    const sm = proto.Message.StickerMessage.fromObject({
      mimetype: 'image/webp',
      isAnimated: true,
      isLottie: false,
      audioMessage: {
        mimetype: 'audio/ogg; codecs=opus',
        seconds: 5,
      },
    } as proto.Message.IStickerMessage);

    const bytes = proto.Message.encode(proto.Message.fromObject({ stickerMessage: sm })).finish();
    const buf = Buffer.from(bytes);

    expect(buf.includes(Buffer.from('image/webp'))).toBe(true);
    expect(buf.includes(Buffer.from('audio/ogg; codecs=opus'))).toBe(true);
  });
});
