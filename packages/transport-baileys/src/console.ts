// O libsignal, que o Baileys usa para a criptografia, escreve direto no `console`
// (`Closing session: SessionEntry {...}`), sem logger para configurar. Enquanto um socket está
// aberto, as chamadas cujo chamador direto é um arquivo do libsignal vão para o logger do
// Baileys, com o mesmo piso de nível; o resto do `console` passa intacto (ADR 0091).

import type { ILogger } from './logger.ts';

const METHODS = ['log', 'info', 'warn', 'error', 'debug'] as const;
type Method = (typeof METHODS)[number];

/** Arquivo do pacote `libsignal` (no pnpm: `.pnpm/libsignal@x/node_modules/libsignal/src/...`). */
const LIBSIGNAL_FRAME = /[\\/]node_modules[\\/]libsignal[\\/]/;

// Um desvio por processo, não por transport: o `console` é global. Com várias sessões, as linhas
// vão para o logger do socket aberto mais recente, porque o libsignal não diz de qual sessão é.
const active: ILogger[] = [];
type ConsoleFn = (...args: unknown[]) => void;
const installed = new Map<Method, { readonly original: ConsoleFn; readonly wrapper: ConsoleFn }>();

/** Liga o desvio para `logger`; devolve a função que o desliga (idempotente). */
export function routeLibsignalConsole(logger: ILogger): () => void {
  if (active.length === 0) install();
  active.push(logger);
  let released = false;
  return () => {
    if (released) return;
    released = true;
    active.splice(active.indexOf(logger), 1);
    if (active.length === 0) uninstall();
  };
}

function install(): void {
  for (const method of METHODS) {
    const original: ConsoleFn = console[method];
    const wrapper: ConsoleFn = (...args) => {
      const target = active.at(-1);
      if (target === undefined || !calledFromLibsignal(wrapper)) {
        original.apply(console, args);
        return;
      }
      write(target, method, args);
    };
    installed.set(method, { original, wrapper });
    console[method] = wrapper;
  }
}

function uninstall(): void {
  for (const [method, { original, wrapper }] of installed) {
    // Quem trocou o método depois de nós fica com a troca dele; o nosso wrapper, que ficou na
    // cadeia dele, sem desvio ativo só repassa ao original.
    if (console[method] === wrapper) console[method] = original;
  }
  installed.clear();
}

/** O chamador direto de `wrapper` é um arquivo do libsignal. */
function calledFromLibsignal(wrapper: ConsoleFn): boolean {
  // Só o primeiro quadro abaixo do `wrapper`: um callback do app chamado de dentro do libsignal
  // continua no `console` dele.
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 1;
  const holder: { stack?: string } = {};
  Error.captureStackTrace(holder, wrapper);
  Error.stackTraceLimit = limit;
  return LIBSIGNAL_FRAME.test(holder.stack ?? '');
}

function write(logger: ILogger, method: Method, args: readonly unknown[]): void {
  // Só o texto: os objetos (`SessionEntry`, registros de sessão) carregam as chaves da sessão
  // e não podem ir para o log.
  const text = args.filter((arg): arg is string => typeof arg === 'string').join(' ');
  const fields = { source: 'libsignal' };
  // `console.error` do libsignal é falha de migração de sessão: vale um aviso. O resto é a
  // rotina de abrir e fechar sessões.
  if (method === 'error') logger.warn(fields, text);
  else logger.debug(fields, text);
}
