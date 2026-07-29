import 'dotenv/config';
import { z } from 'zod';
import { canonicalCurrencyExponent } from '../cases/currency.js';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  APP_HOST: z.string().min(1).default('0.0.0.0'),
  APP_TRANSPORT: z.enum(['http', 'https', 'mtls']).default('http'),
  APP_TRUST_PROXY: z.string().default(''),
  APP_TLS_CERT_PATH: z.string().optional(),
  APP_TLS_KEY_PATH: z.string().optional(),
  APP_TLS_CLIENT_CA_PATH: z.string().optional(),
  APP_TLS_KEY_PASSPHRASE_PATH: z.string().optional(),
  LOG_LEVEL: z.string().default('info'),
  REVOLUT_MODE: z.enum(['mock', 'sandbox', 'production']).default('mock'),
  REVOLUT_BASE_URL: z.string().url().default('https://sandbox-b2b.revolut.com/api/1.0'),
  REVOLUT_CLIENT_ID: z.string().optional(),
  REVOLUT_ISSUER: z.string().optional(),
  REVOLUT_PRIVATE_KEY_PATH: z.string().optional(),
  REVOLUT_REFRESH_TOKEN: z.string().optional(),
  REVOLUT_WEBHOOK_SIGNING_SECRET: z.string().optional(),
  REVOLUT_SANDBOX_CONFIG_PATH: z.string().default('/run/secrets/revolut-sandbox-config'),
  REVOLUT_SANDBOX_TOKENS_PATH: z.string().default('/run/secrets/revolut-sandbox-tokens'),
  REVOLUT_SANDBOX_PRIVATE_KEY_PATH: z.string().default('/run/secrets/revolut-sandbox-private-key'),
  OPERATOR_AUTH_CONFIG_PATH: z.string().default('/run/secrets/operator-auth-config'),
  OPERATOR_COOKIE_SECURE: z.string().transform(value => value === 'true').default('false'),
  RELEASE_SHA: z.string().default('local'),
  SANDBOX_BACKUP_STATUS_PATH: z.string().default('/var/backups/revolut'),
  SANDBOX_INTERNAL_TRANSFER_MAX_MINOR: z.coerce.number().int().positive().max(10_000).default(1_000),
  SANDBOX_DATABASE_PATH: z.string().default('/var/lib/revolut/sandbox-transfers.sqlite'),
  BROKERED_FUNDING_ENABLED: z.string().transform(value => value === 'true').default('true'),
  CASE_EVIDENCE_ROOT: z.string().default('/var/lib/revolut/evidence'),
  CASE_EVIDENCE_KEY_BASE64: z.string().default(''),
  CASE_EVIDENCE_SIGNING_KEY_PEM: z.string().default(''),
  CASE_TRUSTED_SOURCE_KEYS_JSON: z.string().default('{}'),
  CASE_ZIP_MAX_BYTES: z.coerce.number().int().positive().default(25 * 1024 * 1024),
  CASE_ZIP_MAX_ENTRIES: z.coerce.number().int().positive().default(100),
  CASE_ZIP_MAX_ENTRY_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),
  CASE_ZIP_MAX_TOTAL_BYTES: z.coerce.number().int().positive().default(100 * 1024 * 1024),
  CASE_ZIP_MAX_COMPRESSION_RATIO: z.coerce.number().positive().default(20),
  CASE_SANDBOX_MAXIMUMS_JSON: z.string().default('{"USD":100000000000}'),
  CLAMAV_HOST: z.string().default('clamav'),
  CLAMAV_PORT: z.coerce.number().int().positive().max(65535).default(3310),
  PAYMENT_MAX_AMOUNT_MINOR: z.coerce.number().int().positive().default(100_000_000),
  PAYMENT_ALLOWED_CURRENCIES: z.string().default('EUR,GBP,CHF,USD'),
  PAYMENT_REQUIRE_NAME_MATCH: z.string().transform(value => value === 'true').default('true'),
  ISO20022_MAX_FILE_BYTES: z.coerce.number().int().positive().default(2_000_000),
  ISO20022_MAX_TRANSACTIONS: z.coerce.number().int().positive().max(10_000).default(100),
  ISO20022_MAX_XML_ELEMENTS: z.coerce.number().int().positive().default(20_000),
  ISO20022_MAX_XML_DEPTH: z.coerce.number().int().positive().max(512).default(64),
  ISO20022_STRUCTURED_ADDRESS_CUTOFF: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).default('2026-11-15')
});

const parsed = EnvSchema.parse(process.env);
export const env = {
  ...parsed,
  allowedCurrencies: new Set(parsed.PAYMENT_ALLOWED_CURRENCIES.split(',').map(value => value.trim().toUpperCase()).filter(Boolean)),
  trustedSourceKeys: parseTrustedKeys(parsed.CASE_TRUSTED_SOURCE_KEYS_JSON),
  caseSandboxMaximumMinorByCurrency: parseCaseSandboxMaximums(parsed.CASE_SANDBOX_MAXIMUMS_JSON)
};

function parseTrustedKeys(value: string) {
  const parsedValue = JSON.parse(value) as unknown;
  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue) ||
      Object.values(parsedValue).some(key => typeof key !== 'string')) {
    throw new Error('CASE_TRUSTED_SOURCE_KEYS_JSON must be a JSON object of key IDs to PEM public keys.');
  }
  return parsedValue as Record<string, string>;
}

function parseCaseSandboxMaximums(value: string) {
  let parsedValue: unknown;
  try {
    parsedValue = JSON.parse(value) as unknown;
  } catch {
    throw new Error('CASE_SANDBOX_MAXIMUMS_JSON must be a JSON object of currency codes to positive safe minor-unit limits.');
  }
  if (!parsedValue || typeof parsedValue !== 'object' || Array.isArray(parsedValue)) {
    throw new Error('CASE_SANDBOX_MAXIMUMS_JSON must be a JSON object of currency codes to positive safe minor-unit limits.');
  }
  const entries = Object.entries(parsedValue);
  if (entries.length === 0 || entries.some(([currency, maximum]) =>
    !/^[A-Z]{3}$/.test(currency) || canonicalCurrencyExponent(currency) === undefined ||
    !Number.isSafeInteger(maximum) || Number(maximum) < 1
  )) {
    throw new Error('CASE_SANDBOX_MAXIMUMS_JSON must use reviewed uppercase ISO currency codes and positive safe minor-unit limits.');
  }
  return Object.freeze(Object.fromEntries(entries) as Record<string, number>);
}
