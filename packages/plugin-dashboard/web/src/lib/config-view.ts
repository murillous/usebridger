import { envName, type Field, type FlatValues } from './schema.ts';
import type { PluginRow } from './types.ts';

/** Badge da lista de plugins: "falhou" (setup) vence a contagem de erros da config. */
export function badgeOf(
  row: PluginRow | undefined,
  issues: number | undefined,
): string | undefined {
  if (row?.reason?.kind === 'setup-failed') return 'falhou';
  return issues ? `${issues} ${issues === 1 ? 'erro' : 'erros'}` : undefined;
}

/**
 * Origem do secret só leitura. `known` falso = `view: null` (config inválida): sem `sources`
 * não dá para saber a origem. Secret opcional sem valor, em config válida, também vem sem
 * source: aí é "sem valor", não "inválida".
 */
export function secretOrigin(opts: {
  known: boolean;
  source: string | undefined;
  plugin: string | undefined;
  path: string;
  hasValue: boolean;
}): string {
  if (!opts.known) return 'Origem desconhecida: a config atual é inválida.';
  if (opts.source === 'env' && opts.plugin) {
    return `Definida por ${envName(opts.plugin, opts.path)}.`;
  }
  if (opts.source === 'file') return 'Definida no arquivo de config.';
  return opts.hasValue ? 'Valor padrão do plugin.' : 'Sem valor definido.';
}

/**
 * Validação local mínima, só com o que o JSON Schema deixa ver (obrigatório, enum, limites):
 * mostra o erro sem esperar o 400. O servidor segue sendo a autoridade (refinamentos do Zod).
 */
export function validateLocal(fields: Field[], values: FlatValues): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const f of fields) {
    if (f.secret) continue;
    const v = values[f.path];
    const empty = v === undefined || v === null || v === '';
    let msg: string | undefined;
    if (empty) {
      if (f.required && f.default === undefined && f.control !== 'boolean') msg = 'Obrigatório';
    } else if (f.control === 'number' || f.control === 'integer') {
      if (typeof v !== 'number' || Number.isNaN(v)) msg = 'Informe um número';
      else if (f.control === 'integer' && !Number.isInteger(v)) msg = 'Informe um inteiro';
      else if (f.min !== undefined && v < f.min) msg = `Deve ser maior ou igual a ${f.min}`;
      else if (f.max !== undefined && v > f.max) msg = `Deve ser menor ou igual a ${f.max}`;
    } else if (f.control === 'text' && typeof v === 'string') {
      if (f.min !== undefined && v.length < f.min) msg = `Mínimo de ${f.min} caracteres`;
      else if (f.max !== undefined && v.length > f.max) msg = `Máximo de ${f.max} caracteres`;
    } else if (f.control === 'enum' && !f.options?.includes(String(v))) {
      msg = 'Valor fora das opções';
    }
    if (msg) out[f.path] = [msg];
  }
  return out;
}
