// Figurinha com áudio nativo do WhatsApp (sound sticker). O `WAProto` do Baileys 7.0.0-rc14 ainda
// não declara o campo 26 (`AudioMessage audioMessage = 26`) dentro de `StickerMessage`; este módulo
// estende o `encode`/`fromObject` em runtime e envia o `StickerMessage` com o áudio anexado.

import type { MediaInput, SendOptions } from '@usebridger/core';
import {
  generateWAMessageFromContent,
  prepareWAMessageMedia,
  proto,
  type WAMediaUploadFunction,
} from 'baileys';
import { toQuoted } from './outgoing.ts';

/** Tag protobuf do campo 26 (wire type 2 = length-delimited): `(26 << 3) | 2 = 210`. */
const AUDIO_MESSAGE_FIELD_TAG = (26 << 3) | 2;

export interface SoundStickerContent {
  readonly media: MediaInput;
  readonly audio: MediaInput;
  readonly audioMimetype?: string;
  readonly audioSeconds?: number;
}

export interface SoundStickerSocket {
  readonly user?: { readonly id?: string };
  readonly waUploadToServer?: WAMediaUploadFunction;
  relayMessage?(
    jid: string,
    message: proto.IMessage,
    options: { readonly messageId?: string },
  ): Promise<string>;
}

interface StickerWithAudio extends proto.Message.IStickerMessage {
  audioMessage?: proto.Message.IAudioMessage | null;
}

let patched = false;

/**
 * Estende `proto.Message.StickerMessage` para serializar o campo 26 (`AudioMessage`).
 * Idempotente: pode ser chamada várias vezes sem empilhar wrappers.
 */
export function patchStickerAudioProto(): void {
  if (patched) return;
  patched = true;

  const StickerMessage = proto.Message.StickerMessage;
  const AudioMessage = proto.Message.AudioMessage;

  const origEncode = StickerMessage.encode;
  StickerMessage.encode = function encode(message, writer) {
    const w = origEncode.call(this, message, writer);
    const audio = (message as StickerWithAudio).audioMessage;
    if (audio != null) {
      AudioMessage.encode(audio, w.uint32(AUDIO_MESSAGE_FIELD_TAG).fork()).ldelim();
    }
    return w;
  };

  const origFromObject = StickerMessage.fromObject;
  StickerMessage.fromObject = function fromObject(object) {
    const msg = origFromObject.call(this, object) as StickerWithAudio;
    const audio = (object as StickerWithAudio).audioMessage;
    if (audio != null) {
      msg.audioMessage = AudioMessage.fromObject(audio);
    }
    return msg;
  };
}

/**
 * Sobe a figurinha (WebP com `"sound-sha256"` no EXIF) e o áudio (OGG/Opus) e envia o
 * `StickerMessage` com o `AudioMessage` anexado no campo 26. Devolve o `id` da mensagem enviada.
 */
export async function sendSoundSticker(
  socket: SoundStickerSocket,
  chatId: string,
  content: SoundStickerContent,
  options?: SendOptions,
): Promise<string> {
  if (!socket.waUploadToServer || !socket.relayMessage) {
    throw new Error('baileys: socket sem suporte a upload/relay para figurinha com áudio');
  }
  patchStickerAudioProto();

  const upload = socket.waUploadToServer;
  const [stickerMedia, audioMedia] = await Promise.all([
    prepareWAMessageMedia({ sticker: content.media, isAnimated: true }, { upload }),
    prepareWAMessageMedia(
      {
        audio: content.audio,
        mimetype: content.audioMimetype ?? 'audio/ogg; codecs=opus',
        ...(content.audioSeconds !== undefined ? { seconds: content.audioSeconds } : {}),
      },
      { upload },
    ),
  ]);

  const stickerMessage = stickerMedia.stickerMessage as StickerWithAudio | null | undefined;
  if (!stickerMessage || !audioMedia.audioMessage) {
    throw new Error('baileys: falha ao preparar mídia da figurinha com áudio');
  }
  stickerMessage.isAnimated = true;
  stickerMessage.isLottie = false;
  stickerMessage.stickerSentTs = Date.now();
  stickerMessage.audioMessage = audioMedia.audioMessage;

  const full = generateWAMessageFromContent(
    chatId,
    { stickerMessage },
    {
      userJid: socket.user?.id,
      ...(options?.quoted ? { quoted: toQuoted(options.quoted) } : {}),
    },
  );
  if (!full.message || !full.key.id) {
    throw new Error('baileys: não foi possível montar a figurinha com áudio');
  }
  await socket.relayMessage(chatId, full.message, { messageId: full.key.id });
  return full.key.id;
}
