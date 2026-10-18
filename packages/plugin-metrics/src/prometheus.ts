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

export function renderPrometheus(
  rows: readonly MetricRow[],
  gauges: readonly Gauge[],
  // Destino da série descartada quando o nome saneado colide com outro de tipo diferente.
  onSkip: (name: string) => void = () => undefined,
): string {
  const out: string[] = [];
  // Agrupa pelo nome saneado: nomes que colidem ficam contíguos, com um único `# TYPE`.
  const families = new Map<string, MetricRow[]>();
  for (const row of rows) {
    const name = sanitizeName(row.metric);
    const family = families.get(name);
    if (!family) families.set(name, [row]);
    else if (family[0]?.type === row.type) family.push(row);
    else onSkip(row.metric); // a primeira família registrada vence
  }
  for (const [name, family] of [...families].sort(([x], [y]) => (x < y ? -1 : x > y ? 1 : 0))) {
    out.push(`# TYPE ${name} ${family[0]?.type}`);
    for (const row of family) {
      if (row.type === 'gauge') {
        out.push(`${name}${labelText(row.labels)} ${row.last}`);
        continue;
      }
      if (row.type === 'counter') {
        out.push(`${name}${labelText(row.labels)} ${row.value}`);
        continue;
      }
      // `le` do usuário colidiria com o dos baldes: renomeia como o Prometheus (`exported_`).
      const { le, ...rest } = row.labels;
      const base = le === undefined ? rest : { ...rest, exported_le: le };
      let acc = 0;
      const les = [...HISTOGRAM_BUCKETS.map(String), '+Inf'];
      row.buckets.forEach((n, i) => {
        acc += n; // no Prometheus o balde é cumulativo
        out.push(`${name}_bucket${labelText({ ...base, le: les[i] ?? '+Inf' })} ${acc}`);
      });
      out.push(`${name}_sum${labelText(base)} ${row.sum}`);
      out.push(`${name}_count${labelText(base)} ${row.count}`);
    }
  }
  for (const g of gauges) {
    const name = sanitizeName(g.name);
    out.push(`# HELP ${name} ${g.help}`, `# TYPE ${name} gauge`);
    for (const s of g.samples) out.push(`${name}${labelText(s.labels)} ${s.value}`);
  }
  return `${out.join('\n')}\n`;
}
