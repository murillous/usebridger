import {
  type Bot,
  type BotConfig,
  type Chat,
  type Contact,
  createBot,
  createLogger,
  createMemoryStorage,
  type MediaInput,
  type Message,
  type OutgoingContent,
  type StoragePort,
} from '@usebridger/core';
import type { Interaction, TransportEvents } from '@usebridger/core/adapter';
import { FakeTransport, type SentMessage } from './fake-transport.ts';
import { buildMessage, type IncomingMessage } from './incoming.ts';
import { DEFAULT_SENDER, PROFILES, type ProfileName } from './profiles.ts';

/** Quem clica e onde, no `click()`. */
export interface ClickOptions {
  /** Campos do remetente que diferem do padrão: o do perfil ou `DEFAULT_SENDER`. */
  readonly sender?: Partial<Contact>;
  /** Padrão: o chat da mensagem que o envio cita ou, sem citação, conversa privada no `chatId`. */
  readonly chat?: Chat;
  /** Objeto bruto falso da interação, que o `ctx.unsafe.raw()` devolve (ADR 0066). */
  readonly raw?: unknown;
}

export interface TestBotOptions extends Omit<BotConfig, 'transport'> {
  /** Padrão: um `FakeTransport` do `profile` ou, sem perfil, com todas as capabilities. */
  readonly transport?: FakeTransport;
  /**
   * Perfil da plataforma (ADR 0073), atalho para `transport: new FakeTransport({ profile })`. Não
   * combina com `transport`: o perfil vai no transport.
   */
  readonly profile?: ProfileName;
}

/** Tipo de envio que carrega uma mídia. */
export type SentMediaType = Extract<OutgoingContent, { readonly media: MediaInput }>['type'];

/** Um envio de mídia com os bytes, como o `sentMedia()` devolve. */
export interface SentMedia<T extends SentMediaType = SentMediaType> {
  /** O registro do envio em `sent`, com `chatId`, `quoted` e o resto. */
  readonly sent: SentMessage;
  /** O conteúdo enviado, já do tipo pedido (`fileName` e `mimetype` no documento). */
  readonly content: Extract<OutgoingContent, { readonly media: MediaInput }> & { readonly type: T };
  /** Os bytes; `null` quando a mídia foi por URL (`{ url }`), que o transport falso não baixa. */
  readonly bytes: Buffer | null;
}

/** Bot rodando sobre um `FakeTransport`; cada ação espera o bot assentar antes de resolver. */
export interface TestBot {
  readonly bot: Bot;
  readonly transport: FakeTransport;
  /** O que o bot enviou, na ordem (o mesmo array de `transport.sent`). */
  readonly sent: readonly SentMessage[];
  /**
   * Os envios do tipo `type`, na ordem, com os bytes: `const [video] = bot.sentMedia('video')`.
   * Mídia dentro de álbum fica de fora, como nos matchers.
   */
  sentMedia<T extends SentMediaType>(type: T): SentMedia<T>[];
  /**
   * Entrega uma mensagem ao bot e resolve quando ele terminou de processá-la, com os envios que
   * ela causou já em `sent`. Devolve a mensagem entregue.
   */
  receive(input: IncomingMessage): Promise<Message>;
  /**
   * Clica no botão de rótulo `label` do envio (ADR 0062) e espera o bot assentar. Lança se o
   * envio não tem esse botão: num transport sem a capability `actions`, o menu sai em texto, e o
   * teste responde com o número pelo `receive()`.
   */
  click(sent: SentMessage, label: string, options?: ClickOptions): Promise<void>;
  /** Simula outro evento do canal (reação, entrada em grupo...) e espera o bot assentar. */
  emit<E extends keyof TransportEvents>(event: E, payload: TransportEvents[E]): Promise<void>;
  /**
   * Simula um restart (deploy, crash): para este bot e sobe outro com as mesmas opções sobre o
   * **mesmo storage**, que não é fechado no meio. Serve para testar o que sobrevive ao restart,
   * como as esperas de passo com `persist: true` (ADR 0098). `overrides` troca opções do bot novo
   * (a versão nova do plugin, por exemplo); o storage não se troca. O transport criado pelo kit
   * é novo (e `sent` começa vazio); o passado em `transport` é reaproveitado. Daqui em diante,
   * use o `TestBot` devolvido.
   */
  restart(overrides?: Omit<TestBotOptions, 'storage'>): Promise<TestBot>;
  /** Para o bot (teardown dos plugins, storage fechado). */
  stop(): Promise<void>;
}

/**
 * Cria e sobe um bot para teste. Os padrões tiram o que só atrapalha num teste: log desligado,
 * ambiente vazio (nenhum `BRIDGER_*` da máquina vaza para a config), fila de saída sem
 * intervalo entre envios e sem reconexão. Qualquer um deles pode ser sobrescrito.
 */
