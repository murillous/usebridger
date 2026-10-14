import { ActionRegistry } from '#actions/actions.ts';
import { createCommandCatalog } from '#commands/catalog.ts';
import { createPrefixStore } from '#commands/prefixes.ts';
import { CommandConflictError, createCommandRegistry } from '#commands/registry.ts';
import { RoleConflictError } from '#commands/roles.ts';
import { createCommandRouter } from '#commands/router.ts';
import { BotConfigError, normalizeOwners } from '#config/owners.ts';
import { createPluginConfigs, type PluginConfigs } from '#config/plugin-configs.ts';
import { ConversationRegistry } from '#conversations/conversations.ts';
import { ArmedTimers, ContextExpiredError } from '#deadline.ts';
import { createEventBus } from '#events/bus.ts';
import type { BotEvents, PluginErrorEvent } from '#events/types.ts';
import { createGroups } from '#groups/groups.ts';
import { sessionHttp } from '#http/server.ts';
import { createDeferredLogger } from '#logger/deferred.ts';
import { createLogger, createNoopLogger } from '#logger/logger.ts';
import { createSecretSet } from '#logger/secrets.ts';
import type { Logger } from '#logger/types.ts';
import type { Message } from '#message/types.ts';
import { chatAllowed } from '#middleware/chat-filter.ts';
import { createOutbound, enqueueAction } from '#outbound/actions.ts';
import { OutboundQueue } from '#outbound/queue.ts';
import { PLUGIN_NAME_PATTERN } from '#plugin/define.ts';
import { createPluginHost, type PluginChangeResult, type PluginHost } from '#plugin/host.ts';
import type { PluginLifecycleError, PluginReportEntry } from '#plugin/report.ts';
import { collectPlugins } from '#plugin/sources.ts';
import { InboundQueue } from '#queue/inbound.ts';
import { createSchedulerService } from '#scheduler/service.ts';
import { createServiceRegistry, ServiceConflictError } from '#services/registry.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import { DEFAULT_SESSION, sessionStorage, sharedStorage } from '#storage/namespace.ts';
import { TenantScope } from '#tenant/scope.ts';
import { type Capability, hasCapability } from '#transport/capabilities.ts';
import { transportIssues } from '#transport/methods.ts';
import type { Interaction, Transport, TransportDeps } from '#transport/types.ts';
import { createUnsafeAccess } from '#unsafe/access.ts';
import { BackgroundTasks } from './background-tasks.ts';
import type { Bot, BotConfig, BotPluginConfigs, BotPlugins, BotState, BotStats } from './config.ts';
import { BotStateError } from './config.ts';
import { DIRECT_EVENTS, type DirectEvent } from './direct-events.ts';
import { groupAdminPort } from './group-admin.ts';
import { createInboundFlow } from './inbound-flow.ts';
import type { KernelMessageContext } from './message-context.ts';
import { createPipeline } from './middlewares.ts';
import { createPluginContextFactory } from './plugin-context.ts';
import { createReconnector, type Reconnector } from './reconnect.ts';
import { claimSession, type ReleaseSession } from './session.ts';
import { acquireSessionLease, type SessionLease } from './session-lease.ts';
import {
  type RegisteredStopHook,
  runStopHooks,
  type StopHook,
  type StopHookOptions,
} from './stop-hooks.ts';

// Os testes de `bot/` importam o bot e seus erros daqui, junto com o `createBot`.
export type { Bot, BotConfig } from './config.ts';
export { BotStateError } from './config.ts';
export { GroupAdminTimeoutError } from './group-admin.ts';

/** Prazo padrão do `run` de um comando: o mesmo dos listeners. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000;

/** Prazo padrão de cada middleware: o mesmo dos handlers (ADR 0043). */
const DEFAULT_MIDDLEWARE_TIMEOUT_MS = 30_000;

/**
 * Prazos dos ganchos de parada internos. Somam o total padrão (`shutdown.timeoutMs`, 15 s): um
 * gancho lento não deixa os seguintes sem prazo. O que um gancho não encerrar a tempo é
 * abandonado no fim do shutdown (`abandonInternals`).
 */
const STOP_TIMEOUTS = {
  reconnection: 1000,
  inbound: 4000,
  scheduler: 2000,
  plugins: 5000,
  outbound: 3000,
} as const;

// Dono das rotas do transport na tabela HTTP da sessão; nome de plugin não tem `$`.
const TRANSPORT_ROUTE_OWNER = '$transport';

