import { ActionRegistry } from '#actions/actions.ts';
import { createCommandCatalog } from '#commands/catalog.ts';
import { createPrefixStore } from '#commands/prefixes.ts';
import { createCommandRegistry } from '#commands/registry.ts';
import { createCommandRouter } from '#commands/router.ts';
import { normalizeOwners } from '#config/owners.ts';
import { createPluginConfigs, type PluginConfigs } from '#config/plugin-configs.ts';
import { ConversationRegistry, type WaitRecord } from '#conversations/conversations.ts';
import { ArmedTimers, ContextExpiredError } from '#deadline.ts';
import { createEventBus } from '#events/bus.ts';
import { createGroups } from '#groups/groups.ts';
import { sessionHttp } from '#http/server.ts';
import { createDeferredLogger } from '#logger/deferred.ts';
import { createLogger, createNoopLogger } from '#logger/logger.ts';
import { createSecretSet } from '#logger/secrets.ts';
import type { Logger } from '#logger/types.ts';
import { chatAllowed } from '#middleware/chat-filter.ts';
import { Observers } from '#observers/observers.ts';
import { createOutbound, enqueueAction } from '#outbound/actions.ts';
import { OutboundQueue } from '#outbound/queue.ts';
import { createPluginHost, type PluginHost } from '#plugin/host.ts';
import { PluginBootError } from '#plugin/report.ts';
import { collectPlugins } from '#plugin/sources.ts';
import { InboundQueue } from '#queue/inbound.ts';
import { createSchedulerService } from '#scheduler/service.ts';
import { createServiceRegistry } from '#services/registry.ts';
import { createMemoryStorage } from '#storage/memory.ts';
import {
  DEFAULT_SESSION,
  kernelStorage,
  sessionStorage,
  sharedStorage,
} from '#storage/namespace.ts';
import { TenantScope } from '#tenant/scope.ts';
import { type Capability, hasCapability } from '#transport/capabilities.ts';
import type { Transport } from '#transport/types.ts';
import { createUnsafeAccess } from '#unsafe/access.ts';
import { BackgroundTasks } from './background-tasks.ts';
import {
  buttonLimit,
  callConnect,
  isBootConflict,
  resolveTransport,
  validateSession,
} from './bot-setup.ts';
import type { Bot, BotConfig, BotState, BotStats } from './config.ts';
import { BotStateError } from './config.ts';
import { groupAdminPort } from './group-admin.ts';
import { createInboundFlow } from './inbound-flow.ts';
import type { ExpireOrigin, KernelMessageContext } from './message-context.ts';
import { createPipeline } from './middlewares.ts';
import { createPluginContextFactory } from './plugin-context.ts';
import { createPluginControl } from './plugin-control.ts';
import { createPluginErrorReporter, logPluginError } from './plugin-errors.ts';
import { ReadyGate } from './ready-gate.ts';
import { createReconnector, type Reconnector } from './reconnect.ts';
import { claimSession, type ReleaseSession } from './session.ts';
import { acquireSessionLease, type SessionLease } from './session-lease.ts';
import {
  type RegisteredStopHook,
  runStopHooks,
  type StopHook,
  type StopHookOptions,
} from './stop-hooks.ts';
import { createTransportEntry } from './transport-entry.ts';

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
    onError: (event) => logPluginError(log, event),
  });
  const pluginErrors = createPluginErrorReporter({ log: getLog, bus });
  // Sinais por unidade de trabalho, para métricas (ADR 0106).
  const observers = new Observers(pluginErrors.report);
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
  // A espera com `onExpire` que vence entra na fila do chat como uma mensagem (ADR 0097). As de
  // passo com `persist` ficam no storage da sessão (ADR 0098); a coleção só abre no primeiro uso.
  const conversations = new ConversationRegistry<KernelMessageContext, ExpireOrigin>({
    // `entry` nasce mais abaixo; seguro porque o `onDue` só dispara depois do `restore()` no boot.
    onDue: (chat, sender) => entry.expireWait(chat, sender),
    store: () => kernelStorage(scoped, 'conversations').collection<WaitRecord>('waits'),
    log: getLog,
  });
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
    observers,
  });
  const stats = (): BotStats => ({ inbound: inbound.stats(), outbound: outbound.stats() });
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
    onError: pluginErrors.report,
    onLateError: (event) => logPluginError(log, event),
    onStorageError: (error) => log.error('scheduler: falha no storage', { err: error }),
  });
  const gate = new ReadyGate();
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
    ready: () => gate.ready || gate.promise,
    reportPluginError: pluginErrors.report,
    background,
    observers,
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
  const entry = createTransportEntry({
    transport,
    inbound,
    outbound,
    tenants,
    flow,
    bus,
    observers,
    conversations,
    reconnector,
    gate,
    chatIsAllowed,
    dropsSelf,
    dropsBots,
    stopping: () => state === 'stopping' || state === 'stopped',
    log: getLog,
  });

  let host: PluginHost | undefined;
  let configs: PluginConfigs | undefined;
  let booted = false;
  const control = createPluginControl({
    host: () => host,
    configs: () => configs,
    state: () => state,
    catalog,
    conversations,
    lifecycleError: pluginErrors.lifecycle,
  });

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
      gate.settle(false);
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
    gate.settle(false);
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
      reload: (name) => control.plugins.reload(name),
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
      onHttpError: pluginErrors.report,
      transport: {
        name: transport.name,
        capabilities,
        get self() {
          return transport.self;
        },
      },
      stats,
      observers,
      unsafe: createUnsafeAccess({
        transport,
        log,
        interactionOf: flow.interactionOf,
      }),
      commandTimeoutMs,
      armed,
      onRoleError: pluginErrors.report,
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
    try {
      await pluginHost.start();
    } catch (error) {
      // Conflito de nome sai com o próprio erro (ADR 0007 e 0035): diz qual comando, papel ou
      // serviço colidiu, que é o que o autor precisa corrigir.
      const conflict =
        error instanceof PluginBootError &&
        error.failures.find(
          ({ reason }) => reason.kind === 'setup-failed' && isBootConflict(reason.error.cause),
        );
      if (conflict && conflict.reason.kind === 'setup-failed') throw conflict.reason.error.cause;
      throw error;
    }
    // Depois do `setup` de todos: só então se sabe que passo existe. Antes de liberar a fila de
    // entrada, então a primeira resposta já acha a espera.
    await conversations.restore(control.presence);
  }

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
      unsubscribe = entry.subscribe();
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

    // Mensagens que chegarem durante o handshake esperam na fila de entrada (`gate.promise`)
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
    gate.settle(true);
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
    // As gravações de espera persistida em andamento terminam antes de o storage fechar e de outro
    // processo assumir a sessão (ADR 0098). Falha de escrita já vai ao log; isto não rejeita.
    await conversations.flush();
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
    // Eventos diretos que chegam no boot esperam o `gate.promise` fora do barramento.
    if (state === 'starting') await gate.promise;
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

  const bot: Bot = {
    get state(): BotState {
      return state;
    },

    config: control.config,

    plugins: control.plugins,

    stats,

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
