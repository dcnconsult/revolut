import { z } from 'zod';

export const CurrencySchema = z.string().regex(/^[A-Z]{3}$/);

export const BeneficiarySchema = z.object({
  legalName: z.string().min(2).max(140),
  accountType: z.enum(['business', 'personal']).default('business'),
  country: z.string().regex(/^[A-Z]{2}$/),
  currency: CurrencySchema,
  iban: z.preprocess(value => typeof value === 'string' ? value.replace(/\s/g, '') : value, z.string().regex(/^[A-Z]{2}[0-9A-Z]{13,32}$/)).optional(),
  bic: z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/).optional(),
  accountNumber: z.string().min(4).max(34).optional(),
  sortCode: z.string().regex(/^\d{6}$/).optional(),
  address: z.object({
    line1: z.string().min(2),
    city: z.string().min(1),
    region: z.string().optional(),
    postalCode: z.string().optional(),
    country: z.string().regex(/^[A-Z]{2}$/)
  }).optional()
}).superRefine((value, ctx) => {
  if (!value.iban && !(value.accountNumber && value.sortCode)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Provide an IBAN or accountNumber + sortCode.' });
  }
});

export const PaymentRequestSchema = z.object({
  sourceAccountId: z.string().uuid(),
  amountMinor: z.number().int().positive(),
  currency: CurrencySchema,
  beneficiary: BeneficiarySchema,
  reference: z.string().min(1).max(140),
  purposeCode: z.string().max(35).optional(),
  chargeBearer: z.enum(['shared', 'sender', 'recipient']).optional(),
  requestedExecutionDate: z.string().date().optional(),
  clientReference: z.string().min(8).max(64)
}).superRefine((value, ctx) => {
  if (value.currency !== value.beneficiary.currency) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currency'], message: 'Payment and beneficiary currencies must match in v0.1.' });
  }
});

export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;

export type PaymentState =
  | 'draft'
  | 'validated'
  | 'funds_confirmed'
  | 'submitted'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'reverted'
  | 'declined'
  | 'manual_review';

export interface PaymentRecord {
  id: string;
  state: PaymentState;
  request: PaymentRequest;
  providerTransactionId?: string;
  validation?: NameValidationResult;
  quote?: TransferQuote;
  failureReason?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AccountBalance {
  accountId: string;
  currency: string;
  availableMinor: number;
}

export interface NameValidationResult {
  result: 'match' | 'close_match' | 'no_match' | 'cannot_be_checked' | 'temporarily_unavailable';
  matchedName?: string;
  source: 'revolut' | 'mock';
}

export interface TransferQuote {
  feeMinor: number;
  debitAmountMinor: number;
  currency: string;
  estimatedDelivery?: string;
}

export interface SubmitResult {
  transactionId: string;
  state: PaymentState;
}