/**
 * Cria um bot. Valida a config e monta as peças sem efeito colateral (sem conexão, timer,
 * logger ou leitura de disco): o efeito começa em `start()`. Lança `BotConfigError` para
 * `owners` ou `session` malformados ou fábrica de transport que lança, e `TypeError`/`RangeError`
 * para opções inválidas.
 */
export function createBot(config: BotConfig): Bot {
  const session = validateSession(config.session ?? DEFAULT_SESSION);
  // Todo o estado vive neste closure (ADR 0004): duas instâncias nunca se enxergam.
  const hooks: RegisteredStopHook[] = [];
  let state: BotState = 'idle';
  let stopRequested = false;
  let startPromise: Promise<void> | undefined;
  let shutdownPromise: Promise<void> | undefined;
  let stopAfterStart: Promise<void> | undefined;

  // O logger nasce no start(): criar o do pino aqui já seria efeito colateral. Até lá, quem
  // logar (nada deveria) cai no no-op.
  let log: Logger = createNoopLogger();
  const getLog = (): Logger => log;
  const secrets = config.secrets ?? createSecretSet();
  const storage = config.storage ?? createMemoryStorage();
  // O escopo da sessão é aplicado aqui, uma vez: scheduler, config e plugins só veem esta visão.
  const scoped = sessionStorage(storage, session);
  const auth = storage.authState(session);
  // A fábrica recebe o logger antes de ele existir: este delega ao filho `{ transport }` que o
  // start() cria e, até lá, ao no-op.
  let transportLog: Logger | undefined;
  // A lista de comandos que o transport registra na plataforma (ADR 0064). O registro avisa o
  // catálogo, que junta os avisos em lote.
  const catalog = createCommandCatalog({
    list: () => registry.list(),
    onError: (error) =>
      log.error('listener de commands.onChange do transport falhou', { err: error }),
  });
  const registry = createCommandRegistry({ onChange: () => catalog.changed() });
  // Rotas da sessão no servidor do processo (ADR 0076); só entram nele no start().
  const http = config.http === undefined ? undefined : sessionHttp(config.http, session, getLog);
  let resolvedTransport: Transport | undefined;
  const transport = resolveTransport(config.transport, {
    session,
    auth,
    log: createDeferredLogger(() => transportLog ?? log),
    commands: catalog.commands,
    ...(http && {
      http: http.scope(
        TRANSPORT_ROUTE_OWNER,
        () => {
          if (resolvedTransport === undefined) {
            throw new Error('http.basePath: leia depois que a fábrica devolver o transport');
          }
          return `/transports/${encodeURIComponent(resolvedTransport.name)}`;
        },
        (error, route) => log.error(`rota ${route} do transport falhou`, { err: error }),
      ),
    }),
  });
  resolvedTransport = transport;
  // O transport registra rotas na fábrica; publicadas no start(), retiradas no stop.
  let httpAttached = false;
  let releaseSession: ReleaseSession | undefined;
  // Trava da sessão entre processos (ADR 0074); só existe com storage que a implementa.
  let sessionLease: SessionLease | undefined;
  // O `stop()` durante o `start()` aborta a espera pela trava em vez de esperar a validade.
  const bootAbort = new AbortController();
  // `connect()` já foi chamado: só então o shutdown desconecta.
  let connectCalled = false;
  // Desfaz a assinatura dos eventos do transport; existe depois que o start() a fez.
  let unsubscribe: (() => void) | undefined;
  const timeouts = config.timeouts ?? {};
  const commandTimeoutMs = timeouts.commandMs ?? DEFAULT_COMMAND_TIMEOUT_MS;

  // Prazos de comando, papel, consulta de admin e listener: o shutdown desarma os de handlers
  // presos (`abandonInternals`).
  const armed = new ArmedTimers();
  // Comandos com `background: true` em andamento: entram no `settled()`, o shutdown os solta.
  const background = new BackgroundTasks();
  const bus = createEventBus({
    listenerTimeoutMs: timeouts.listenerMs,
    armed,
    onError: (event) => logPluginError(event),
  });
  // Ordem dos pontos de extensão: a tabela do host, já na ordem de carga (ADR 0096).
  const services = createServiceRegistry({
    loadOrder: () => host?.report().map((entry) => entry.name) ?? [],
  });
  const prefixes = createPrefixStore(config.prefix, scoped);
  const router = createCommandRouter({
    registry,
    prefix: (chat) => prefixes.get(chat),
    selfUsername: () => transport.self?.username,
    owners: normalizeOwners(config.owners ?? []),
    isGroupAdmin: groupAdminPort(
      transport,
      commandTimeoutMs,
      (error) => log.warn('consulta de admin do grupo falhou depois do prazo', { err: error }),
      armed,
    ),
    // O comando é recusado de todo jeito (fail-closed); o log diz ao autor o que falta.
    onUnknownRole: (role, command) =>
      log.error(
        `comando "${command.name}" exige o papel "${role}", que nenhum plugin carregado define: ` +
          `declare dependsOn no plugin dono do papel (em "${command.plugin}")`,
        { plugin: command.plugin, command: command.name, role },
      ),
  });
  const conversations = new ConversationRegistry<KernelMessageContext>();
  const actions = new ActionRegistry();
  // Validado mesmo sem a capability: `limits.actions` malformado é erro de config de todo jeito.
  const buttonMax = buttonLimit(transport);
  const maxButtons = hasCapability(transport, 'actions') ? buttonMax : 0;
  const pipeline = createPipeline(
    config.middlewares ?? {},
    timeouts.middlewareMs ?? DEFAULT_MIDDLEWARE_TIMEOUT_MS,
    getLog,
  );
  // Os mesmos filtros, para os eventos que não passam pelo pipeline (ADR 0038).
  const chatFilterOptions = config.middlewares?.chatFilter;
  const chatIsAllowed = chatFilterOptions ? chatAllowed(chatFilterOptions) : () => true;
  const dropsSelf = config.middlewares?.ignoreSelf !== false;
  const dropsBots = config.middlewares?.ignoreBots !== false;
  const inbound = new InboundQueue({
    maxPendingPerChat: config.inbound?.maxPendingPerChat,
    onError: (error, chatId) => log.error('falha ao processar mensagem', { chatId, err: error }),
  });
  const outbound = new OutboundQueue({
    onTypingError: (error, chatId) =>
      log.debug('falha ao enviar "digitando"', { chatId, err: error }),
    ...config.outbound,
    transport,
  });
  // O plugin vê o envio e as ações (ADR 0040): a fila (close, stats) fica com o kernel.
  const send = createOutbound(outbound, transport);
  const groups = createGroups(transport, enqueueAction(outbound, transport));
  // Cópia: o plugin recebe um `ReadonlySet`, mas um cast não deve alterar o do transport.
  const capabilities: ReadonlySet<Capability> = new Set(transport.capabilities);
  // Tenant da mensagem ou do evento em andamento (ADR 0072): o storage dos plugins e os jobs
  // agendados seguem ele.
  const tenants = new TenantScope();
  const scheduler = createSchedulerService({
    storage: scoped,
    tenants,
    jobTimeoutMs: timeouts.jobMs,
    onError: (event) => reportPluginError(event),
    onLateError: (event) => logPluginError(event),
    onStorageError: (error) => log.error('scheduler: falha no storage', { err: error }),
  });
  const flow = createInboundFlow({
    router,
    conversations,
    actions,
    bus,
    pipeline,
    context: {
      sender: send,
      quote: hasCapability(transport, 'quoted'),
      reactions: hasCapability(transport, 'reactions'),
      log: getLog,
    },
    maxButtons,
    ready: () => ready || readyPromise,
    reportPluginError,
    background,
  });
  const reconnector: Reconnector | undefined =
    config.reconnection === false
      ? undefined
      : createReconnector({
          transport,
          log: getLog,
          options: {
            ...config.reconnection,
            // Com fábrica, o auth do transport é o do bot: o kernel sabe limpá-lo sozinho. Com
            // instância pronta, não sabe onde estão as credenciais.
            clearSession:
              config.reconnection?.clearSession ??
              (typeof config.transport === 'function' ? () => auth.clear() : undefined),
          },
          pairing: hasCapability(transport, 'pairing'),
          giveUp: () => {
            // Chamado de dentro de um handler do transport: o stop corre em paralelo.
            bot.stop().catch((error: unknown) => log.error('falha ao parar o bot', { err: error }));
          },
        });

  let host: PluginHost | undefined;
  let configs: PluginConfigs | undefined;
  let booted = false;
  // Mensagens que chegam enquanto os plugins sobem esperam aqui; `false` = boot abortado. Só a
  // primeira chamada vale: depois de pronto, o shutdown drena o que a fila já aceitou.
  let ready = false;
  let settleReady: (ok: boolean) => void = () => undefined;
  const readyPromise = new Promise<boolean>((resolve) => {
    settleReady = (ok) => {
      settleReady = () => undefined;
      ready = ok;
      resolve(ok);
    };
  });

  function logPluginError(event: PluginErrorEvent): void {
    log.error(`plugin "${event.plugin}" falhou (${event.phase})`, {
      plugin: event.plugin,
      phase: event.phase,
      event: event.event,
      timedOut: event.timedOut,
      err: event.error,
    });
  }

  /** Falha de handler de plugin: vai ao log e aos observadores de `plugin.error`. */
  function reportPluginError(event: PluginErrorEvent): void {
    logPluginError(event);
    void bus.emit('plugin.error', event);
  }

  /** Erros de ciclo de vida do host viram `plugin.error` (o host já os logou). */
  function emitLifecycleError(error: PluginLifecycleError): void {
    const phase = error.phase === 'context' || error.phase === 'setup' ? 'setup' : 'teardown';
    void bus.emit('plugin.error', {
      plugin: error.plugin,
      phase,
      event: null,
      error: error.cause ?? error,
      timedOut: error.timedOut,
    });
  }

  // --- Entrada do transport ----------------------------------------------------------------

  /**
   * Põe a mensagem (nova ou editada) ou o clique na fila do chat dele: o mesmo chat anda em
   * série. A tarefa roda no escopo do tenant do chat (ADR 0072).
   */
  function enqueue<T extends Message | Interaction>(
    item: T,
    handle: (item: T) => Promise<void>,
  ): void {
    const result = inbound.enqueue(item.chat.id, () =>
      tenants.run(item.chat.tenantId, () => handle(item)),
    );
    if (result !== 'queued') {
      log.warn('mensagem descartada pela fila de entrada', {
        chatId: item.chat.id,
        messageId: item.id,
        reason: result,
      });
    }
  }

  /**
   * Repassa um evento que não é mensagem ao barramento, depois do `chatFilter`, do `ignoreSelf` e
   * do `ignoreBots` (ADR 0038). Durante o boot, espera os plugins subirem; sem fila do chat.
   */
  function forward<E extends DirectEvent>(event: E): () => void {
    const origin = DIRECT_EVENTS[event];
    return transport.on(event, (transportPayload) => {
      // `BotEvents` estende `TransportEvents`: o payload é o mesmo tipo.
      const payload = transportPayload as BotEvents[E];
      const { chat, fromMe, fromBot } = origin(payload);
      if ((fromMe && dropsSelf) || (fromBot && dropsBots)) return;
      if (chat !== null && !chatIsAllowed(chat)) return;
      // Os listeners rodam no escopo do tenant do chat (ADR 0072). Ele vem do payload, não da
      // origem: entrada e saída do grupo passam pelo filtro sem chat, mas são de um tenant.
      const tenant = 'chat' in payload ? payload.chat.tenantId : undefined;
      tenants.run(tenant, () => {
        if (ready) {
          void bus.emit(event, payload);
          return;
        }
        // Boot abortado ou `stop()` antes do fim: o evento é descartado, como a mensagem.
        void readyPromise.then((ok) => {
          if (ok) void bus.emit(event, payload);
        });
      });
    });
  }

  /** Assina todos os eventos do transport; devolve a função que desfaz. */
  function subscribeTransport(): () => void {
    const offs: (() => void)[] = [
      transport.on('message', (message) => enqueue(message, flow.handleMessage)),
      transport.on('message.edited', (message) => enqueue(message, flow.handleEdited)),
      transport.on('interaction', (interaction) => enqueue(interaction, flow.handleInteraction)),
      transport.on('connection.status', (status) => {
        // Com a conexão caída, o envio falharia e esgotaria o retry antes da reconexão (#198).
        if (status.status === 'closed') outbound.pause();
        else if (status.status === 'open') outbound.resume();
        reconnector?.onStatus(status);
        void bus.emit('connection.status', status);
      }),
      transport.on('connection.qr', (payload) => {
        reconnector?.onQr();
        // Quem lê o log em info (agregador, arquivo) pareia o número com o QR enquanto ele vale:
        // o valor fica em debug e no barramento (`connection.qr`), para quem exibe a tela.
        log.info('QR de pareamento recebido; exiba-o pelo evento connection.qr');
        log.debug('valor do QR de pareamento', { qr: payload.qr });
        void bus.emit('connection.qr', payload);
      }),
      transport.on('connection.pairing-code', (payload) => {
        // Mesma tentativa de pareamento que o QR (ADR 0050), e o mesmo risco no log.
        reconnector?.onQr();
        log.info('código de pareamento recebido; exiba-o pelo evento connection.pairing-code');
        log.debug('valor do código de pareamento', { code: payload.code });
        void bus.emit('connection.pairing-code', payload);
      }),
    ];
    for (const event of Object.keys(DIRECT_EVENTS) as DirectEvent[]) offs.push(forward(event));
    return () => {
      for (const off of offs.splice(0)) off();
    };
  }

  // --- Boot ---------------------------------------------------------------------------------

  /**
   * Ganchos internos, empilhados para o LIFO rodar na ordem do shutdown (docs/bot.md). Estourado
   * o prazo, cada um abandona o que falta (o `signal` aborta) em vez de seguir em segundo plano.
   */
  function registerInternalHooks(): void {
    const push = (name: string, timeoutMs: number, hook: StopHook): void => {
      hooks.push({ name, timeoutMs, hook });
    };
    push('fila-de-saida', STOP_TIMEOUTS.outbound, (signal) => {
      // Conexão caída: o gancho do transporte já parou a reconexão, então drenar só gastaria o
      // prazo. Descarta já (ADR 0039).
      if (outbound.paused) return outbound.close({ drain: false });
      // Drena até o prazo; estourado, descarta o que aguarda (docs/outbound-queue.md).
      signal.addEventListener('abort', () => void outbound.close({ drain: false }), {
        once: true,
      });
      return outbound.close();
    });
    // Desce depois do scheduler: o teardown não corre junto com um job do próprio plugin.
    push('plugins', STOP_TIMEOUTS.plugins, async (signal) => {
      const errors = (await host?.stop(signal)) ?? [];
      if (errors.length > 0) {
        throw new AggregateError(errors, `teardown: ${errors.length} falha(s) de plugin`);
      }
    });
    push('scheduler', STOP_TIMEOUTS.scheduler, (signal) => scheduler.stop(signal));
    push('fila-de-entrada', STOP_TIMEOUTS.inbound, (signal) => {
      signal.addEventListener('abort', () => void inbound.close({ drain: false }), {
        once: true,
      });
      return inbound.close();
    });
    push('transporte', STOP_TIMEOUTS.reconnection, async () => {
      // Para de aceitar eventos (nada novo entra na fila) e de reconectar.
      unsubscribe?.();
      settleReady(false);
      await reconnector?.stop();
    });
  }

  /**
   * Passo obrigatório do shutdown, sem prazo: abandona o que os ganchos internos não encerraram
   * (estouraram o prazo, ou nem rodaram porque o prazo total acabou antes). Depois dele nenhum
   * timer do bot fica vivo e as filas estão fechadas; jobs abandonados ficam no storage e
   * disparam na próxima subida. Num shutdown limpo, não acha nada a fazer.
   */
  async function abandonInternals(): Promise<void> {
    if (unsubscribe === undefined) return;
    unsubscribe();
    settleReady(false);
    const aborted = AbortSignal.abort();
    // Sem await: o que resta delas é trabalho já em andamento, e nenhuma das três rejeita.
    void reconnector?.stop();
    void inbound.close({ drain: false });
    // Middleware preso na mensagem abandonada: sem isto, o timer dele viveria até o prazo.
    pipeline.close();
    await scheduler.stop(aborted);
    // Teardown pulado ou abandonado vira falha que o host loga; o `dispose` roda para todos.
    await host?.stop(aborted);
    // Depois do descarte dos plugins, que já expirou o `Deadline` dos handlers presos (o
    // `signal` aborta, o `reply` é recusado): sobra só o timer do prazo de cada um.
    armed.disarmAll();
    // Comando em segundo plano preso fica sem prazo e não assentaria: o `settled()` não o espera.
    background.clear();
    // O `dispose` de cada plugin já tirou as esperas dele; isto garante que nenhum timer de TTL
    // sobreviva ao `stop()` e que um passo atrasado não registre outra.
    conversations.close();
    actions.clear();
    void outbound.close({ drain: false });
  }

  async function bootPlugins(): Promise<void> {
    // Antes do `setup`: um plugin pode ler o prefixo do chat já no boot.
    await prefixes.load();
    const entries = await collectPlugins({
      plugins: config.plugins,
      pluginDirs: config.pluginDirs,
      cwd: config.cwd,
    });
    configs = createPluginConfigs({
      plugins: entries.map((entry) => entry.definition),
      file: config.pluginConfig,
      storage: scoped,
      env: config.env,
      secrets,
      log,
      reload: (name) => reload(name),
    });
    const createContext = createPluginContextFactory({
      configs,
      log,
      router,
      prefixes,
      conversations,
      bus,
      services,
      storage: scoped,
      shared: sharedStorage(storage),
      tenants,
      scheduler,
      send,
      groups,
      http,
      onHttpError: (event) => reportPluginError(event),
      transport: {
        name: transport.name,
        capabilities,
        get self() {
          return transport.self;
        },
      },
      unsafe: createUnsafeAccess({
        transport,
        log,
        interactionOf: flow.interactionOf,
      }),
      commandTimeoutMs,
      armed,
      onRoleError: (event) => reportPluginError(event),
      onLateCommandError: (plugin, command, error) => {
        // A recusa de um contexto expirado já foi logada quando aconteceu (ADR 0033).
        if (error instanceof ContextExpiredError) return;
        log.error(`comando "${command}" rejeitou depois do prazo`, {
          plugin,
          command,
          err: error,
        });
      },
    });
    const pluginHost = createPluginHost({
      plugins: entries,
      transport,
      createContext,
      log,
      disabledPlugins: config.disabledPlugins,
      setupTimeoutMs: timeouts.setupMs,
      teardownTimeoutMs: timeouts.teardownMs,
    });
    host = pluginHost;
    const table = await pluginHost.start();
    for (const entry of table) {
      if (entry.status !== 'skipped' || entry.reason.kind !== 'setup-failed') continue;
      const { error } = entry.reason;
      // Conflito de nome é erro no boot (ADR 0007 e 0035), não "plugin ignorado": quem
      // respondesse ao comando, papel ou serviço dependeria da ordem de carga.
      if (isBootConflict(error.cause)) throw error.cause;
      emitLifecycleError(error);
    }
  }

  /** Mudança de um plugin em execução (`action` só entra na mensagem de erro). */
  async function change(
    action: 'reload' | 'disable' | 'enable',
    name: string,
  ): Promise<PluginChangeResult> {
    if (!host) throw new BotStateError(`${action}("${name}"): plugins ainda não carregados`, state);
    // Um aviso só ao transport, no fim: no meio, os comandos do plugin saíram e não voltaram.
    const pluginHost = host;
    const result = await catalog.batch(() => pluginHost[action](name));
    for (const error of result.teardownErrors) emitLifecycleError(error);
    // Os dependentes recarregados em cascata (ADR 0041) também podem falhar no `setup` novo.
    for (const entry of [result.plugin, ...result.dependents]) {
      if (entry.status === 'skipped' && entry.reason.kind === 'setup-failed') {
        emitLifecycleError(entry.reason.error);
      }
    }
    return result;
  }

  const reload = (name: string): Promise<PluginChangeResult> => change('reload', name);

  const plugins: BotPlugins = Object.assign((): PluginReportEntry[] => host?.report() ?? [], {
    reload,
    disable: (name: string) => change('disable', name),
    enable: (name: string) => change('enable', name),
  });

  async function runStart(): Promise<void> {
    try {
      log =
        config.logger ??
        createLogger({
          level: config.logLevel ?? 'info',
          ...(config.logFormat && { format: config.logFormat }),
          secrets,
        });
      transportLog = log.child({ transport: transport.name });
      // Antes de `booted`: um bot recusado aqui não fecha o storage do bot que usa a sessão.
      releaseSession = claimSession(storage, session);
      booted = true;
      // Ligada já no boot: o `/health` mostra a sessão subindo (503) até ela ficar `running`.
      http?.attach(() => state);
      httpAttached = http !== undefined;
      if (config.storage === undefined) {
        log.warn('sem storage configurado: usando memória, os dados somem ao reiniciar');
      }
      // Sem conexão até o primeiro `open`: o `connect()` resolve ao iniciar a tentativa, e os
      // envios do setup e dos jobs vencidos iriam para um socket ainda fechado (ADR 0048). O
      // teto da pausa conta daqui.
      outbound.pause();
      unsubscribe = subscribeTransport();
      registerInternalHooks();
      // Antes dos plugins, que já gravam no storage e agendam jobs da sessão. Depois de assinar
      // os eventos: os que chegarem esperam a trava na fila do boot, como esperam os plugins.
      sessionLease = await acquireSessionLease({
        storage,
        session,
        log,
        signal: bootAbort.signal,
        onLost: () => {
          log.error('outro processo assumiu a trava da sessão; parando o bot', { session });
          bot.stop().catch((error: unknown) => log.error('falha ao parar o bot', { err: error }));
        },
      });
    } catch (error) {
      // Nada conectou ainda: só desfaz o que foi registrado.
      await shutdown().catch((cleanup: unknown) =>
        log.error('falha ao encerrar após erro no start', { err: cleanup }),
      );
      throw error;
    }

    // Plugins primeiro, connect depois (plano §5.3): um plugin quebrado (conflito de comando,
    // manifesto inválido, ciclo) derruba o boot antes de o transport abrir sessão — sem QR nem
    // handshake à toa.
    try {
      await bootPlugins();
    } catch (error) {
      log.error('falha ao carregar os plugins; encerrando', { err: error });
      // O transport nunca conectou: o encerramento não chama `disconnect()`.
      await failBoot(error);
    }
    // Com as rotas dos plugins e do transport registradas, abre a porta (se houver rota) antes
    // do connect: o transport pode precisar do webhook de pé para conectar. Porta ocupada derruba
    // o boot.
    try {
      await http?.listen();
    } catch (error) {
      log.error('falha ao abrir a porta HTTP; encerrando', { err: error });
      await failBoot(error);
    }
    // Daqui em diante, mudança na lista de comandos avisa o transport.
    catalog.open();

    // stop() chegou durante o boot: quem chamou stop() conduz o encerramento. Conferido também
    // antes do connect, para não abrir sessão (QR, handshake) só para fechá-la em seguida.
    const stoppedDuringBoot = (): BotStateError =>
      new BotStateError('start(): bot parado durante a inicialização', state);
    if (stopRequested) throw stoppedDuringBoot();

    // Mensagens que chegarem durante o handshake esperam na fila de entrada (`readyPromise`)
    // até o fim do boot. Conectado, uma queda já é reconectada.
    try {
      // O transport pode conectar pela metade: daqui em diante o encerramento desconecta.
      connectCalled = true;
      await callConnect(transport);
      reconnector?.activate();
    } catch (error) {
      await failBoot(error);
    }

    if (stopRequested) throw stoppedDuringBoot();
    scheduler.start();
    settleReady(true);
    state = 'running';
  }

  /** Encerra o que o boot já subiu e relança `failure` (ou o `AggregateError` com a limpeza). */
  async function failBoot(failure: unknown): Promise<never> {
    try {
      await shutdown();
    } catch (cleanupError) {
      const cleanup = cleanupError instanceof AggregateError ? cleanupError.errors : [];
      throw new AggregateError([failure, ...cleanup], 'start(): falha no boot e ao encerrar');
    }
    throw failure;
  }

  // --- Shutdown -----------------------------------------------------------------------------

  function shutdown(): Promise<void> {
    shutdownPromise ??= runShutdown();
    return shutdownPromise;
  }

  async function runShutdown(): Promise<void> {
    state = 'stopping';
    // O teardown tira os comandos de cada plugin: o transport não deve apagar o menu da plataforma.
    catalog.close();
    // LIFO: quem subiu por último depende de quem subiu antes, então desce primeiro.
    const errors: unknown[] = await runStopHooks(hooks.toReversed(), config.shutdown);
    hooks.length = 0;
    await abandonInternals();
    if (connectCalled) {
      try {
        await transport.disconnect();
      } catch (error) {
        errors.push(error);
      }
    }
    // Os teardowns já tiraram as rotas dos plugins; sai a do transport, e o último bot fecha a porta.
    if (httpAttached) {
      try {
        await http?.detach();
      } catch (error) {
        errors.push(error);
      }
    }
    // Storage por último: os teardowns e o scheduler ainda o usam até aqui. Se outro bot (outra
    // sessão) ainda o usa, quem fecha é o último a parar.
    // Liberada no stop limpo, a sessão sobe em outro processo na hora, sem esperar a validade.
    try {
      await sessionLease?.release();
    } catch (error) {
      errors.push(error);
    }
    const lastUser = releaseSession?.() ?? true;
    if (booted && lastUser) {
      try {
        await storage.close();
      } catch (error) {
        errors.push(error);
      }
    }
    state = 'stopped';
    if (errors.length > 0) {
      throw new AggregateError(errors, `stop(): ${errors.length} falha(s) no encerramento`);
    }
  }

  /**
   * As três fontes de trabalho se realimentam (o comando envia, o envio rejeitado vira
   * `plugin.error`, o listener envia de novo): repete a espera até as três estarem ociosas na
   * mesma conferência síncrona. Só roda quando chamado: o caminho da mensagem não paga nada.
   */
  async function settled(): Promise<void> {
    // Eventos diretos que chegam no boot esperam o `readyPromise` fora do barramento.
    if (state === 'starting') await readyPromise;
    while (
      !(
        inbound.stats().activeChats === 0 &&
        background.size === 0 &&
        bus.idle &&
        outbound.stats().activeChats === 0
      )
    ) {
      await inbound.onIdle();
      await background.idle();
      await bus.onIdle();
      await outbound.onIdle();
    }
  }

  const pluginConfigs: BotPluginConfigs = {
    setOverrides: (plugin, overrides) =>
      requireConfigs('setOverrides').setOverrides(plugin, overrides),
    describe: (plugin) => requireConfigs('describe').describe(plugin),
    jsonSchema: (plugin) => requireConfigs('jsonSchema').jsonSchema(plugin),
  };

  function requireConfigs(method: string): PluginConfigs {
    if (!configs) {
      throw new BotStateError(`config.${method}(): plugins ainda não carregados (start)`, state);
    }
    return configs;
  }

  const bot: Bot = {
    get state(): BotState {
      return state;
    },

    config: pluginConfigs,

    plugins,

    stats(): BotStats {
      return { inbound: inbound.stats(), outbound: outbound.stats() };
    },

    settled,

    start(): Promise<void> {
      switch (state) {
        case 'idle':
          state = 'starting';
          startPromise = runStart();
          return startPromise;
        case 'starting':
        case 'running':
          return startPromise ?? Promise.resolve();
        default:
          return Promise.reject(
            new BotStateError(`start(): bot em "${state}" não reinicia`, state),
          );
      }
    },

    stop(): Promise<void> {
      switch (state) {
        case 'idle':
          return shutdown();
        case 'starting': {
          stopRequested = true;
          bootAbort.abort(new BotStateError('start(): bot parado durante a inicialização', state));
          // Espera o boot assentar (sucesso ou falha) e só então encerra; se o start já
          // encerrou por falha, `shutdown` devolve a mesma promise.
          const afterStart = (): Promise<void> => shutdown();
          stopAfterStart ??= (startPromise ?? Promise.resolve()).then(afterStart, afterStart);
          return stopAfterStart;
        }
        case 'running':
          return shutdown();
        case 'stopping':
          return stopAfterStart ?? shutdownPromise ?? Promise.resolve();
        case 'stopped':
          return Promise.resolve();
      }
    },

    onStop(hook: StopHook, options: StopHookOptions = {}): () => void {
      if (state === 'stopping' || state === 'stopped') {
        throw new BotStateError(`onStop(): bot em "${state}" não aceita ganchos`, state);
      }
      const entry: RegisteredStopHook = {
        hook,
        name: options.name ?? (hook.name || 'anonimo'),
        timeoutMs: options.timeoutMs,
      };
      hooks.push(entry);
      return () => {
        const index = hooks.indexOf(entry);
        if (index !== -1) hooks.splice(index, 1);
      };
    },
  };
  return bot;
}

