import { type ReactNode, useState } from 'react';
import {
  byLabel,
  catalog,
  daysBetween,
  fmtCount,
  fmtInt,
  fmtMs,
  KERNEL,
  percentile,
  percentilePerDay,
  perDay,
  rowsOf,
  scrapeUrl,
  shortDay,
  total,
} from '#web/lib/metrics.ts';
import type { MetricRowView, MetricsResponse } from '#web/lib/types.ts';
import { useMetrics } from './useMetrics.ts';

const PERIODS = [7, 30, 90] as const;

/**
 * Barras por dia. Dia e valor saem no `aria-label`, no `<title>` de cada barra (dica ao passar o
 * mouse) e no eixo em texto: a cor não carrega o dado.
 */
function BarChart({
  title,
  points,
  today,
  tone = 'ink',
}: {
  title: string;
  points: { day: string; value: number; text?: string }[];
  today: string;
  tone?: 'ink' | 'agent';
}) {
  const max = Math.max(1, ...points.map((p) => p.value));
  const W = 100;
  const step = W / points.length;
  const label = `${title}: ${points.map((p) => `${p.day} ${p.text ?? fmtInt(p.value)}`).join('; ')}`;
  return (
    <div className="panel-chart">
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
              className={`bar ${tone}`}
              x={i * step + step * 0.15}
              y={46 - h}
              width={step * 0.7}
              height={Math.max(h, 0.6)}
              rx="0.6"
            >
              <title>{`${p.day}: ${p.text ?? fmtInt(p.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <div className="axis mono">
        <span>{points[0] && shortDay(points[0].day, today)}</span>
        <span>{points.at(-1) && shortDay(points.at(-1)?.day ?? today, today)}</span>
      </div>
    </div>
  );
}

/** Cartão do painel fixo: título, nome da métrica, valor de hoje e o gráfico por dia (design.md). */
function Panel({
  id,
  title,
  metric,
  value,
  children,
}: {
  id: string;
  title: string;
  metric: string;
  value: string;
  children: ReactNode;
}) {
  return (
    <section className="card panel" aria-labelledby={id}>
      <h3 id={id}>{title}</h3>
      <span className="metric mono muted">{metric}</span>
      <div className="panel-value">
        {value} <span className="muted">hoje</span>
      </div>
      {children}
    </section>
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

/** `GET /metrics` (Prometheus) do plugin-metrics; se a área de transferência falhar, mostra a URL. */
function CopyScrape() {
  const url = scrapeUrl(document.baseURI);
  const [state, setState] = useState<'idle' | 'copied' | 'manual'>('idle');
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(url);
      setState('copied');
    } catch {
      // Sem permissão ou sem contexto seguro: a URL aparece no texto para copiar à mão.
      setState('manual');
    }
  };
  return (
    <>
      <button type="button" className="link" onClick={copy}>
        {state === 'manual' ? url : 'Copiar URL do scrape'}
      </button>
      <span className="sr" aria-live="polite">
        {state === 'copied' ? 'URL copiada' : ''}
      </span>
    </>
  );
}

const Details = ({ summary, children }: { summary: string; children: ReactNode }) => (
  <details className="more">
    <summary>{summary}</summary>
    {children}
  </details>
);

function Panels({ data }: { data: Extract<MetricsResponse, { available: true }> }) {
  const days = daysBetween(data.from, data.to);
  const handled = rowsOf(data, KERNEL.handled);
  const duration = rowsOf(data, KERNEL.duration);
  const pending = rowsOf(data, KERNEL.pending);
  const users = rowsOf(data, KERNEL.users);
  const groups = rowsOf(data, KERNEL.groups);
  const all = catalog(data);
  const onToday = (rows: MetricRowView[]) => rows.filter((r) => r.day === data.to);
  const handledDays = perDay(handled, days);
  const usersDays = perDay(users, days);
  return (
    <>
      <h2 className="sect">Kernel</h2>
      <div className="panels">
        <Panel
          id="p-handled"
          title="Mensagens por dia"
          metric={KERNEL.handled}
          value={fmtInt(total(onToday(handled)))}
        >
          <BarChart title="Mensagens tratadas por dia" points={handledDays} today={data.to} />
          <Details summary="Por status (período)">
            <Breakdown rows={handled} label="status" />
          </Details>
        </Panel>

        <Panel
          id="p-active"
          title="Usuários ativos por dia"
          metric={KERNEL.users}
          value={fmtInt(total(onToday(users)))}
        >
          <BarChart title="Usuários ativos por dia" points={usersDays} today={data.to} />
          <p className="muted">
            Grupos ativos hoje: <strong>{fmtInt(total(onToday(groups)))}</strong>
          </p>
        </Panel>

        <Panel
          id="p-lat"
          title="Latência p95"
          metric={KERNEL.duration}
          value={fmtMs(percentile(onToday(duration), 0.95))}
        >
          <BarChart
            title="Latência p95 por dia, em milissegundos"
            points={percentilePerDay(duration, days, 0.95)}
            today={data.to}
            tone="agent"
          />
          <Details summary="Percentis e rotas (período)">
            <p className="muted">
              p50 {fmtMs(percentile(duration, 0.5))} · p95 {fmtMs(percentile(duration, 0.95))} · p99{' '}
              {fmtMs(percentile(duration, 0.99))}. Limite superior do balde do histograma.
            </p>
            <Breakdown rows={duration} label="route" />
          </Details>
        </Panel>

        <Panel
          id="p-queue"
          title="Fila de saída"
          metric={KERNEL.pending}
          value={`p95 ${fmtCount(percentile(onToday(pending), 0.95))}`}
        >
          <BarChart
            title="Fila de saída, p95 de itens pendentes por dia"
            points={percentilePerDay(pending, days, 0.95).map((p) => ({
              ...p,
              text: p.text.replace(' ms', ''),
            }))}
            today={data.to}
            tone="agent"
          />
          <Details summary="Percentis (período)">
            <p className="muted">
              p50 {fmtCount(percentile(pending, 0.5))} · p95 {fmtCount(percentile(pending, 0.95))} ·
              p99 {fmtCount(percentile(pending, 0.99))}. Itens pendentes no instante de cada envio;
              limite superior do balde do histograma.
            </p>
          </Details>
        </Panel>
      </div>

      <section className="card" aria-labelledby="p-all">
        <h2 id="p-all">Todas as métricas registradas</h2>
        <p className="muted">
          Qualquer counter ou histograma publicado no serviço <span className="mono">metrics</span>{' '}
          aparece aqui, sem integração própria.
        </p>
        {all.length === 0 ? (
          <p className="muted">Nenhuma métrica com dados no período.</p>
        ) : (
          <div className="scroll tbl">
            <table>
              <thead>
                <tr>
                  <th>Métrica</th>
                  <th>Plugin</th>
                  <th>Tipo</th>
                  <th>Rótulos</th>
                  <th className="num">Hoje</th>
                  <th className="num">{days.length} dias</th>
                </tr>
              </thead>
              <tbody>
                {all.map((m) => (
                  <tr key={m.name}>
                    <td className="mono">
                      {m.name}
                      <span className="muted"> · {fmtInt(m.series)} séries</span>
                    </td>
                    <td className="mono">{m.plugin ?? '-'}</td>
                    <td>
                      <span className="chip mono">{m.type}</span>
                    </td>
                    <td className="muted">{m.labels.join(', ') || '-'}</td>
                    <td className="num">
                      {m.type === 'histogram' ? `p95 ${fmtMs(m.todayP95)}` : fmtInt(m.today)}
                    </td>
                    <td className="num">
                      {m.type === 'histogram' ? `p95 ${fmtMs(m.p95)}` : fmtInt(m.total)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="list">
              {all.map((m) => (
                <div key={m.name}>
                  <div className="list-head">
                    <span className="mono">{m.name}</span>
                    <span className="chip mono">{m.type}</span>
                  </div>
                  <div className="mono muted">
                    {m.plugin ?? '-'} · {fmtInt(m.series)} séries · hoje{' '}
                    {m.type === 'histogram' ? `p95 ${fmtMs(m.todayP95)}` : fmtInt(m.today)} ·{' '}
                    {days.length}d{' '}
                    {m.type === 'histogram' ? `p95 ${fmtMs(m.p95)}` : fmtInt(m.total)}
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
        <p className="foot muted">
          <span>
            Exportado também em <span className="mono">GET /metrics</span> (Prometheus)
          </span>
          <CopyScrape />
        </p>
      </section>
    </>
  );
}

export function Metrics() {
  const [days, setDays] = useState<number>(7);
  const { data, error } = useMetrics(days);
  return (
    <>
      <p className="eyebrow muted">plugin-metrics · baldes diários, até 90 dias</p>
      <div className="row spread">
        <h1>Métricas</h1>
        <fieldset className="seg">
          <legend className="sr">Período</legend>
          {PERIODS.map((d) => (
            <button key={d} type="button" aria-pressed={d === days} onClick={() => setDays(d)}>
              {d} dias
            </button>
          ))}
        </fieldset>
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
