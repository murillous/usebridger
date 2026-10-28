/** Aviso de erro de uma leitura ou ação; nada quando não há erro. */
export function ErrorNotice({ error }: { error: unknown }) {
  if (error === null || error === undefined) return null;
  return (
    <p className="notice danger" role="alert">
      {error instanceof Error ? error.message : String(error)}
    </p>
  );
}

/** Data e hora local de um ISO ou epoch ms; vazio vira traço. */
export function when(value: string | number | null | undefined): string {
  if (value === null || value === undefined || value === '') return '—';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? String(value) : date.toLocaleString('pt-BR');
}
