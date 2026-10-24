// Fluxo de entrada do bot (plano §5.3): o que acontece com a mensagem, a edição, o clique e o
// comando nativo depois que a fila do chat os entrega. Separado do `createBot`, que cuida do boot
// e do shutdown: é a parte que muda com cada feature de entrada.

import {
  type ActionRegistry,
  type ActionTarget,
  type MessageAction,
  numberedMenu,
  pickChoice,
} from '#actions/actions.ts';
import type { CommandRouter, DispatchResult } from '#commands/router.ts';
import {
  type ConversationRegistry,
  type PendingReply,
  StepTimeoutError,
} from '#conversations/conversations.ts';
import type { EventBus } from '#events/bus.ts';
import type { ListenerExtras, PluginErrorEvent } from '#events/types.ts';
import * as LOG from '#logger/events.ts';
import { createMessage } from '#message/create.ts';
import type { Chat, Contact, Message } from '#message/types.ts';
import type { MiddlewarePipeline } from '#middleware/pipeline.ts';
import type { MessageHandledSignal, Observers } from '#observers/observers.ts';
import type { PrepareActions, ReplyOrigin } from '#outbound/reply.ts';
import type { CommandInteraction, Interaction } from '#transport/types.ts';
import type { BackgroundTasks } from './background-tasks.ts';
import { GroupAdminTimeoutError } from './group-admin.ts';
import {
  createExpireOrigin,
  createMessageContext,
  type ExpireOrigin,
  type KernelMessageContext,
  type MessageContextDeps,
  messageExtras,
} from './message-context.ts';
import { CommandTimeoutError } from './plugin-context.ts';

/**
 * Dono e passo da espera do menu numerado (ADR 0058). O nome não é kebab-case: nenhum plugin o
 * usa.
 */
const MENU_OWNER = '#menu';
const MENU_STEP = 'choice';

export interface InboundFlowDeps {
  readonly router: CommandRouter;
  readonly conversations: ConversationRegistry<KernelMessageContext, ExpireOrigin>;
  readonly actions: ActionRegistry;
  readonly bus: EventBus;
  readonly pipeline: MiddlewarePipeline<KernelMessageContext>;
  /** O contexto de mensagem; as ações do `reply` quem resolve é o fluxo. */
  readonly context: Omit<MessageContextDeps, 'actions'>;
  /** Botões por mensagem; 0 sem a capability `actions` (aí as ações viram menu numerado). */
  readonly maxButtons: number;
  /** Portão do boot: `true` com os plugins de pé; senão, a promise do fim do boot (`false` = abortado). */
  readonly ready: () => true | Promise<boolean>;
  readonly reportPluginError: (event: PluginErrorEvent) => void;
  /** Comandos com `background: true` em andamento (ADR 0083). */
  readonly background: BackgroundTasks;
  /** Destino do `message.handled` (ADR 0102). */
  readonly observers: Pick<Observers, 'emit'>;
}

/**
 * Medida da mensagem para o `message.handled`; só existe quando a entrada mediu a espera na fila,
 * isto é, havia observador no enqueue (ADR 0102).
 */
interface Probe {
  readonly queuedMs: number;
  /** Início do handler, depois dos middlewares. */
  readonly startedAt: number;
}

function startProbe(queuedMs: number | undefined): Probe | undefined {
  return queuedMs === undefined ? undefined : { queuedMs, startedAt: performance.now() };
}

/** `queuedMs`: a espera na fila do chat, medida só com observador de `message.handled`. */
export interface InboundFlow {
  readonly handleMessage: (message: Message, queuedMs?: number) => Promise<void>;
  readonly handleEdited: (message: Message) => Promise<void>;
  readonly handleInteraction: (interaction: Interaction, queuedMs?: number) => Promise<void>;
  /**
   * Expira a espera do remetente no chat, se ela venceu, e roda o `onExpire` do passo (ADR 0093).
   * Quem chama a põe na fila do chat: é a tarefa da expiração.
   */
  readonly expireReply: (chat: Chat, sender: Contact) => Promise<void>;
  /** A interação de origem da mensagem que o fluxo montou de um clique ou comando nativo. */
  readonly interactionOf: (message: Message) => Interaction | undefined;
}

