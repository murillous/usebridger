// Janela de atendimento (ADR 0124): plataformas como o WhatsApp oficial só aceitam conteúdo livre
// por um tempo após a última mensagem do contato; fora dele, só template.

/** Estado da janela de um chat. */
export interface ConversationWindow {
  readonly open: boolean;
  /**
   * Até quando a janela vale; `null` se fechada ou sem inbound. A hora em que fechou fica no
   * `closedAt` do `ConversationWindowError`.
   */
  readonly expiresAt: Date | null;
}

/**
 * Lançado pelo transport quando o envio livre é recusado por janela fechada: antes da API, se ele
 * conhece a janela, ou convertendo a recusa da plataforma (erro 131047 da Cloud API). Template
 * nunca o recebe. `retryable: false` já basta para a fila não re-tentar; a classe existe para o
 * plugin fazer `instanceof` e oferecer o template.
 */
export class ConversationWindowError extends Error {
  override readonly name = 'ConversationWindowError';
  readonly retryable = false;
  readonly chatId: string;
  /** Quando a janela fechou; `null` se nunca houve mensagem do contato no chat. */
  readonly closedAt: Date | null;

  constructor(chatId: string, closedAt: Date | null) {
    super(
      closedAt === null
        ? `O chat ${chatId} não tem janela de atendimento aberta: o contato nunca escreveu. Só template pode ser enviado.`
        : `A janela de atendimento do chat ${chatId} fechou em ${closedAt.toISOString()}. Só template pode ser enviado.`,
    );
    this.chatId = chatId;
    this.closedAt = closedAt;
  }
}
