// Catálogo dos eventos de log do core (ADR 0118), importado como `import * as LOG`. O nome é
// contrato com o agregador: evento novo é minor; renomear ou remover quebra. Fica fora da API
// pública: quem filtra usa o nome, não o objeto.

import { defineLogEvent } from './define-event.ts';
import type { LogEvent } from './types.ts';

// Ciclo de vida do bot.
export const storageMissing: LogEvent = defineLogEvent({
  name: 'bot.storage.missing',
  level: 'warn',
  message: 'sem storage configurado: usando memória, os dados somem ao reiniciar',
});
export const stopFailed: LogEvent = defineLogEvent({
  name: 'bot.stop.failed',
  level: 'error',
  message: 'falha ao parar o bot',
});
export const startCleanupFailed: LogEvent = defineLogEvent({
  name: 'bot.start.cleanup-failed',
  level: 'error',
  message: 'falha ao encerrar após erro no start',
});
export const pluginsLoadFailed: LogEvent = defineLogEvent({
  name: 'bot.plugins.load-failed',
  level: 'error',
  message: 'falha ao carregar os plugins; encerrando',
});
export const httpOpenFailedOnBoot: LogEvent = defineLogEvent({
  name: 'bot.http.open-failed',
  level: 'error',
  message: 'falha ao abrir a porta HTTP; encerrando',
});
export const failedDisconnectFailed: LogEvent = defineLogEvent({
  name: 'bot.failed.disconnect-failed',
  level: 'error',
  message: 'falha ao desconectar o transport no estado failed',
});

// Trava da sessão (ADR 0070).
export const sessionTaken: LogEvent = defineLogEvent({
  name: 'session.lease.lost',
  level: 'error',
  message: 'outro processo assumiu a trava da sessão; parando o bot',
});
export const sessionLocked: LogEvent = defineLogEvent({
  name: 'session.lease.waiting',
  level: 'warn',
  message: 'sessão travada por outro processo; esperando a trava vencer',
});
export const sessionRenewFailed: LogEvent = defineLogEvent({
  name: 'session.lease.renew-failed',
  level: 'warn',
  message: 'falha ao renovar a trava da sessão; tentando no próximo intervalo',
});

// Conexão e reconexão.
export const connectionOpened: LogEvent = defineLogEvent({
  name: 'connection.opened',
  level: 'info',
  message: 'conexão aberta',
});
export const connectionConnecting: LogEvent = defineLogEvent({
  name: 'connection.connecting',
  level: 'debug',
  message: 'conectando',
});
export const connectionClosed: LogEvent = defineLogEvent({
  name: 'connection.closed',
  level: 'warn',
  message: 'conexão fechada: reconectando',
});
export const reconnectFailed: LogEvent = defineLogEvent({
  name: 'connection.reconnect.failed',
  level: 'error',
  message: 'reconexão falhou',
});
export const connectionReplaced: LogEvent = defineLogEvent({
  name: 'connection.replaced',
  level: 'error',
  message:
    'conexão encerrada: outra conexão assumiu esta sessão (o mesmo número rodando em outro ' +
    'processo?); o bot passa a failed em vez de derrubá-la',
});
export const connectionFatal: LogEvent = defineLogEvent({
  name: 'connection.fatal',
  level: 'fatal',
  message:
    'conexão encerrada por erro fatal do transport (token sem permissão, intents, porta?); ' +
    'reconectar não resolve: corrija a configuração. O bot passa a failed (plugins e HTTP ' +
    'seguem no ar)',
});
export const connectionAuthFailed: LogEvent = defineLogEvent({
  name: 'connection.auth-failed',
  level: 'fatal',
  message:
    'conexão encerrada: credenciais rejeitadas, e o transport não pareia de novo (token ' +
    'inválido?); limpar a sessão não resolve. O bot passa a failed (plugins e HTTP seguem no ar)',
});
export const connectionUnpaired: LogEvent = defineLogEvent({
  name: 'connection.session-lost',
  level: 'error',
  message:
    'conexão encerrada: a sessão precisa ser pareada de novo e não há clearSession ' +
    'configurado; o bot passa a failed',
});
export const pairingQr: LogEvent = defineLogEvent({
  name: 'connection.qr.received',
  level: 'info',
  message: 'QR de pareamento recebido; exiba-o pelo evento connection.qr',
});
export const pairingQrValue: LogEvent = defineLogEvent({
  name: 'connection.qr.value',
  level: 'debug',
  message: 'valor do QR de pareamento',
});
export const pairingCode: LogEvent = defineLogEvent({
  name: 'connection.pairing-code.received',
  level: 'info',
  message: 'código de pareamento recebido; exiba-o pelo evento connection.pairing-code',
});
export const pairingCodeValue: LogEvent = defineLogEvent({
  name: 'connection.pairing-code.value',
  level: 'debug',
  message: 'valor do código de pareamento',
});