/** Erros de `setup` que derrubam o boot em vez de só ignorar o plugin. */
const isBootConflict = (error: unknown): boolean =>
  error instanceof CommandConflictError ||
  error instanceof RoleConflictError ||
  error instanceof ServiceConflictError;

/** Nome de sessão no formato de nome de plugin: vira prefixo de namespace no storage. */
function validateSession(session: string): string {
  if (!PLUGIN_NAME_PATTERN.test(session)) {
    throw new BotConfigError(
      `session deve ser kebab-case minúsculo (ex.: "atendimento"); recebido "${session}"`,
    );
  }
  return session;
}

/** Instância pronta, ou a que a fábrica monta; fábrica que lança é erro de config. */
function resolveTransport(transport: BotConfig['transport'], deps: TransportDeps): Transport {
  let resolved: Transport;
  if (typeof transport !== 'function') resolved = transport;
  else {
    try {
      resolved = transport(deps);
    } catch (error) {
      throw new BotConfigError('transport: a fábrica lançou ao montar o transport', {
        cause: error,
      });
    }
  }
  // Capability sem o método dela só falharia quando um plugin a usasse (ADR 0080).
  const issues = transportIssues(resolved);
  if (issues.length > 0) {
    throw new BotConfigError(`transport inválido:\n- ${issues.join('\n- ')}`);
  }
  return resolved;
}

/** `transport.connect()` com um throw síncrono do adapter virando rejeição. */
function callConnect(transport: Transport): Promise<void> {
  try {
    return transport.connect();
  } catch (error) {
    return Promise.reject(error);
  }
}

/** Máximo de botões por mensagem do transport (`limits.actions`); sem ele, sem limite. */
function buttonLimit(transport: Transport): number {
  const limit = transport.limits?.actions;
  if (limit === undefined) return Number.POSITIVE_INFINITY;
  if (!(Number.isInteger(limit) && limit >= 1)) {
    throw new RangeError(`limits.actions do transport deve ser inteiro >= 1 (recebido: ${limit})`);
  }
  return limit;
}
