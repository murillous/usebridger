// `bridger owner-invite <módulo> --email <e-mail> [--name <nome>] [--session <sessão>]`: recuperação
// quando não sobra owner ativo (ADR 0127). Abre o storage do app e imprime um convite de owner de uma
// vez só; quem o aceita (`POST /api/auth/invites/accept`) define a senha. Recusa se há owner ativo.

import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { ApiError } from '#api/problem.ts';
import { createAccounts } from '#auth/accounts.ts';
import { DEFAULT_MAX_AGE_MS } from '#auth/actor.ts';
import { createAuthStore } from '#auth/store.ts';
import { DEFAULT_SESSION, kernelStorage, sessionStorage } from '#storage/namespace.ts';
import type { StoragePort } from '#storage/types.ts';
import type { CliIo } from './openapi.ts';

export const USAGE = `Uso: bridger owner-invite <módulo> --email <e-mail> [--name <nome>] [--session <sessão>]

Gera um convite de owner quando o bot não tem nenhum owner ativo (primeiro acesso perdido, dono
desativado). O módulo é um arquivo do app (.ts, .mjs, .js) com \`export const storage\` (o mesmo
storage do bot) e, se o bot não usa a sessão default, \`export const session\`. Sem o e-mail em uso,
--name é obrigatório.
O módulo deve só exportar \`storage\` (e \`session\`), sem efeito colateral: nada de \`createBot().start()\`,
que abriria transport e a trava da sessão. Use um arquivo à parte (ex.: \`storage.ts\`) que o app importa.
A CLI não pega a trava da sessão: só grava documentos de auth e pode rodar com o bot de pé. Imprime o token do convite uma única vez; vale 48 h.`;

export interface Loaded {
  readonly storage: StoragePort;
  readonly session?: string;
}

export type LoadStorage = (file: string) => Promise<Loaded>;

async function importModule(file: string): Promise<Loaded> {
  const mod = (await import(pathToFileURL(resolve(file)).href)) as {
    storage?: StoragePort;
    session?: string;
  };
  if (mod.storage === undefined) throw new Error(`${file} precisa exportar \`storage\``);
  return { storage: mod.storage, ...(mod.session !== undefined && { session: mod.session }) };
}

/** Roda o comando e devolve o código de saída. */
export async function run(
  argv: readonly string[],
  io: CliIo,
  load: LoadStorage = importModule,
): Promise<number> {
  let parsed: ReturnType<typeof parse>;
  try {
    parsed = parse(argv);
  } catch (error) {
    io.err(`${(error as Error).message}\n\n${USAGE}`);
    return 1;
  }
  const { values, positionals } = parsed;
  if (values.help) {
    io.out(USAGE);
    return 0;
  }
  const [file] = positionals;
  if (file === undefined || positionals.length > 1 || values.email === undefined) {
    io.err(USAGE);
    return 1;
  }
  let storage: StoragePort | undefined;
  try {
    const loaded = await load(file);
    storage = loaded.storage;
    const scoped = kernelStorage(
      sessionStorage(storage, values.session ?? loaded.session ?? DEFAULT_SESSION),
      'auth',
    );
    const accounts = createAccounts({
      storage: scoped,
      store: createAuthStore(scoped),
      sessionMaxAgeMs: DEFAULT_MAX_AGE_MS,
    });
    const invite = await accounts.recoverOwner({ email: values.email, name: values.name });
    io.out(
      `Convite de owner para ${values.email} (vale até ${invite.expiresAt}):\n${invite.token}`,
    );
    return 0;
  } catch (error) {
    // Regra de negócio (já há owner, falta --name) é erro de uso; o resto é falha de verdade.
    io.err(`bridger owner-invite: ${(error as Error).message}`);
    return error instanceof ApiError ? 1 : 2;
  } finally {
    await storage?.close();
  }
}

function parse(argv: readonly string[]) {
  return parseArgs({
    args: [...argv],
    allowPositionals: true,
    options: {
      help: { type: 'boolean', short: 'h' },
      email: { type: 'string' },
      name: { type: 'string' },
      session: { type: 'string' },
    },
  });
}
