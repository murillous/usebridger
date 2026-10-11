// Runner do benchmark: `pnpm bench [--only overhead,boot] [--out resultado.json]
// [--baseline <checkout da base>]`. Cada execução de cenário roda num processo novo
// (`--scenario <nome>`), que imprime a medida em JSON.

import { execFile } from 'node:child_process';
import { access, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs, promisify } from 'node:util';
import { type Comparison, compare, type Measured, TOLERANCE } from './baseline.ts';
import { evaluate, SCENARIOS, type Scenario } from './scenarios.ts';

const run = promisify(execFile);
// Antes do `await` de topo abaixo, que já usa a constante.
const SELF = fileURLToPath(import.meta.url);

/** Resultado de um cenário, como vai para o `--out`. */
export interface ScenarioResult {
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly target: Scenario['target'];
  readonly runs: readonly number[];
  readonly value: number;
  readonly ok: boolean;
}

const { values: args } = parseArgs({
  options: {
    only: { type: 'string' },
    baseline: { type: 'string' },
    out: { type: 'string' },
    scenario: { type: 'string' },
  },
});

if (args.scenario === undefined) {
  process.exitCode = await runAll(args.only?.split(','), args.out, args.baseline);
} else {
  const scenario = find(args.scenario);
  process.stdout.write(`${JSON.stringify(await scenario.run())}\n`);
}

async function runAll(
  only: readonly string[] | undefined,
  out: string | undefined,
  baselineDir: string | undefined,
) {
  // Conferido antes de medir: um caminho errado falha em segundos, não depois de minutos.
  const baseScript = baselineDir === undefined ? undefined : await findBaseScript(baselineDir);
  const selected = only === undefined ? SCENARIOS : only.map(find);
  const results: ScenarioResult[] = [];
  const baseline: Measured[] = [];
  for (const scenario of selected) {
    // A base só roda onde há comparação: no `memory-growth`, ela custaria minutos sem uso.
    const base = scenario.checksRegression ? baseScript : undefined;
    const { runs, baseRuns } = await measure(scenario, base);
    const result = { ...describe(scenario), runs, ...evaluate(scenario, runs) };
    results.push(result);
    if (baseRuns !== undefined) baseline.push({ name: scenario.name, runs: baseRuns });
    process.stdout.write(`${format(result)}\n`);
  }
  if (out !== undefined) {
    const report = { node: process.version, platform: process.platform, arch: process.arch };
    await writeFile(out, `${JSON.stringify({ ...report, results }, null, 2)}\n`);
  }
  let exitCode = 0;
  const failed = results.filter((result) => !result.ok);
  if (failed.length > 0) {
    process.stderr.write(`Fora da meta: ${failed.map((result) => result.name).join(', ')}\n`);
    exitCode = 1;
  }
  if (baseScript !== undefined) {
    const comparisons = compare(SCENARIOS, results, baseline);
    process.stdout.write(
      `\nComparação com o baseline, pelo quartil bom (tolerância ${TOLERANCE * 100}%):\n`,
    );
    for (const comparison of comparisons) {
      const baseRuns = baseline.find((measured) => measured.name === comparison.name)?.runs;
      process.stdout.write(`${formatComparison(comparison, baseRuns)}\n`);
    }
    const regressed = comparisons.filter((comparison) => comparison.regressed);
    if (regressed.length > 0) {
      const names = regressed.map((comparison) => comparison.name).join(', ');
      process.stderr.write(`Regressão > ${TOLERANCE * 100}%: ${names}\n`);
      exitCode = 1;
    }
  }
  return exitCode;
}

async function findBaseScript(dir: string): Promise<string> {
  const script = resolve(dir, join('bench', 'dist', 'main.mjs'));
  try {
    await access(script);
  } catch (error) {
    throw new Error(`baseline sem o build do bench em ${script} (rode pnpm build na base)`, {
      cause: error,
    });
  }
  return script;
}

