import type { PaymentPreparationInput } from './payment-orchestrator.js';
import type { PaymentOrchestrator } from './payment-orchestrator.js';
import type {
  Iso20022ImportInput,
  Iso20022ImportPreview,
  Iso20022Issue,
  Iso20022PreparedItem,
  Iso20022PrepareResult
} from '../iso20022/model.js';
import type { Iso20022ParserService } from '../iso20022/parser.js';

export class Iso20022ImportService {
  constructor(
    private readonly parser: Iso20022ParserService,
    private readonly orchestrator: PaymentOrchestrator
  ) {}

  validate(input: Iso20022ImportInput): Iso20022ImportPreview {
    return this.parser.parse(input);
  }

  async prepare(input: Iso20022ImportInput, atomic = true): Promise<Iso20022PrepareResult> {
    const preview = this.parser.parse(input);
    const documentHasErrors = preview.documentIssues.some(issue => issue.severity === 'error');
    const invalidCandidates = preview.payments.filter(payment => !payment.valid);

    if (documentHasErrors || (atomic && invalidCandidates.length > 0)) {
      const abortIssue: Iso20022Issue = {
        severity: 'error',
        code: documentHasErrors ? 'DOCUMENT_INTEGRITY_REJECTED' : 'ATOMIC_IMPORT_ABORTED',
        message: documentHasErrors
          ? 'No payments were prepared because document-level integrity validation failed.'
          : 'No payments were prepared because at least one transaction failed validation and atomic mode is enabled.'
      };
      const items = preview.payments.map<Iso20022PreparedItem>(payment => ({
        transactionIndex: payment.transactionIndex,
        status: 'rejected',
        payment: null,
        issues: payment.valid ? [...payment.issues, abortIssue] : payment.issues
      }));
      return this.result(preview, atomic, items);
    }

    const validCandidates = preview.payments.filter(payment => payment.valid && payment.request && payment.ingestion);
    const preparationInputs: PaymentPreparationInput[] = validCandidates.map(payment => ({
      request: payment.request!,
      ingestion: payment.ingestion!
    }));
    const preparationResults = await this.orchestrator.prepareMany(preparationInputs, atomic);
    const preparedByTransactionIndex = new Map<number, Iso20022PreparedItem>();

    for (const [index, candidate] of validCandidates.entries()) {
      const preparation = preparationResults[index];
      if (!preparation) {
        preparedByTransactionIndex.set(candidate.transactionIndex, {
          transactionIndex: candidate.transactionIndex,
          status: 'rejected',
          payment: null,
          issues: [...candidate.issues, preparationIssue('Payment preparation produced no result.', candidate.transactionIndex)]
        });
      } else if (preparation.status === 'rejected') {
        preparedByTransactionIndex.set(candidate.transactionIndex, {
          transactionIndex: candidate.transactionIndex,
          status: 'rejected',
          payment: null,
          issues: [...candidate.issues, preparationIssue(preparation.error, candidate.transactionIndex)]
        });
      } else {
        preparedByTransactionIndex.set(candidate.transactionIndex, {
          transactionIndex: candidate.transactionIndex,
          status: preparation.status,
          payment: preparation.record,
          issues: candidate.issues
        });
      }
    }

    const items = preview.payments.map<Iso20022PreparedItem>(payment => {
      if (!payment.valid) {
        return {
          transactionIndex: payment.transactionIndex,
          status: 'rejected',
          payment: null,
          issues: payment.issues
        };
      }
      return preparedByTransactionIndex.get(payment.transactionIndex) ?? {
        transactionIndex: payment.transactionIndex,
        status: 'rejected',
        payment: null,
        issues: [...payment.issues, preparationIssue('Payment preparation result is missing.', payment.transactionIndex)]
      };
    });

    return this.result(preview, atomic, items);
  }

  private result(preview: Iso20022ImportPreview, atomic: boolean, items: Iso20022PreparedItem[]): Iso20022PrepareResult {
    const prepared = items.filter(item => item.status === 'prepared').length;
    const existing = items.filter(item => item.status === 'existing').length;
    const rejected = items.length - prepared - existing;
    return {
      preview,
      atomic,
      items,
      summary: { prepared, existing, rejected },
      accepted: items.length > 0 && rejected === 0
    };
  }
}

function preparationIssue(message: string, transactionIndex: number): Iso20022Issue {
  return {
    severity: 'error',
    code: 'PREPARATION_REJECTED',
    message,
    transactionIndex
  };
}
