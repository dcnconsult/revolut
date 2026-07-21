import 'dotenv/config';
import { z } from 'zod';

const EnvSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(3000),
  LOG_LEVEL: z.string().default('info'),
  REVOLUT_MODE: z.enum(['mock', 'sandbox', 'production']).default('mock'),
  REVOLUT_BASE_URL: z.string().url().default('https://sandbox-b2b.revolut.com/api/1.0'),
  REVOLUT_CLIENT_ID: z.string().optional(),
  REVOLUT_ISSUER: z.string().url().optional(),
  REVOLUT_PRIVATE_KEY_PATH: z.string().optional(),
  REVOLUT_REFRESH_TOKEN: z.string().optional(),
  REVOLUT_WEBHOOK_SIGNING_SECRET: z.string().optional(),
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
  allowedCurrencies: new Set(parsed.PAYMENT_ALLOWED_CURRENCIES.split(',').map(value => value.trim().toUpperCase()).filter(Boolean))
};