// Transport.
export const transportHandlerFailed: LogEvent = defineLogEvent({
  name: 'transport.handler.failed',
  level: 'error',
  message: 'handler de evento do transport falhou',
});
export const transportCommandsListenerFailed: LogEvent = defineLogEvent({
  name: 'transport.commands-listener.failed',
  level: 'error',
  message: 'listener de commands.onChange do transport falhou',
});
export const transportRouteFailed: LogEvent = defineLogEvent({
  name: 'transport.route.failed',
  level: 'error',
  message: 'rota do transport falhou',
});
export const unsafeUndeclared: LogEvent = defineLogEvent({
  name: 'transport.unsafe.undeclared',
  level: 'warn',
  message:
    'plugin acessou o objeto nativo do transport sem declarar transports no manifesto; ele ' +
    'fica preso a este transport (declare transports no manifesto)',
});
export const unsafeAccessed: LogEvent = defineLogEvent({
  name: 'transport.unsafe.accessed',
  level: 'warn',
  message: 'plugin acessou o objeto nativo do transport',
});

// Entrada e pipeline.
export const messageFailed: LogEvent = defineLogEvent({
  name: 'message.failed',
  level: 'error',
  message: 'falha ao processar mensagem',
});
export const messageDropped: LogEvent = defineLogEvent({
  name: 'message.dropped',
  level: 'warn',
  message: 'mensagem descartada pela fila de entrada',
});
export const messageRateLimited: LogEvent = defineLogEvent({
  name: 'message.rate-limited',
  level: 'debug',
  message: 'mensagem barrada pelo rate limit',
});
export const middlewareLate: LogEvent = defineLogEvent({
  name: 'middleware.late-rejection',
  level: 'error',
  message: 'middleware rejeitou depois do prazo',
});
export const reactSkipped: LogEvent = defineLogEvent({
  name: 'message.react.skipped',
  level: 'debug',
  message: 'react ignorado: o transport não tem a capability "reactions"',
});
export const typingFailed: LogEvent = defineLogEvent({
  name: 'outbound.typing.failed',
  level: 'debug',
  message: 'falha ao enviar "digitando"',
});
export const contextExpired: LogEvent = defineLogEvent({
  name: 'context.expired',
  level: 'warn',
  message: 'operação recusada: o contexto já expirou',
});

// Comandos e papéis.
export const commandTimeout: LogEvent = defineLogEvent({
  name: 'command.timeout',
  level: 'error',
  message: 'comando rejeitou depois do prazo',
});
export const commandBackgroundFailed: LogEvent = defineLogEvent({
  name: 'command.background.failed',
  level: 'error',
  message: 'falha ao concluir o comando em segundo plano',
});
export const commandRefusalFailed: LogEvent = defineLogEvent({
  name: 'command.refusal.failed',
  level: 'warn',
  message: 'falha ao enviar a recusa do comando',
});
export const commandUnknownRole: LogEvent = defineLogEvent({
  name: 'command.role.unknown',
  level: 'error',
  message:
    'comando exige um papel que nenhum plugin carregado define: declare dependsOn no plugin ' +
    'dono do papel',
});
export const commandMissingCapability: LogEvent = defineLogEvent({
  name: 'command.unregistered.capability',
  level: 'warn',
  message: 'comando não registrado: capability ausente no transport',
});
export const commandMissingService: LogEvent = defineLogEvent({
  name: 'command.unregistered.service',
  level: 'warn',
  message: 'comando não registrado: serviço não provido',
});
export const nativeCommandGone: LogEvent = defineLogEvent({
  name: 'command.native.gone',
  level: 'debug',
  message: 'comando nativo que não existe mais; descartado',
});
export const commandButtonGone: LogEvent = defineLogEvent({
  name: 'command.button.gone',
  level: 'debug',
  message: 'botão de comando que não existe mais; descartado',
});
export const buttonUnknown: LogEvent = defineLogEvent({
  name: 'action.button.unknown',
  level: 'debug',
  message: 'clique em botão vencido ou desconhecido; descartado',
});
export const roleTimeout: LogEvent = defineLogEvent({
  name: 'role.timeout',
  level: 'error',
  message: 'papel rejeitou depois do prazo',
});
export const roleFailed: LogEvent = defineLogEvent({
  name: 'role.check.failed',
  level: 'warn',
  message: 'consulta do papel falhou: comando fora da lista',
});
export const groupAdminTimeout: LogEvent = defineLogEvent({
  name: 'role.group-admin.timeout',
  level: 'warn',
  message: 'consulta de admin do grupo falhou depois do prazo',
});

// Conversas (ADR 0056, 0094).
export const stepTimeout: LogEvent = defineLogEvent({
  name: 'conversation.step.timeout',
  level: 'error',
  message: 'passo rejeitou depois do prazo',
});
export const stepExpireTimeout: LogEvent = defineLogEvent({
  name: 'conversation.expire.timeout',
  level: 'error',
  message: 'onExpire do passo rejeitou depois do prazo',
});
export const stepButtonGone: LogEvent = defineLogEvent({
  name: 'conversation.button.gone',
  level: 'debug',
  message: 'botão de passo que não existe mais; descartado',
});
export const expireDropped: LogEvent = defineLogEvent({
  name: 'conversation.expire.dropped',
  level: 'warn',
  message: 'expiração de espera descartada pela fila de entrada; onExpire não roda',
});
export const waitsReadFailed: LogEvent = defineLogEvent({
  name: 'conversation.waits.read-failed',
  level: 'error',
  message: 'falha ao ler as esperas persistidas; seguem fora da memória',
});
export const waitWriteFailed: LogEvent = defineLogEvent({
  name: 'conversation.wait.write-failed',
  level: 'warn',
  message: 'falha ao gravar espera no storage',
});
export const waitOrphan: LogEvent = defineLogEvent({
  name: 'conversation.wait.orphan',
  level: 'warn',
  message: 'espera descartada: o plugin não tem o passo (desligado, removido ou passo renomeado)',
});

