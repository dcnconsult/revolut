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
  PAYMENT_REQUIRE_NAME_MATCH: z.string().transform(v => v === 'true').default('true')
});

const parsed = EnvSchema.parse(process.env);
export const env = {
  ...parsed,
  allowedCurrencies: new Set(parsed.PAYMENT_ALLOWED_CURRENCIES.split(',').map(v => v.trim()))
};
