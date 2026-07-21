const CURRENCY_MINOR_UNITS: Readonly<Record<string, number>> = Object.freeze({
  BGN: 2,
  CHF: 2,
  CZK: 2,
  DKK: 2,
  EUR: 2,
  GBP: 2,
  HUF: 2,
  ISK: 0,
  JPY: 0,
  NOK: 2,
  PLN: 2,
  RON: 2,
  SEK: 2,
  USD: 2
});

export interface ExactDecimal {
  coefficient: bigint;
  scale: number;
}

export function parseExactDecimal(value: string, fieldName = 'amount'): ExactDecimal {
  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new Error(`${fieldName} must be a non-negative decimal without exponent notation.`);

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  let coefficient = BigInt(`${whole}${fraction}`);
  let scale = fraction.length;

  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }

  return { coefficient, scale };
}

export function addExactDecimals(left: ExactDecimal, right: ExactDecimal): ExactDecimal {
  const scale = Math.max(left.scale, right.scale);
  const leftCoefficient = left.coefficient * 10n ** BigInt(scale - left.scale);
  const rightCoefficient = right.coefficient * 10n ** BigInt(scale - right.scale);
  return normalizeExactDecimal({ coefficient: leftCoefficient + rightCoefficient, scale });
}

export function exactDecimalsEqual(left: ExactDecimal, right: ExactDecimal): boolean {
  const scale = Math.max(left.scale, right.scale);
  return left.coefficient * 10n ** BigInt(scale - left.scale) === right.coefficient * 10n ** BigInt(scale - right.scale);
}

export function formatExactDecimal(value: ExactDecimal): string {
  if (value.scale === 0) return value.coefficient.toString();
  const digits = value.coefficient.toString().padStart(value.scale + 1, '0');
  return `${digits.slice(0, -value.scale)}.${digits.slice(-value.scale)}`;
}

export function decimalToMinorUnits(value: string, currency: string): number {
  const normalizedCurrency = currency.toUpperCase();
  const minorUnits = CURRENCY_MINOR_UNITS[normalizedCurrency];
  if (minorUnits === undefined) {
    throw new Error(`Currency ${normalizedCurrency} has no configured minor-unit rule.`);
  }

  const normalized = value.trim();
  const match = /^(\d+)(?:\.(\d+))?$/.exec(normalized);
  if (!match) throw new Error('Amount must be a positive decimal without exponent notation.');

  const whole = match[1] ?? '0';
  const fraction = match[2] ?? '';
  if (fraction.length > minorUnits && /[1-9]/.test(fraction.slice(minorUnits))) {
    throw new Error(`Amount ${value} has more than ${minorUnits} minor-unit decimals for ${normalizedCurrency}.`);
  }

  const paddedFraction = fraction.slice(0, minorUnits).padEnd(minorUnits, '0');
  const minor = BigInt(whole) * 10n ** BigInt(minorUnits) + BigInt(paddedFraction || '0');
  if (minor <= 0n) throw new Error('Amount must be greater than zero.');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('Amount exceeds safe integer range.');
  return Number(minor);
}

function normalizeExactDecimal(value: ExactDecimal): ExactDecimal {
  let { coefficient, scale } = value;
  while (scale > 0 && coefficient % 10n === 0n) {
    coefficient /= 10n;
    scale -= 1;
  }
  return { coefficient, scale };
}
