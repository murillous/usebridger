import { useQuery } from '@tanstack/react-query';
import { useState } from 'react';
import { ErrorNotice } from '#web/components/ui.tsx';
import { call } from '#web/lib/client.ts';

// Rotas do `plugin-metrics` (só existem com ele carregado), fora da spec do core: tipos locais.
interface MetricDescriptor {
  name: string;
  type: 'counter' | 'histogram' | 'gauge';
  help: string;
  labelNames: string[];
  owner?: string;
}

interface MetricRow {
  type: 'counter' | 'histogram' | 'gauge';
  period: string;
  value?: number;
  count?: number;
  sum?: number;
  last?: number;
  max?: number;
}

/** Número que a linha mostra: soma do contador, média do histograma, último valor do gauge. */
export function rowValue(row: MetricRow): number {
  if (row.type === 'counter') return row.value ?? 0;
  if (row.type === 'histogram') return row.count ? (row.sum ?? 0) / row.count : 0;
  return row.last ?? 0;
}

const UNIT: Record<MetricRow['type'], string> = {
  counter: 'total no período',
  histogram: 'média no período',
  gauge: 'último valor',
};

const today = () => new Date().toISOString().slice(0, 10);
const weekAgo = () => new Date(Date.now() - 6 * 86_400_000).toISOString().slice(0, 10);

/** Métricas básicas sobre o `catalog` e o `query` do `plugin-metrics`: o total por período. */
export function Metrics() {
  const catalog = useQuery({
    queryKey: ['metrics', 'catalog'],
    queryFn: () => call<{ metrics: MetricDescriptor[] }>('GET', '/plugins/metrics/catalog'),
  });
  const [name, setName] = useState<string>();
  const [from, setFrom] = useState(weekAgo);
  const [to, setTo] = useState(today);
  const selected = name ?? catalog.data?.metrics[0]?.name;
  const metric = catalog.data?.metrics.find((m) => m.name === selected);
  const rows = useQuery({
    queryKey: ['metrics', 'query', selected, from, to],
    enabled: selected !== undefined,
    queryFn: () =>
      call<{ rows: MetricRow[] }>('GET', '/plugins/metrics/query', {
        // `groupBy` vazio é o total do período, somando as séries.
        query: { name: selected, from, to, granularity: 'day', groupBy: '' },
      }),
  });
  const values = rows.data?.rows.map(rowValue) ?? [];
  const top = Math.max(...values, 0);

  return (
    <section aria-labelledby="metrics-t">
      <div className="page-head">
        <h1 id="metrics-t">Métricas</h1>
      </div>
      <ErrorNotice error={catalog.error} />
      {catalog.data && (
        <div className="filters">
          <div className="field">
            <label htmlFor="metric-name">Métrica</label>
            <select
              id="metric-name"
              className="input"
              value={selected ?? ''}
              onChange={(e) => setName(e.target.value)}
            >
              {catalog.data.metrics.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="metric-from">De</label>
            <input
              id="metric-from"
              className="input"
              type="date"
              value={from}
              onChange={(e) => setFrom(e.target.value)}
            />
          </div>
          <div className="field">
            <label htmlFor="metric-to">Até</label>
            <input
              id="metric-to"
              className="input"
              type="date"
              value={to}
              onChange={(e) => setTo(e.target.value)}
            />
          </div>
        </div>
      )}
      {metric && (
        <p className="muted">
          {metric.help} ({UNIT[metric.type]})
        </p>
      )}
      <ErrorNotice error={rows.error} />
      {rows.data && (
        <div className="card scroll">
          {rows.data.rows.length === 0 ? (
            <p className="muted">Sem dados no período.</p>
          ) : (
            <table>
              <thead>
                <tr>
                  <th>Dia</th>
                  <th>Valor</th>
                  <th>
                    <span className="sr">Proporção</span>
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.data.rows.map((row) => {
                  const value = rowValue(row);
                  return (
                    <tr key={row.period}>
                      <td className="mono">{row.period}</td>
                      <td className="mono">{Number(value.toFixed(3)).toLocaleString('pt-BR')}</td>
                      <td style={{ width: '50%' }} aria-hidden="true">
                        <div
                          className="bar"
                          style={{ width: `${top ? (value / top) * 100 : 0}%` }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      )}
    </section>
  );
}
