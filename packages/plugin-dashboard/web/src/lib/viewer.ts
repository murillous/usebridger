import { createContext, useContext } from 'react';
import { ApiProblem, api, unwrap } from './client.ts';

/** Quem usa o painel: o `GET /auth/me`, ou `open` com a auth desligada (API em loopback). */
export interface Viewer {
  readonly kind: 'user' | 'key' | 'open';
  readonly name: string;
  readonly role?: string;
  readonly permissions: readonly string[];
}

/** Sem a auth, a API não confere permissão, então o painel também não esconde nada. */
export const OPEN: Viewer = { kind: 'open', name: 'sem login', permissions: [] };

/** `undefined` = precisa entrar. Sem `api.auth` a rota `/auth/me` não existe (404). */
export async function loadViewer(): Promise<Viewer | undefined> {
  try {
    return await unwrap(api().GET('/api/auth/me'));
  } catch (error) {
    if (error instanceof ApiProblem && error.status === 401) return undefined;
    if (error instanceof ApiProblem && error.status === 404) return OPEN;
    throw error;
  }
}

/** Esconde o que a pessoa não pode usar; a API recusa de qualquer forma. */
export function can(viewer: Viewer, permission: string | undefined): boolean {
  return (
    permission === undefined || viewer.kind === 'open' || viewer.permissions.includes(permission)
  );
}

export const ViewerContext = createContext<Viewer>(OPEN);

export function useCan(): (permission: string | undefined) => boolean {
  const viewer = useContext(ViewerContext);
  return (permission) => can(viewer, permission);
}
