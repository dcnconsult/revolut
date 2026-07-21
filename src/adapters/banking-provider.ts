import type { AccountBalance, NameValidationResult, PaymentRequest, SubmitResult, TransferQuote } from '../domain/payment.js';

export interface BankingProvider {
  getBalance(accountId: string, currency: string): Promise<AccountBalance>;
  discoverRequiredFields(payment: PaymentRequest): Promise<string[]>;
  validateBeneficiary(payment: PaymentRequest): Promise<NameValidationResult>;
  quoteTransfer(payment: PaymentRequest): Promise<TransferQuote>;
  submitTransfer(payment: PaymentRequest, idempotencyKey: string): Promise<SubmitResult>;
  getTransaction(transactionId: string): Promise<SubmitResult>;
}
