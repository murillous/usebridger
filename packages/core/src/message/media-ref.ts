// Referência de mídia serializável (ADR 0136): o plugin guarda um JSON na chegada e baixa a mídia
// depois, mesmo após um restart, sem segurar o objeto bruto do transport (`ctx.unsafe.raw()`).

import { createMedia, mediaRefData } from '#message/media.ts';
import type { Media } from '#message/types.ts';
import type { JsonValue } from '#storage/types.ts';
import { assertCapability, UnsupportedError } from '#transport/capabilities.ts';
import type { Transport } from '#transport/types.ts';

// `type`, e não `interface`: só assim cabe em `JsonValue` e vai ao storage sem cast.
/**
 * Referência JSON de uma mídia, para guardar no storage e baixar depois com `ctx.media.fromRef`.
 * `data` é opaco e do transport; pode conter a chave que decifra o arquivo (no WhatsApp, a media
 * key), então trate a referência inteira como segredo: fora de logs e de respostas da API.
 */
export type MediaRef = {
  /** Transport que criou a referência; outro transport a recusa. */
  readonly transport: string;
  readonly mimetype: string;
  readonly size: number | null;
  readonly fileName?: string;
  readonly data: JsonValue;
};

/**
 * A mídia não existe mais na plataforma (no WhatsApp, saiu do CDN e o celular da conta do bot não a
 * tem mais). Baixar de novo não adianta: o plugin trata como mídia perdida.
 */
export class MediaExpiredError extends Error {
  override readonly name = 'MediaExpiredError';
}

/** `ctx.media` (ADR 0136): referência serializável de uma mídia e o caminho de volta. */
export interface MediaRefs {
  /**
   * Referência JSON da mídia (capability `media.ref`). Lança `UnsupportedError` sem a capability
   * ou se o transport não deu referência a esta mídia.
   */
  ref(media: Media): MediaRef;
  /**
   * `Media` lazy a partir de uma referência guardada, com `download()`/`stream()`; nada é baixado
   * aqui. Lança `UnsupportedError` sem a capability e `TypeError` para referência malformada ou
   * de outro transport. A mídia que sumiu da plataforma rejeita o download com
   * `MediaExpiredError`.
   */
  fromRef(ref: MediaRef): Media;
}

export function createMediaRefs(
  transport: Pick<Transport, 'name' | 'capabilities' | 'mediaFromRef'>,
): MediaRefs {
  return {
    ref(media) {
      assertCapability(transport, 'media.ref');
      const data = mediaRefData(media);
      if (data === undefined) throw new UnsupportedError('media.ref', transport.name);
      return {
        transport: transport.name,
        mimetype: media.mimetype,
        size: media.size,
        ...(media.fileName === undefined ? null : { fileName: media.fileName }),
        data,
      };
    },
    fromRef(ref) {
      assertCapability(transport, 'media.ref');
      // A referência volta do storage do plugin: confere a forma antes de entregar ao transport.
      if (!isMediaRef(ref)) throw new TypeError('ctx.media.fromRef: referência de mídia inválida');
      if (ref.transport !== transport.name) {
        throw new TypeError(
          `ctx.media.fromRef: referência do transport "${ref.transport}", não de "${transport.name}"`,
        );
      }
      if (transport.mediaFromRef === undefined) {
        throw new UnsupportedError('media.ref', transport.name);
      }
      return createMedia({
        ...transport.mediaFromRef(ref.data),
        mimetype: ref.mimetype,
        size: ref.size,
        ...(ref.fileName === undefined ? null : { fileName: ref.fileName }),
        ref: ref.data,
      });
    },
  };
}

function isMediaRef(value: unknown): value is MediaRef {
  if (typeof value !== 'object' || value === null) return false;
  const ref = value as Record<string, unknown>;
  return (
    typeof ref['transport'] === 'string' &&
    typeof ref['mimetype'] === 'string' &&
    (ref['size'] === null || typeof ref['size'] === 'number') &&
    (ref['fileName'] === undefined || typeof ref['fileName'] === 'string') &&
    ref['data'] !== undefined
  );
}