/**
 * As execuções do commit testado e, com `baseScript`, as da base, intercaladas: base e testado
 * se revezam, e a ordem dentro do par inverte a cada rodada (B T, T B, B T...). Uma mudança na
 * máquina durante o benchmark pesa igual nos dois lados, em vez de cair inteira num deles.
 * `baseRuns` fica `undefined` quando a base não tem o cenário.
 */
async function measure(scenario: Scenario, baseScript: string | undefined) {
  const runs: number[] = [];
  const baseRuns: number[] = [];
  let baseKnows = baseScript !== undefined;
  for (let i = 0; i < scenario.runs; i++) {
    const order = i % 2 === 0 ? (['base', 'head'] as const) : (['head', 'base'] as const);
    for (const side of order) {
      if (side === 'head') {
        runs.push(await runChild(SELF, scenario.name));
      } else if (baseScript !== undefined && baseKnows) {
        const value = await runBaseChild(baseScript, scenario.name);
        if (value === undefined) baseKnows = false;
        else baseRuns.push(value);
      }
    }
  }
  return { runs, baseRuns: baseKnows ? baseRuns : undefined };
}

/** Execução na base; `undefined` se a base não conhece o cenário (cenário novo no PR). */
async function runBaseChild(script: string, name: string): Promise<number | undefined> {
  try {
    return await runChild(script, name);
  } catch (error) {
    // O runner da base lança `cenário desconhecido` (`find`) e sai com erro; o resto é falha.
    const stderr = (error as { stderr?: unknown }).stderr;
    if (typeof stderr === 'string' && stderr.includes('cenário desconhecido')) return undefined;
    throw error;
  }
}

async function runChild(script: string, name: string): Promise<number> {
  // `execArgv` repassa as flags do Node com que o runner foi chamado.
  const { stdout } = await run(process.execPath, [...process.execArgv, script, '--scenario', name]);
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new Error(`cenário ${name} devolveu uma medida inválida: ${stdout.trim()}`);
  }
  return value;
}

function find(name: string): Scenario {
  const scenario = SCENARIOS.find((candidate) => candidate.name === name);
  if (scenario === undefined) {
    const names = SCENARIOS.map((candidate) => candidate.name).join(', ');
    throw new Error(`cenário desconhecido: ${name} (existem: ${names})`);
  }
  return scenario;
}

function describe({ name, description, unit, target }: Scenario) {
  return { name, description, unit, target };
}

function format(result: ScenarioResult): string {
  const meta = 'max' in result.target ? `< ${result.target.max}` : `≥ ${result.target.min}`;
  const runs = result.runs.map((value) => round(value)).join(', ');
  const status = result.ok ? 'ok' : 'FORA DA META';
  return `${result.name.padEnd(14)} ${round(result.value)} ${result.unit} (meta ${meta}; execuções: ${runs}) ${status}`;
}

function formatComparison(comparison: Comparison, baseRuns: readonly number[] | undefined): string {
  const name = comparison.name.padEnd(14);
  if (!find(comparison.name).checksRegression) {
    return `${name} ${round(comparison.value)} (vale só a meta)`;
  }
  if (comparison.baseline === undefined || comparison.change === undefined) {
    return `${name} ${round(comparison.value)} (sem baseline)`;
  }
  const values = `${round(comparison.baseline)} → ${round(comparison.value)}`;
  const sign = comparison.change > 0 ? '+' : '';
  const direction = comparison.change > 0 ? 'pior' : 'melhor';
  const change = `${sign}${(comparison.change * 100).toFixed(1)}% ${direction}`;
  const base = `base: ${(baseRuns ?? []).map((value) => round(value)).join(', ')}`;
  return `${name} ${values} (${change}; ${base}) ${comparison.regressed ? 'REGREDIU' : 'ok'}`;
}

function round(value: number): string {
  return value >= 100 ? value.toFixed(0) : value.toPrecision(3);
}
