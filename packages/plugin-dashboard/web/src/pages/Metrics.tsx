import { useState } from 'react';
import {
  byLabel,
  daysBetween,
  fmtInt,
  fmtMs,
  KERNEL,
  percentile,
  perDay,
  rowsOf,
  summarize,
  total,
} from '#web/lib/metrics.ts';
import type { MetricRowView, MetricsResponse } from '#web/lib/types.ts';
import { Stat } from './Stat.tsx';
import { useMetrics } from './useMetrics.ts';

const PERIODS = [7, 30] as const;

/**
 * Barras por dia. Dia e valor saem no `aria-label`, no `<title>` de cada barra (dica ao passar o
 * mouse) e no eixo em texto: a cor não carrega o dado.
 */
function BarChart({ title, points }: { title: string; points: { day: string; value: number }[] }) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const W = 100;
  const step = W / points.length;
  const label = `${title}: ${points.map((p) => `${p.day} ${fmtInt(p.value)}`).join('; ')}`;
  return (
    <>
      <svg
        className="chart"
        viewBox={`0 0 ${W} 50`}
        preserveAspectRatio="none"
        role="img"
        aria-label={label}
      >
        {points.map((p, i) => {
          const h = (p.value / max) * 40;
          return (
            <rect
              key={p.day}
              className="bar"
              x={i * step + step * 0.15}
              y={46 - h}
              width={step * 0.7}
              height={Math.max(h, 0.6)}
              rx="0.6"
            >
              <title>{`${p.day}: ${fmtInt(p.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="axis mono">
        <span>{points[0]?.day}</span>
        <span>pico {fmtInt(max === 1 && points.every((p) => p.value === 0) ? 0 : max)}/dia</span>
        <span>{points.at(-1)?.day}</span>
      </div>
    </>
  );
}

function Breakdown({ rows, label }: { rows: MetricRowView[]; label: string }) {
  const items = byLabel(rows, label);
  const sum = items.reduce((n, i) => n + i.value, 0);
  if (items.length === 0) return <p className="muted">Sem dados no período.</p>;
  return (
    <div className="scroll tbl">
      <table>
        <thead>
          <tr>
            <th>{label}</th>
            <th>Total</th>
            <th>Parte</th>
          </tr>
        </thead>
        <tbody>
          {items.map((i) => (
            <tr key={i.key}>
              <td className="mono">{i.key}</td>
              <td>{fmtInt(i.value)}</td>
              <td>{Math.round((i.value / sum) * 100)}%</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="list">
        {items.map((i) => (
          <div key={i.key}>
            <div className="mono">{i.key}</div>
            <div className="mono muted">
              {fmtInt(i.value)} · {Math.round((i.value / sum) * 100)}%
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Missing({ outdated }: { outdated: boolean }) {
  if (outdated) {
    return (
      <section className="card" aria-labelledby="falta">
        <h2 id="falta">Atualize o plugin de métricas</h2>
        <p>
          O <span className="mono">@usebridger/plugin-metrics</span> carregado é antigo e não lista
          as métricas. Atualize:{' '}
          <span className="mono">pnpm update @usebridger/plugin-metrics</span> e reinicie o bot.
        </p>
      </section>
    );
  }
  return (
    <section className="card" aria-labelledby="falta">
      <h2 id="falta">Plugin de métricas não carregado</h2>
      <p>
        Esta tela lê o serviço <span className="mono">metrics</span> do plugin oficial{' '}
        <span className="mono">@usebridger/plugin-metrics</span>. O resto do dashboard funciona sem
        ele.
      </p>
      <ol>
        <li>
          Instale: <span className="mono">pnpm add @usebridger/plugin-metrics</span>
        </li>
        <li>
          Coloque <span className="mono">metrics</span> em <span className="mono">plugins</span> no{' '}
          <span className="mono">createBot</span> e reinicie o bot.
        </li>
      </ol>
    </section>
  );
}

function Panels({ data }: { data: Extract<MetricsResponse, { available: true }> }) {
  const days = daysBetween(data.from, data.to);
  const handled = rowsOf(data, KERNEL.handled);
  const duration = rowsOf(data, KERNEL.duration);
  const sent = rowsOf(data, KERNEL.sent);
  const users = rowsOf(data, KERNEL.users);
  const groups = rowsOf(data, KERNEL.groups);
  const all = summarize(data);
  return (
    <>
      <div className="kpis">
        <Stat label="Mensagens tratadas" value={fmtInt(total(handled))} />
        <Stat label="Latência p95" value={fmtMs(percentile(duration, 0.95))} />
        <Stat label="Mensagens enviadas" value={fmtInt(total(sent))} />
        <Stat label="Usuários ativos (soma dos dias)" value={fmtInt(total(users))} />
      </div>

      <div className="panels">
        <section className="card" aria-labelledby="p-handled">
          <h2 id="p-handled">Mensagens por dia</h2>
          <BarChart title="Mensagens tratadas por dia" points={perDay(handled, days)} />
          <Breakdown rows={handled} label="status" />
        </section>

        <section className="card" aria-labelledby="p-lat">
          <h2 id="p-lat">Latência do handler</h2>
          <div className="kpis small">
            <Stat label="p50" value={fmtMs(percentile(duration, 0.5))} />
            <Stat label="p95" value={fmtMs(percentile(duration, 0.95))} />
            <Stat label="p99" value={fmtMs(percentile(duration, 0.99))} />
          </div>
          <p className="muted">Limite superior do balde do histograma, em milissegundos.</p>
          <Breakdown rows={duration} label="route" />
        </section>

        <section className="card" aria-labelledby="p-sent">
          <h2 id="p-sent">Envios</h2>
          <BarChart title="Mensagens enviadas por dia" points={perDay(sent, days)} />
          <Breakdown rows={sent} label="status" />
        </section>

        <section className="card" aria-labelledby="p-active">
          <h2 id="p-active">Ativos</h2>
          <BarChart title="Usuários ativos por dia" points={perDay(users, days)} />
          <p>
            Grupos ativos no período (soma dos dias): <strong>{fmtInt(total(groups))}</strong>
          </p>
        </section>
      </div>

      <section className="card" aria-labelledby="p-all">
        <h2 id="p-all">Todas as métricas registradas</h2>
        {all.length === 0 ? (
          <p className="muted">Nenhuma métrica com dados no período.</p>
        ) : (
          <div className="scroll tbl">
            <table>
              <thead>
                <tr>
                  <th>Métrica</th>
                  <th>Tipo</th>
                  <th>Séries</th>
                  <th>Total</th>
                  <th>p95</th>
                </tr>
              </thead>
              <tbody>
                {all.map((m) => (
                  <tr key={m.name}>
                    <td className="mono">{m.name}</td>
                    <td>
                      <span className="chip info">
                        {m.type === 'counter' ? 'Contador' : 'Histograma'}
                      </span>
                    </td>
                    <td>{fmtInt(m.series)}</td>
                    <td>{fmtInt(m.total)}</td>
                    <td>{m.type === 'histogram' ? fmtMs(m.p95) : '-'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="list">
              {all.map((m) => (
                <div key={m.name}>
                  <div className="mono">{m.name}</div>
                  <div className="mono muted">
                    {m.type === 'counter' ? 'Contador' : 'Histograma'} · {fmtInt(m.series)} séries ·{' '}
                    {fmtInt(m.total)}
                    {m.type === 'histogram' ? ` · p95 ${fmtMs(m.p95)}` : ''}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </section>
    </>
  );
}

export function Metrics() {
  const [days, setDays] = useState<number>(7);
  const { data, error } = useMetrics(days);
  return (
    <>
      <div className="row spread">
        <h1>Métricas</h1>
        <div className="field">
          <label htmlFor="period">Período</label>
          <select
            id="period"
            className="input"
            value={days}
            onChange={(e) => setDays(Number(e.target.value))}
          >
            {PERIODS.map((d) => (
              <option key={d} value={d}>
                Últimos {d} dias
              </option>
            ))}
          </select>
        </div>
      </div>
      {error ? (
        <p className="notice danger" role="alert">
          Não foi possível ler as métricas.
        </p>
      ) : !data ? (
        <p className="muted">Carregando…</p>
      ) : data.available ? (
        <Panels data={data} />
      ) : (
        <Missing outdated={data.reason === 'version'} />
      )}
    </>
  );
}
