// Conexão pela API (ADR 0125, 0129): estado, pareamento por código e logout, para um app conectar
// o número sem o dashboard. O QR e o código chegam pelo stream (`GET /events`).

import type { z } from 'zod';
import type { Audit } from '#audit/audit.ts';
import type { ConnectionInfo } from '#bot/connection-info.ts';
import { hasCapability } from '#transport/capabilities.ts';
import type { ConnectionStatus, Transport } from '#transport/types.ts';
import { apiLibs } from './libs.ts';
import type { AnyApiOperation } from './operation.ts';
import { ApiError } from './problem.ts';

export interface ConnectionApiDeps {
  readonly transport: Transport;
  /** Último `connection.status` (ADR 0106); `undefined` antes do primeiro. */
  readonly status: () => ConnectionStatus | undefined;
  readonly info: () => ConnectionInfo;
  /** Getter: a auditoria nasce depois do servidor HTTP no `createBot`. */
  readonly audit?: () => Pick<Audit, 'record'>;
}

let schemas:
  | { readonly connection: z.ZodType; readonly phone: z.ZodType; readonly code: z.ZodType }
  | undefined;

function connectionSchemas(): NonNullable<typeof schemas> {
  const { z } = apiLibs();
  schemas ??= {
    connection: z
      .object({
        status: z.enum(['connecting', 'open', 'closed']),
        reason: z.string().optional(),
        transport: z.string(),
        /** Se o transport pareia (QR ou código): só então logout e código fazem sentido. */
        pairing: z.boolean(),
        /** Conta conectada; `null` até a primeira conexão aberta. */
        account: z
          .object({
            id: z.string(),
            name: z.string().nullable(),
            phone: z.string().nullable(),
            username: z.string().optional(),
          })
          .nullable(),
        connectedSince: z.number().optional(),
        reconnections: z.number(),
        qrExpiresAt: z.number().optional(),
      })
      .meta({ id: 'Connection' }),
    phone: z.object({
      // Mesma regra do `pairing.phone` do Baileys: só dígitos, com DDI.
      phone: z.string().regex(/^\d{8,15}$/, 'só dígitos, com DDI (ex.: 5511999999999)'),
    }),
    code: z.object({ code: z.string() }).meta({ id: 'PairingCode' }),
  };
  return schemas;
}

/** Precisa de `loadApiLibs()` antes. Sem `deps` (spec offline), as rotas existem só na spec. */
export function connectionOperations(deps?: ConnectionApiDeps): readonly AnyApiOperation[] {
  const { z } = apiLibs();
  const { connection, phone, code } = connectionSchemas();
  const need = (): ConnectionApiDeps => {
    if (deps === undefined) throw new ApiError(404);
    return deps;
  };
  const pairable = ({ transport, status }: ConnectionApiDeps): void => {
    if (!hasCapability(transport, 'pairing')) {
      throw new ApiError(409, `o transport "${transport.name}" não pareia`);
    }
    if (status()?.status === 'open') throw new ApiError(409, 'a sessão já está conectada');
  };
  return [
    {
      method: 'GET',
      path: '/connection',
      summary: 'Estado da conexão e conta conectada',
      tags: ['connection'],
      permission: 'connection.read',
      response: connection,
      handler: () => {
        const { transport, status, info } = need();
        const current = status() ?? { status: 'connecting' as const };
        const { connectedSince, reconnections, qrExpiresAt } = info();
        const self = transport.self;
        return {
          status: current.status,
          ...(current.status === 'closed' && { reason: current.reason }),
          transport: transport.name,
          pairing: hasCapability(transport, 'pairing'),
          account:
            self === null
              ? null
              : {
                  id: self.id,
                  name: self.name,
                  phone: self.phone,
                  ...(self.username !== undefined && { username: self.username }),
                },
          ...(connectedSince !== undefined && { connectedSince }),
          reconnections,
          ...(qrExpiresAt !== undefined && { qrExpiresAt }),
        };
      },
    },
    {
      method: 'POST',
      path: '/connection/pairing-code',
      summary: 'Pede o código de pareamento para o telefone, a alternativa ao QR',
      tags: ['connection'],
      // Dá acesso à conta, como o QR.
      permission: 'connection.manage',
      body: phone,
      response: code,
      handler: async ({ body }) => {
        const current = need();
        pairable(current);
        const { transport } = current;
        if (transport.requestPairingCode === undefined) {
          throw new ApiError(409, `o transport "${transport.name}" não pareia por código`);
        }
        const value = await transport.requestPairingCode((body as { phone: string }).phone);
        // Sem o telefone: é dado pessoal, e o alvo já diz o que foi feito.
        current.audit?.().record({
          action: 'kernel.connection.pairing-code',
          target: { type: 'connection', id: transport.name },
          outcome: 'success',
        });
        return { code: value };
      },
    },
    {
      method: 'POST',
      path: '/connection/logout',
      summary: 'Desvincula a sessão na plataforma; o bot pareia de novo (novo QR no stream)',
      tags: ['connection'],
      permission: 'connection.manage',
      response: z.object({}),
      handler: async () => {
        const { transport, audit } = need();
        if (!hasCapability(transport, 'pairing') || transport.logout === undefined) {
          throw new ApiError(409, `o transport "${transport.name}" não faz logout`);
        }
        await transport.logout();
        audit?.().record({
          action: 'kernel.connection.logout',
          target: { type: 'connection', id: transport.name },
          outcome: 'success',
        });
        return {};
      },
    },
  ];
}
