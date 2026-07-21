import { z } from 'zod';
import { isValidIban, normalizeIban } from './iban.js';

const uppercase = (value: unknown) => typeof value === 'string' ? value.trim().toUpperCase() : value;
const normalizeBic = (value: unknown) => typeof value === 'string' ? value.replace(/\s+/g, '').toUpperCase() : value;

export const CurrencySchema = z.preprocess(uppercase, z.string().regex(/^[A-Z]{3}$/));
export const CountrySchema = z.preprocess(uppercase, z.string().regex(/^[A-Z]{2}$/));
export const IbanSchema = z.preprocess(
  value => typeof value === 'string' ? normalizeIban(value) : value,
  z.string().min(15).max(34).refine(isValidIban, 'IBAN checksum is invalid.')
);

export const BeneficiarySchema = z.object({
  legalName: z.string().trim().min(2).max(140),
  accountType: z.enum(['business', 'personal']).default('business'),
  country: CountrySchema,
  currency: CurrencySchema,
  iban: IbanSchema.optional(),
  bic: z.preprocess(normalizeBic, z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/)).optional(),
  accountNumber: z.preprocess(value => typeof value === 'string' ? value.replace(/\s+/g, '') : value, z.string().min(4).max(34)).optional(),
  sortCode: z.preprocess(value => typeof value === 'string' ? value.replace(/\D/g, '') : value, z.string().regex(/^\d{6}$/)).optional(),
  address: z.object({
    line1: z.string().trim().min(2).max(140),
    city: z.string().trim().min(1).max(70),
    region: z.string().trim().max(70).optional(),
    postalCode: z.string().trim().max(16).optional(),
    country: CountrySchema
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
  reference: z.string().trim().min(1).max(140),
  purposeCode: z.preprocess(uppercase, z.string().max(35)).optional(),
  chargeBearer: z.enum(['shared', 'sender', 'recipient']).optional(),
  requestedExecutionDate: z.string().date().optional(),
  clientReference: z.string().trim().min(8).max(64)
}).superRefine((value, ctx) => {
  if (value.currency !== value.beneficiary.currency) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['currency'], message: 'Payment and beneficiary currencies must match in v0.2.' });
  }
});

export type PaymentRequest = z.infer<typeof PaymentRequestSchema>;

export type Iso20022MessageType = 'pain.001.001.03' | 'pain.001.001.09';

export type PaymentIngestion =
  | { method: 'manual' }
  | {
      method: 'iso20022';
      importId: string;
      fileName: string;
      fileSha256: string;
      validationProfile: 'syntax-semantic-v1';
      messageType: Iso20022MessageType;
      messageId: string;
      paymentInformationId: string;
      transactionIndex: number;
      instructionId?: string;
      endToEndId?: string;
      debtorAccountIdentifier?: string;
      serviceLevel?: string;
    };

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

export interface FundsVerification {
  accountId: string;
  currency: string;
  availableMinor: number;
  paymentDebitMinor: number;
  aggregateDebitMinor: number;
  checkedAt: string;
}

export interface PaymentRecord {
  id: string;
  state: PaymentState;
  request: PaymentRequest;
  ingestion: PaymentIngestion;
  providerTransactionId?: string;
  validation?: NameValidationResult;
  quote?: TransferQuote;
  fundsVerification?: FundsVerification;
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