export function createTestBot(options: TestBotOptions = {}): Promise<TestBot> {
  const storage = options.storage ?? createMemoryStorage();
  return startTestBot(options, storage, keepOpen(storage));
}

/**
 * O storage como o bot o vê: o `close()` do `stop()` não o fecha, para o `restart()` subir o bot
 * novo sobre os mesmos dados. Quem fecha o de verdade é o `stop()` do kit. O mesmo objeto vale
 * em todos os restarts: o `claimSession` do core é por objeto, e o bot parado já o liberou.
 * `Proxy`, e não uma cópia campo a campo: um método que o `StoragePort` ganhar (ou que o adapter
 * tenha a mais) passa sem ninguém lembrar de repassá-lo. Os métodos saem presos ao original, para
 * o adapter de classe (com campos `#privados`) continuar funcionando.
 */
export function keepOpen(storage: StoragePort): StoragePort {
  return new Proxy(storage, {
    get(target, property) {
      if (property === 'close') return async () => undefined;
      const value: unknown = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

async function startTestBot(
  options: TestBotOptions,
  storage: StoragePort,
  durable: StoragePort,
): Promise<TestBot> {
  const { profile, ...config } = options;
  if (profile !== undefined && config.transport !== undefined) {
    throw new TypeError('createTestBot: passe `profile` ou `transport`, não os dois');
  }
  const transport = config.transport ?? new FakeTransport(profile === undefined ? {} : { profile });
  // O remetente padrão segue o perfil: sem telefone no Telegram, no Discord e no web.
  const sender =
    transport.profile === undefined ? DEFAULT_SENDER : PROFILES[transport.profile].sender;
  const bot = createBot({
    // Com `logLevel`, quem cria o logger é o bot, com os `secrets` da config.
    ...(config.logLevel === undefined && { logger: createLogger({ level: 'silent' }) }),
    env: {},
    reconnection: false,
    ...config,
    outbound: { globalIntervalMs: 0, chatIntervalMs: 0, ...config.outbound },
    transport,
    storage: durable,
  });
  await bot.start();
  // Contadores do bot, não do módulo (ADR 0004): os IDs recomeçam em cada `TestBot`.
  let received = 0;
  const build = { nextId: () => `in-${++received}`, sender };
  let clicks = 0;
  let restarted = false;
  return {
    bot,
    transport,
    sent: transport.sent,
    sentMedia: (type) => sentMediaOf(transport.sent, type),
    async receive(input) {
      const message = buildMessage(input, build);
      registerRaw(transport, message, input);
      transport.emit('message', message);
      await bot.settled();
      return message;
    },
    async click(sent, label, options = {}) {
      const action = sent.actions?.find((candidate) => candidate.label === label);
      if (action === undefined) {
        const labels = sent.actions?.map((candidate) => candidate.label) ?? [];
        throw new Error(
          `click: o envio não tem o botão ${JSON.stringify(label)} (botões: ${JSON.stringify(labels)})`,
        );
      }
      clicks++;
      const interaction: Interaction = {
        id: `click-${clicks}`,
        chat: options.chat ?? sent.quoted?.chat ?? { id: sent.chatId, isGroup: false },
        sender: { ...sender, ...options.sender },
        actionId: action.id,
        timestamp: Date.now(),
      };
      if ('raw' in options) transport.setRaw(interaction, options.raw);
      transport.emit('interaction', interaction);
      await bot.settled();
    },
    async emit(event, payload) {
      transport.emit(event, payload);
      await bot.settled();
    },
    async restart(overrides = {}) {
      restarted = true;
      await bot.stop();
      return startTestBot({ ...options, ...overrides }, storage, durable);
    },
    async stop() {
      await bot.stop();
      // Depois de um restart, o storage é do bot novo: só ele o fecha.
      if (!restarted) await storage.close();
    },
  };
}

/** O `raw` da descrição vai para o transport, na mensagem e na citada descrita (ADR 0066). */
function registerRaw(transport: FakeTransport, message: Message, input: IncomingMessage): void {
  if ('raw' in input) transport.setRaw(message, input.raw);
  const quoted = input.quoted;
  // A citada já pronta (`Message`) não tem descrição: quem a montou registra com `setRaw`.
  if (quoted !== undefined && !('is' in quoted) && message.quoted !== null) {
    registerRaw(transport, message.quoted, quoted);
  }
}

function sentMediaOf<T extends SentMediaType>(
  sent: readonly SentMessage[],
  type: T,
): SentMedia<T>[] {
  return sent.flatMap((record) => {
    const { content } = record;
    if (content.type !== type || !('media' in content)) return [];
    const bytes = Buffer.isBuffer(content.media) ? content.media : null;
    return [{ sent: record, content: content as SentMedia<T>['content'], bytes }];
  });
}
