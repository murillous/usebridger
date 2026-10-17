// Formato de exposição de texto do Prometheus (0.0.4) a partir do acumulado em memória.

import { HISTOGRAM_BUCKETS, type MetricRow } from '#types.ts';

export interface Gauge {
  readonly name: string;
  readonly help: string;
  readonly samples: readonly {
    readonly labels: Readonly<Record<string, string>>;
    readonly value: number;
  }[];
}

/** Nome Prometheus: `[a-zA-Z_:][a-zA-Z0-9_:]*`. */
export function sanitizeName(name: string): string {
  const clean = name.replace(/[^a-zA-Z0-9_:]/g, '_');
  return /^[0-9]/.test(clean) ? `_${clean}` : clean;
}

const escapeValue = (v: string): string =>
  v.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/"/g, '\\"');

function labelText(labels: Readonly<Record<string, string>>): string {
  // Nome de rótulo não aceita `:`.
  const parts = Object.entries(labels).map(
    ([k, v]) => `${sanitizeName(k).replace(/:/g, '_')}="${escapeValue(v)}"`,
  );
  return parts.length === 0 ? '' : `{${parts.join(',')}}`;
}

export function renderPrometheus(rows: readonly MetricRow[], gauges: readonly Gauge[]): string {
  const out: string[] = [];
  const typed = new Set<string>();
  const head = (name: string, type: string): void => {
    if (typed.has(name)) return;
    typed.add(name);
    out.push(`# TYPE ${name} ${type}`);
  };
  // Mesma métrica junta: o formato pede as amostras de um nome seguidas.
  const sorted = [...rows].sort((a, b) => (a.metric < b.metric ? -1 : a.metric > b.metric ? 1 : 0));
  for (const row of sorted) {
    const name = sanitizeName(row.metric);
    if (row.type === 'counter') {
      head(name, 'counter');
      out.push(`${name}${labelText(row.labels)} ${row.value}`);
      continue;
    }
    head(name, 'histogram');
    let acc = 0;
    const les = [...HISTOGRAM_BUCKETS.map(String), '+Inf'];
    row.buckets.forEach((n, i) => {
      acc += n; // no Prometheus o balde é cumulativo
      out.push(`${name}_bucket${labelText({ ...row.labels, le: les[i] ?? '+Inf' })} ${acc}`);
    });
    out.push(`${name}_sum${labelText(row.labels)} ${row.sum}`);
    out.push(`${name}_count${labelText(row.labels)} ${row.count}`);
  }
  for (const g of gauges) {
    const name = sanitizeName(g.name);
    out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
    for (const s of g.samples) out.push(`${name}${labelText(s.labels)} ${s.value}`);
  }
  return `${out.join('\n')}\n`;
}