// Scheduler.
export const schedulerStorageFailed: LogEvent = defineLogEvent({
  name: 'scheduler.storage.failed',
  level: 'error',
  message: 'falha no storage do scheduler',
});

// Plugins.
export const pluginFailed: LogEvent = defineLogEvent({
  name: 'plugin.failed',
  level: 'error',
  message: 'plugin falhou',
});
export const pluginLifecycleFailed: LogEvent = defineLogEvent({
  name: 'plugin.lifecycle.failed',
  level: 'error',
  message: 'falha no ciclo de vida do plugin',
});
export const pluginsBooted: LogEvent = defineLogEvent({
  name: 'plugin.boot.report',
  level: 'info',
  message: 'plugins carregados',
});
export const pluginsBootedToReview: LogEvent = defineLogEvent({
  name: 'plugin.boot.review',
  level: 'warn',
  message: 'plugins carregados, com plugin ignorado ou comando de fora: revise a configuração',
});
export const pluginReloaded: LogEvent = defineLogEvent({
  name: 'plugin.reloaded',
  level: 'info',
  message: 'plugin recarregado',
});
export const pluginDisabled: LogEvent = defineLogEvent({
  name: 'plugin.disabled',
  level: 'info',
  message: 'plugin desligado',
});
export const pluginEnabled: LogEvent = defineLogEvent({
  name: 'plugin.enabled',
  level: 'info',
  message: 'plugin ligado',
});
export const pluginExactCaret: LogEvent = defineLogEvent({
  name: 'plugin.dependency.exact-range',
  level: 'warn',
  message:
    'faixa de dependência aceita só uma versão exata; para acompanhar o 0.x da dependência, ' +
    'use "0.x" ou ">=0.0.0 <1.0.0"',
});
export const pluginOptionalVersion: LogEvent = defineLogEvent({
  name: 'plugin.dependency.optional-mismatch',
  level: 'warn',
  message:
    'optionalDependsOn não aceita a versão carregada; o plugin sobe e o serviço dela segue visível',
});
export const disabledUnknown: LogEvent = defineLogEvent({
  name: 'plugin.disabled.unknown',
  level: 'warn',
  message: 'disabledPlugins cita um plugin que não existe',
});
export const adminUnknown: LogEvent = defineLogEvent({
  name: 'plugin.admin.unknown',
  level: 'warn',
  message: 'adminPlugins cita um plugin que não existe',
});

// Config de plugin (ADR 0028, 0117).
export const configUnknownPlugin: LogEvent = defineLogEvent({
  name: 'config.plugin.unknown',
  level: 'warn',
  message: 'pluginConfig cita um plugin que não existe',
});
export const configLegacySecret: LogEvent = defineLogEvent({
  name: 'config.override.secret-ignored',
  level: 'warn',
  message: 'override tem campo secreto, ignorado; defina pela env ou pelo arquivo',
});
export const configShortSecret: LogEvent = defineLogEvent({
  name: 'config.secret.too-short',
  level: 'warn',
  message: 'campo secreto curto demais para a censura do log: sai como texto comum',
});
export const configOverrideShadowed: LogEvent = defineLogEvent({
  name: 'config.override.shadowed',
  level: 'warn',
  message: 'override sem efeito: outra camada vale nesses campos',
});
export const configSecretSaved: LogEvent = defineLogEvent({
  name: 'config.secret.saved',
  level: 'info',
  message: 'segredo do plugin salvo',
});
export const configSecretRemoved: LogEvent = defineLogEvent({
  name: 'config.secret.removed',
  level: 'info',
  message: 'segredo do plugin removido',
});
export const configSecretNotMigrated: LogEvent = defineLogEvent({
  name: 'config.secret.migrate-failed',
  level: 'warn',
  message: 'segredo com a chave anterior não decifra; não migrado',
});
export const configKeyRotated: LogEvent = defineLogEvent({
  name: 'config.key.rotated',
  level: 'info',
  message: 'rotação da chave mestra concluída',
});

// HTTP.
export const httpListenFailed: LogEvent = defineLogEvent({
  name: 'http.listen.failed',
  level: 'error',
  message: 'falha ao abrir a porta HTTP',
});
export const httpServerError: LogEvent = defineLogEvent({
  name: 'http.server.error',
  level: 'error',
  message: 'erro no servidor HTTP',
});
export const httpUnhandled: LogEvent = defineLogEvent({
  name: 'http.unhandled',
  level: 'error',
  message: 'erro HTTP fora de um handler',
});
