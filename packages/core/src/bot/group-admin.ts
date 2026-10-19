import type { IsGroupAdmin } from '#commands/router.ts';
import { type ArmedTimers, settleWithin } from '#deadline.ts';
import { hasCapability } from '#transport/capabilities.ts';
import type { Transport } from '#transport/types.ts';

/**
 * A consulta de admin do grupo ao transport (`role: 'group-admin'`) estourou o prazo do comando.
 * O comando não roda e sai `plugin.error` com `timedOut: true` no plugin dono do comando.
 */
export class GroupAdminTimeoutError extends Error {
  override readonly name = 'GroupAdminTimeoutError';
  readonly chatId: string;
  readonly timeoutMs: number;

  constructor(chatId: string, timeoutMs: number) {
    super(`consulta de admin do grupo "${chatId}" ao transport excedeu ${timeoutMs} ms`);
    this.chatId = chatId;
    this.timeoutMs = timeoutMs;
  }
}

/**
 * Porta `isGroupAdmin` do roteador, a partir do transport: o `isChatAdmin` dele, se houver, ou a
 * lista de participantes do `getGroupMetadata` (capability `groups`, ADR 0055). Com o prazo do
 * comando: uma consulta que nunca resolve seguraria o chat na fila de entrada para sempre. O
 * timer só existe para quem não é owner pedindo comando de admin num grupo.
 */
export function groupAdminPort(
  transport: Transport,
  timeoutMs: number,
  onLate: (error: unknown) => void,
  armed: ArmedTimers,
): IsGroupAdmin | undefined {
  const within = <T>(work: Promise<T>, chatId: string): Promise<T> =>
    settleWithin(
      work,
      timeoutMs,
      () => new GroupAdminTimeoutError(chatId, timeoutMs),
      onLate,
      armed,
    ) as Promise<T>;
  if (transport.isChatAdmin) {
    const isChatAdmin = transport.isChatAdmin.bind(transport);
    return (chat, sender) => within(isChatAdmin(chat, sender), chat.id);
  }
  if (!hasCapability(transport, 'groups')) return undefined;
  return async (chat, sender) => {
    const metadata = await within(transport.getGroupMetadata(chat.id), chat.id);
    // Sem a lista, não há como saber: recusa (fail-closed). Transport que não lista membros
    // deve implementar `isChatAdmin`.
    if (!metadata.participants) return false;
    // Casa por id ou, quando os dois lados o têm, por telefone: o remetente e o participante
    // podem vir com IDs de espaços diferentes (no WhatsApp, LID e JID de telefone; ADR 0042).
    // Sem telefone de um lado, só o id decide (fail-closed).
    return metadata.participants.some(
      (participant) =>
        participant.isAdmin &&
        (participant.id === sender.id ||
          (sender.phone !== null && participant.phone === sender.phone)),
    );
  };
}
