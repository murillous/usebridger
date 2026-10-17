/** Regra de recorrência de `scheduler.every`. */
export type RecurrenceRule =
  | { readonly everyMs: number }
  | {
      /** Horário local `HH:mm` (24 h). */
      readonly time: string;
      /** Dias da semana no fuso (0 = domingo … 6 = sábado). Ausente: todo dia. */
      readonly days?: readonly number[];
      /** Fuso IANA, ex.: `America/Sao_Paulo`. */
      readonly timeZone: string;
    };

export const MIN_EVERY_MS = 60_000;

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  // hourCycle h23 evita o "24:00" que alguns motores devolvem à meia-noite com `hour12: false`.
  return new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: 'numeric',
    day: 'numeric',
    hour: 'numeric',
    minute: 'numeric',
    second: 'numeric',
  });
}

/** Valida e devolve uma cópia canônica (só os campos conhecidos; `days` ordenado e sem repetição). */
export function normalizeRule(rule: unknown): RecurrenceRule {
  if (!isPlainObject(rule))
    throw new TypeError('A regra de recorrência deve ser um objeto simples.');
  const hasEvery = 'everyMs' in rule;
  const hasTime = 'time' in rule;
  if (hasEvery && hasTime) {
    throw new TypeError('A regra não pode ter `everyMs` e `time` ao mesmo tempo.');
  }
  if (!hasEvery && !hasTime) throw new TypeError('A regra precisa de `everyMs` ou de `time`.');

  if (hasEvery) {
    const { everyMs } = rule;
    if (typeof everyMs !== 'number' || !Number.isInteger(everyMs) || everyMs < MIN_EVERY_MS) {
      throw new TypeError(`\`everyMs\` deve ser um inteiro >= ${MIN_EVERY_MS} (1 minuto).`);
    }
    return { everyMs };
  }

  const { time, days, timeZone } = rule;
  if (typeof time !== 'string' || !TIME_PATTERN.test(time)) {
    throw new TypeError('`time` deve ser uma string `HH:mm` entre 00:00 e 23:59.');
  }
  if (typeof timeZone !== 'string' || timeZone === '') {
    throw new TypeError('`timeZone` é obrigatório e deve ser um fuso IANA.');
  }
  try {
    formatterFor(timeZone);
  } catch (error) {
    // O Intl lança RangeError; o chamador só precisa saber que o argumento é inválido.
    throw new TypeError(`\`timeZone\` inválido: "${timeZone}".`, { cause: error });
  }
  if (days === undefined) return { time, timeZone };
  if (
    !Array.isArray(days) ||
    days.length === 0 ||
    !days.every((d) => Number.isInteger(d) && d >= 0 && d <= 6)
  ) {
    throw new TypeError(
      '`days` deve ser um array não vazio de inteiros de 0 (domingo) a 6 (sábado).',
    );
  }
  return { time, days: [...new Set(days as number[])].sort((a, b) => a - b), timeZone };
}

/** Campos do relógio de parede no fuso, como ms "UTC fingido" (comparável a `Date.UTC`). */
function wallClockMs(formatter: Intl.DateTimeFormat, instant: number): number {
  const p = { year: 0, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  for (const part of formatter.formatToParts(instant)) {
    if (part.type in p) p[part.type as keyof typeof p] = Number(part.value);
  }
  return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
}

/** Offset do fuso (ms, positivo a leste de UTC) no instante, com precisão de segundos. */
function offsetAt(formatter: Intl.DateTimeFormat, instant: number): number {
  const whole = Math.floor(instant / 1000) * 1000;
  return wallClockMs(formatter, whole) - whole;
}

/**
 * Instante em que o relógio local marca `wall` (ms "UTC fingido"), ou `undefined` se não existe.
 * Ambíguo: devolve o primeiro. Pulo da primavera: usa o offset de antes do pulo, o que soma o
 * tamanho do pulo ("compatible" do Temporal).
 */
function instantForWallClock(formatter: Intl.DateTimeFormat, wall: number): number {
  const DAY = 86_400_000;
  const before = offsetAt(formatter, wall - DAY);
  const after = offsetAt(formatter, wall + DAY);
  const candidates = [wall - before, wall - after]
    .filter((t) => wallClockMs(formatter, t) === wall)
    .sort((a, b) => a - b);
  return candidates[0] ?? wall - before;
}

/**
 * Primeira ocorrência estritamente depois de `max(previous, now)`, em epoch ms.
 * - `everyMs`: as ocorrências são `previous + k * everyMs` (k >= 1); devolve a menor > now. Assim
 *   não há deriva e, depois de um downtime, os disparos perdidos são pulados.
 * - calendário: o primeiro instante > max(previous, now) cuja hora local no fuso é `time` num dia
 *   permitido.
 */
export function nextOccurrence(rule: RecurrenceRule, previous: number, now: number): number {
  if ('everyMs' in rule) {
    const missed = Math.floor((now - previous) / rule.everyMs);
    return previous + Math.max(missed + 1, 1) * rule.everyMs;
  }

  const base = Math.max(previous, now);
  const formatter = formatterFor(rule.timeZone);
  const [hours, minutes] = rule.time.split(':').map(Number) as [number, number];
  const startDay = new Date(wallClockMs(formatter, Math.floor(base / 1000) * 1000));
  // 7 dias cobrem qualquer padrão de `days`; +1 porque o primeiro dia pode já ter passado.
  for (let i = 0; i < 8; i++) {
    const day = Date.UTC(
      startDay.getUTCFullYear(),
      startDay.getUTCMonth(),
      startDay.getUTCDate() + i,
    );
    if (rule.days && !rule.days.includes(new Date(day).getUTCDay())) continue;
    const candidate = instantForWallClock(formatter, day + (hours * 60 + minutes) * 60_000);
    if (candidate > base) return candidate;
  }
  // Inalcançável com regra normalizada; falhar alto é melhor que agendar no passado.
  throw new RangeError('Não foi possível calcular a próxima ocorrência da regra.');
}