export function createInboundFlow(deps: InboundFlowDeps): InboundFlow {
  const { router, conversations, actions, bus, pipeline, maxButtons, reportPluginError } = deps;
  const log = deps.context.log;
  const contextDeps: MessageContextDeps = { ...deps.context, actions: prepareActions };
  // Mensagem montada a partir de um clique ou comando nativo -> a interação de origem, para o
  // `ctx.unsafe.raw()` pedir ao transport o objeto bruto dela (ADR 0062). Some com a mensagem.
  const interactions = new WeakMap<Message, Interaction>();
  // O menu numerado espera a resposta pelo mesmo registro dos plugins, então um comando digitado
  // ou outra espera também o cancelam. O passo nunca roda: o `dispatchMessage` trata a escolha.
  conversations.define(MENU_OWNER, MENU_STEP, () => undefined);

  /**
   * Barreiras comuns à mensagem nova e à edição: espera o fim do boot e roda os middlewares em
   * volta de `handle`, que só roda se a mensagem atravessar a cadeia. A volta da cebola espera
   * `handle` terminar (ADR 0010).
   */
  async function admit(
    message: Message,
    handle: (ctx: KernelMessageContext) => Promise<void>,
  ): Promise<void> {
    const ready = deps.ready();
    if (ready !== true && !(await ready)) return;
    await pipeline.run(createMessageContext(message, contextDeps), handle);
  }

  function handleMessage(message: Message, queuedMs?: number): Promise<void> {
    return admit(message, (ctx) => dispatchMessage(ctx, startProbe(queuedMs)));
  }

  async function dispatchMessage(
    ctx: KernelMessageContext,
    probe: Probe | undefined,
  ): Promise<void> {
    const { message } = ctx;
    // A espera vem antes do roteador (ADR 0056). Retirada aqui de todo jeito: um comando digitado
    // no meio da conversa a cancela e segue para o roteador.
    const pending = conversations.take(message.chat.id, message.sender.id);
    if (pending !== undefined && router.match(message, ctx.text) === null) {
      if (pending.plugin !== MENU_OWNER) {
        await runStep(ctx, pending, probe);
        return;
      }
      // Um número do menu roda a ação, como o clique; outro texto segue o fluxo normal (ADR 0058).
      const target = menuChoice(ctx, pending.data);
      if (target !== undefined) {
        await runAction(ctx, target, probe);
        return;
      }
    }
    const result = await router.dispatch(ctx);
    if (!result.consumed) {
      const emitted = await bus.emit('message', message, listenerExtras(ctx));
      handled(ctx, probe, 'message', emitted.failed > 0 ? 'failed' : 'ok');
      return;
    }
    await afterCommand(ctx, result, probe);
  }

  /** Emite o `message.handled`; sem `probe` (sem observador no enqueue), nada. */
  function handled(
    ctx: KernelMessageContext,
    probe: Probe | undefined,
    route: MessageHandledSignal['route'],
    status: MessageHandledSignal['status'],
    command?: string,
  ): void {
    if (probe === undefined) return;
    const { message } = ctx;
    deps.observers.emit('message.handled', {
      messageId: message.id,
      chatId: message.chat.id,
      senderId: message.sender.id,
      chatType: message.chat.isGroup ? 'group' : 'private',
      route,
      ...(command !== undefined && { command }),
      status,
      queuedMs: probe.queuedMs,
      durationMs: performance.now() - probe.startedAt,
    });
  }

  /** Recusa, falha e evento `command` do comando que consumiu a mensagem ou o clique. */
  async function afterCommand(
    ctx: KernelMessageContext,
    result: Extract<DispatchResult, { readonly consumed: true }>,
    probe: Probe | undefined,
  ): Promise<void> {
    const { message } = ctx;
    if (result.status === 'background') {
      // O chat já está livre; a falha, o `command` e o `message.handled` saem quando o `run`
      // terminar (ADR 0083).
      deps.background.track(
        result.done
          .then((outcome) => afterCommand(ctx, outcome, probe))
          .catch((error: unknown) =>
            ctx.log.event(LOG.commandBackgroundFailed, {
              plugin: result.command.plugin,
              command: result.command.name,
              err: error,
            }),
          ),
      );
      return;
    }
    if (result.status === 'rejected' && result.reply !== null) {
      // Sem await: a resposta espera a taxa da fila de saída, e o chat não precisa esperar.
      ctx.reply(result.reply).catch((error: unknown) =>
        ctx.log.event(LOG.commandRefusalFailed, {
          plugin: result.command.plugin,
          command: result.command.name,
          err: error,
        }),
      );
    }
    const timedOut =
      result.status === 'failed' &&
      (result.error instanceof CommandTimeoutError ||
        result.error instanceof GroupAdminTimeoutError);
    if (result.status === 'failed') {
      const event: PluginErrorEvent = {
        plugin: result.command.plugin,
        phase: 'command',
        event: result.command.name,
        error: result.error,
        timedOut,
      };
      reportPluginError(event);
    }
    const { plugin, name, invokedAs } = result.command;
    // Antes do `command`, cujo listener é aguardado: a duração é só a do comando.
    handled(ctx, probe, 'command', commandStatus(result.status, timedOut), name);
    // Com await, como o `message`: o observador segura o chat e entra no `settled()` (ADR 0045).
    await bus.emit('command', { plugin, name, invokedAs, status: result.status, message });
  }

  /**
   * Roda o passo que esperava esta mensagem. Ela para aqui: não vai ao roteador, a `message` nem
   * a `command`. A falha vira `plugin.error` com `phase: 'step'`.
   */
  async function runStep(
    ctx: KernelMessageContext,
    pending: PendingReply<KernelMessageContext>,
    probe: Probe | undefined,
  ): Promise<void> {
    try {
      await pending.run(ctx, pending.data);
    } catch (error) {
      const timedOut = error instanceof StepTimeoutError;
      const event: PluginErrorEvent = {
        plugin: pending.plugin,
        phase: 'step',
        event: pending.step,
        error,
        timedOut,
      };
      reportPluginError(event);
      handled(ctx, probe, 'step', timedOut ? 'timeout' : 'failed');
      return;
    }
    handled(ctx, probe, 'step', 'ok');
  }

  /**
   * A tarefa da expiração, na fila do chat (ADR 0093). A espera só sai aqui, na vez dela: uma
   * mensagem do remetente que entrou antes na fila já a consumiu, e aí não há o que expirar. Não
   * passa pelos middlewares, porque não há mensagem; espera o fim do boot, como a mensagem. A
   * falha vira `plugin.error` com `phase: 'step-expire'`.
   */
  async function expireReply(chat: Chat, sender: Contact): Promise<void> {
    const ready = deps.ready();
    if (ready !== true && !(await ready)) return;
    const expired = conversations.expire(chat.id, sender.id);
    if (expired === undefined) return;
    try {
      await expired.run(
        createExpireOrigin(expired.chat, expired.sender, contextDeps),
        expired.data,
      );
    } catch (error) {
      reportPluginError({
        plugin: expired.plugin,
        phase: 'step-expire',
        event: expired.step,
        error,
        timedOut: error instanceof StepTimeoutError,
      });
    }
  }

  // --- Ações e botões (ADR 0058) -------------------------------------------------------------

  /**
   * Resolve as ações de um `reply`: guarda o alvo de cada uma sob um ID e devolve os botões ou,
   * sem a capability ou acima do limite, o texto com o menu numerado e a espera do remetente.
   */
  function prepareActions(owner: string | null, origin: ReplyOrigin): PrepareActions {
    return (text, list) => {
      const targets = list.map((action) => actionTarget(owner, action));
      const chatId = origin.chat.id;
      const ids = targets.map((target) => actions.register(chatId, target));
      const labels = targets.map(({ label }) => label);
      if (ids.length <= maxButtons) {
        return { text, actions: ids.map((id, index) => ({ id, label: labels[index] as string })) };
      }
      conversations.expect(MENU_OWNER, origin.chat, origin.sender, MENU_STEP, { data: ids });
      return { text: numberedMenu(text, labels) };
    };
  }

  /** Valida a ação e devolve o alvo: o erro sai na chamada do `reply`, não no clique. */
  function actionTarget(owner: string | null, action: MessageAction): ActionTarget {
    const label: unknown = action?.label;
    if (typeof label !== 'string' || label.trim().length === 0) {
      throw new TypeError('ação sem `label`');
    }
    if ('command' in action) {
      if (router.registry.find(action.command) === undefined) {
        throw new TypeError(`ação "${label}": comando "${action.command}" não registrado`);
      }
      return {
        kind: 'command',
        label,
        command: action.command,
        args: Object.freeze([...(action.args ?? [])]),
      };
    }
    if ('step' in action) {
      if (owner === null) {
        throw new TypeError(`ação "${label}": passo só no contexto de um plugin`);
      }
      if (conversations.find(owner, action.step) === undefined) {
        throw new TypeError(
          `ação "${label}": plugin "${owner}" sem o passo "${action.step}"; defina-o com ` +
            'ctx.conversations.define',
        );
      }
      return { kind: 'step', label, plugin: owner, step: action.step, data: action.data ?? null };
    }
    throw new TypeError(`ação "${label}" sem \`command\` nem \`step\``);
  }

  /** O alvo que a resposta ao menu numerado escolhe, se ela for um número da lista. */
  function menuChoice(ctx: KernelMessageContext, data: unknown): ActionTarget | undefined {
    const ids = data as readonly string[];
    const index = pickChoice(ctx.text, ids.length);
    if (index === null) return undefined;
    return actions.resolve(ids[index] as string, ctx.message.chat.id);
  }

  /**
   * O clique num botão: passa pela fila do chat e pelos middlewares como uma mensagem de texto com
   * o `label`, e roda o comando ou o passo da ação. Vencido, desconhecido ou de outro chat, é
   * descartado.
   */
  async function handleInteraction(interaction: Interaction, queuedMs?: number): Promise<void> {
    if (interaction.command !== undefined) return handleNativeCommand(interaction, queuedMs);
    const { chat, sender, actionId } = interaction;
    const target = actions.resolve(actionId, chat.id);
    if (target === undefined) {
      log().event(LOG.buttonUnknown, { chat: chat.id });
      return;
    }
    const message = createMessage({
      type: 'text',
      id: interaction.id,
      chat,
      sender,
      text: target.label,
      timestamp: interaction.timestamp,
      fromMe: false,
    });
    interactions.set(message, interaction);
    await admit(message, async (ctx) => {
      // O clique é um comando: cancela a espera do remetente, como o comando digitado (ADR 0056).
      conversations.take(chat.id, sender.id);
      await runAction(ctx, target, startProbe(queuedMs));
    });
  }

  /**
   * Comando nativo da plataforma (ADR 0060): roda como o clique num botão de comando, com o texto
   * livre interpretado como o que vem depois do comando digitado.
   */
  async function handleNativeCommand(
    interaction: CommandInteraction,
    queuedMs: number | undefined,
  ): Promise<void> {
    const { chat, sender, command, args } = interaction;
    const message = createMessage({
      type: 'text',
      id: interaction.id,
      chat,
      sender,
      // O texto que a plataforma mostra para o comando: quem lê a mensagem (middlewares, log) vê
      // o que a pessoa chamou.
      text: args.trim() === '' ? `/${command}` : `/${command} ${args.trimStart()}`,
      timestamp: interaction.timestamp,
      fromMe: false,
    });
    interactions.set(message, interaction);
    await admit(message, async (ctx) => {
      // Comando cancela a espera do remetente, como o digitado (ADR 0056).
      conversations.take(chat.id, sender.id);
      const started = startProbe(queuedMs);
      const result = await router.dispatch(ctx, { command, rawArgs: args });
      if (!result.consumed) {
        ctx.log.event(LOG.nativeCommandGone, { command });
        return;
      }
      await afterCommand(ctx, result, started);
    });
  }

  /** Roda o alvo da ação. Comando ou passo que não existe mais (plugin desligado) é descartado. */
  async function runAction(
    ctx: KernelMessageContext,
    target: ActionTarget,
    probe: Probe | undefined,
  ): Promise<void> {
    if (target.kind === 'command') {
      const result = await router.dispatch(ctx, { command: target.command, args: target.args });
      if (!result.consumed) {
        ctx.log.event(LOG.commandButtonGone, {
          command: target.command,
        });
        return;
      }
      await afterCommand(ctx, result, probe);
      return;
    }
    const run = conversations.find(target.plugin, target.step);
    if (run === undefined) {
      ctx.log.event(LOG.stepButtonGone, {
        plugin: target.plugin,
        step: target.step,
      });
      return;
    }
    await runStep(ctx, { plugin: target.plugin, step: target.step, data: target.data, run }, probe);
  }

  /** Extras dos eventos de mensagem: os campos chegam aos listeners pela visão de cada plugin. */
  function listenerExtras(ctx: KernelMessageContext): ListenerExtras<'message'> {
    return messageExtras(ctx) as unknown as ListenerExtras<'message'>;
  }

  /**
   * Edição passa pelas mesmas barreiras da mensagem nova (fila do chat, boot, middlewares — o
   * `rateLimit` a conta), mas não dispara comando: só os listeners de `message.edited`.
   */
  function handleEdited(message: Message): Promise<void> {
    return admit(message, async (ctx) => {
      await bus.emit('message.edited', ctx.message, listenerExtras(ctx));
    });
  }

  return {
    handleMessage,
    handleEdited,
    handleInteraction,
    expireReply,
    interactionOf: (message) => interactions.get(message),
  };
}

function commandStatus(
  status: Extract<DispatchResult, { readonly consumed: true }>['status'],
  timedOut: boolean,
): MessageHandledSignal['status'] {
  if (status === 'rejected') return 'refused';
  if (status !== 'failed') return 'ok';
  return timedOut ? 'timeout' : 'failed';
}
