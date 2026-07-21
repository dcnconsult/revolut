import type { PaymentIngestion, PaymentRecord, PaymentRequest, Iso20022MessageType } from '../domain/payment.js';

export interface Iso20022Issue {
  severity: 'error' | 'warning';
  code: string;
  message: string;
  path?: string;
  transactionIndex?: number;
}

export interface Iso20022SourceAccountSelection {
  defaultSourceAccountId?: string;
  sourceAccountMap?: Readonly<Record<string, string>>;
}

export interface Iso20022ImportInput extends Iso20022SourceAccountSelection {
  fileName: string;
  content: Buffer;
}

export interface Iso20022PaymentCandidate {
  transactionIndex: number;
  paymentInformationIndex: number;
  paymentInformationId: string;
  instructionId: string | null;
  endToEndId: string | null;
  debtorAccountIdentifier: string | null;
  request: PaymentRequest | null;
  ingestion: PaymentIngestion | null;
  issues: Iso20022Issue[];
  valid: boolean;
}

export interface Iso20022ImportPreview {
  importId: string;
  file: {
    name: string;
    bytes: number;
    sha256: string;
  };
  message: {
    type: Iso20022MessageType;
    namespace: string;
    id: string;
    createdAt: string | null;
    initiatingParty: string | null;
    declaredTransactions: number | null;
    parsedTransactions: number;
    declaredControlSum: string | null;
  };
  validation: {
    xmlSyntax: true;
    supportedNamespace: true;
    semanticRules: true;
    officialXsd: false;
  };
  documentIssues: Iso20022Issue[];
  payments: Iso20022PaymentCandidate[];
  summary: {
    validPayments: number;
    invalidPayments: number;
    errors: number;
    warnings: number;
  };
  valid: boolean;
}

export interface Iso20022PreparedItem {
  transactionIndex: number;
  status: 'prepared' | 'existing' | 'rejected';
  payment: PaymentRecord | null;
  issues: Iso20022Issue[];
}

export interface Iso20022PrepareResult {
  preview: Iso20022ImportPreview;
  atomic: boolean;
  items: Iso20022PreparedItem[];
  summary: {
    prepared: number;
    existing: number;
    rejected: number;
  };
  accepted: boolean;
}
