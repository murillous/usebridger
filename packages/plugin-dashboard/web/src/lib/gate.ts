import { ApiError } from './api.ts';

/** Mensagem do campo de token para cada falha do login. */
export function loginMessage(error: unknown): string {
  if (!(error instanceof ApiError))
    return 'Sem conexão com o servidor. Verifique a rede e tente de novo.';
  if (error.status === 401) return 'Token inválido.';
  if (error.status === 413) return 'Token grande demais.';
  return `Não foi possível entrar (erro ${error.status}).`;
}
