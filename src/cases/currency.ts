/**
 * Currency precision is a controlled policy input, never a package- or
 * browser-supplied value. Keep this small reviewed registry aligned with the
 * currencies enabled in CASE_SANDBOX_MAXIMUMS_JSON.
 */
const sandboxCurrencyExponents = {
  USD: 2,
  EUR: 2,
  GBP: 2,
  CHF: 2,
  JPY: 0,
  BHD: 3,
  KWD: 3,
  OMR: 3,
  TND: 3
} as const;

export function canonicalCurrencyExponent(currency: string) {
  return sandboxCurrencyExponents[currency as keyof typeof sandboxCurrencyExponents];
}

export function requireCanonicalCurrencyExponent(currency: string, exponent: number) {
  const expected = canonicalCurrencyExponent(currency);
  if (expected === undefined) {
    throw new Error(`Currency ${currency} is not enabled for the Sandbox case workflow.`);
  }
  if (exponent !== expected) {
    throw new Error(`Currency ${currency} must use its canonical ${expected}-decimal exponent.`);
  }
  return expected;
}

export const reviewedSandboxCurrencyExponents: Readonly<Record<string, number>> = sandboxCurrencyExponents;
