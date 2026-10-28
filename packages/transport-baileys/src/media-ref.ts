// Referência de mídia do WhatsApp (capability `media.ref`, ADR 0136): o mínimo do `WAMessage` que
// o `downloadMediaMessage` precisa para baixar de novo, inclusive pedir ao aparelho de quem enviou
// que suba a mídia de novo quando ela saiu do CDN. A `mediaKey` decifra o arquivo: é segredo.

import { type JsonValue, MediaExpiredError } from '@usebridger/core';
import type { proto, WAMessage } from 'baileys';

/** Tipos de conteúdo que têm mídia baixável; os da normalização. */
const MEDIA_TYPES: ReadonlySet<string> = new Set([
  'imageMessage',
  'videoMessage',
  'ptvMessage',
  'audioMessage',
  'stickerMessage',
  'documentMessage',
]);

interface RefData {
  readonly key: {
    readonly remoteJid: string;
    readonly id: string;
    readonly fromMe: boolean;
    readonly participant?: string;
  };
  readonly type: string;
  /** Base64. */
  readonly mediaKey: string;
  readonly directPath?: string;
  readonly url?: string;
}

/** Campos de download de um nó de mídia do proto. */
export interface MediaNode {
  readonly mediaKey?: Uint8Array | null;
  readonly directPath?: string | null;
  readonly url?: string | null;
}

/** Dado do `MediaRef` da mídia, ou `undefined` se falta o que baixá-la de novo exige. */
export function mediaRefData(
  key: proto.IMessageKey,
  type: string,
  node: MediaNode,
): JsonValue | undefined {
  const { remoteJid, id } = key;
  const { mediaKey, directPath, url } = node;
  if (!remoteJid || !id || !MEDIA_TYPES.has(type) || !mediaKey?.length || !(directPath || url)) {
    return undefined;
  }
  return {
    // A chave da mensagem é o que o pedido de reenvio ao aparelho identifica.
    key: {
      remoteJid,
      id,
      fromMe: key.fromMe === true,
      ...(key.participant && { participant: key.participant }),
    },
    type,
    mediaKey: Buffer.from(mediaKey).toString('base64'),
    ...(directPath && { directPath }),
    ...(url && { url }),
  } satisfies RefData;
}

/** O `WAMessage` mínimo de uma referência; `TypeError` se o dado não é uma. */
export function refMessage(data: JsonValue): WAMessage {
  if (!isRefData(data)) throw new TypeError('baileys: referência de mídia inválida');
  const { key, type, mediaKey, directPath, url } = data;
  // `url` presente mesmo vazio: o Baileys só reconhece o nó como mídia com o campo.
  const node = { mediaKey: Buffer.from(mediaKey, 'base64'), directPath, url };
  return { key: { ...key }, message: { [type]: node } };
}

function isRefData(value: JsonValue): value is RefData & JsonValue {
  const ref = record(value);
  const key = record(ref?.['key']);
  if (ref === undefined || key === undefined) return false;
  const { type, mediaKey, directPath, url } = ref;
  return (
    typeof key['remoteJid'] === 'string' &&
    typeof key['id'] === 'string' &&
    typeof key['fromMe'] === 'boolean' &&
    (key['participant'] === undefined || typeof key['participant'] === 'string') &&
    typeof type === 'string' &&
    MEDIA_TYPES.has(type) &&
    typeof mediaKey === 'string' &&
    (directPath === undefined || typeof directPath === 'string') &&
    (url === undefined || typeof url === 'string') &&
    (directPath !== undefined || url !== undefined)
  );
}

/** O objeto JSON, se `value` é um (e não lista nem escalar). */
function record(value: JsonValue | undefined): Partial<Record<string, JsonValue>> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
  return value as Partial<Record<string, JsonValue>>;
}

// 404/410 depois do pedido de reenvio: nem o CDN nem o aparelho de quem enviou têm a mídia.
const GONE: ReadonlySet<unknown> = new Set([404, 410]);

/** `MediaExpiredError` para a mídia que sumiu; os outros erros passam como estão. */
export function expiredOr(error: unknown): unknown {
  const status =
    (error as { output?: { statusCode?: unknown } } | null)?.output?.statusCode ??
    (error as { status?: unknown } | null)?.status;
  if (!GONE.has(status)) return error;
  return new MediaExpiredError('baileys: a mídia não está mais disponível no WhatsApp', {
    cause: error,
  });
}
