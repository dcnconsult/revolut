import { createHash } from 'node:crypto';
import { basename } from 'node:path';
import { TextDecoder } from 'node:util';
import { XMLParser, XMLValidator } from 'fast-xml-parser';
import { z } from 'zod';
import { PaymentRequestSchema, type Iso20022MessageType, type PaymentIngestion } from '../domain/payment.js';
import { addExactDecimals, decimalToMinorUnits, exactDecimalsEqual, formatExactDecimal, parseExactDecimal, type ExactDecimal } from '../domain/money.js';
import type { Iso20022ImportInput, Iso20022ImportPreview, Iso20022Issue, Iso20022PaymentCandidate } from './model.js';

const SUPPORTED_NAMESPACES: Readonly<Record<string, Iso20022MessageType>> = Object.freeze({
  'urn:iso:std:iso:20022:tech:xsd:pain.001.001.03': 'pain.001.001.03',
  'urn:iso:std:iso:20022:tech:xsd:pain.001.001.09': 'pain.001.001.09'
});

const uuidSchema = z.string().uuid();
const xmlParser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  processEntities: false,
  allowBooleanAttributes: false,
  removeNSPrefix: true
});

type XmlNode = Record<string, unknown>;

export interface Iso20022ParserOptions {
  maxFileBytes: number;
  maxTransactions: number;
  maxXmlElements: number;
  maxXmlDepth: number;
  structuredAddressCutoff: string;
  now?: () => Date;
}

export class Iso20022FileError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 422) {
    super(message);
    this.name = 'Iso20022FileError';
  }
}

export class Iso20022ParserService {
  private readonly now: () => Date;

  constructor(private readonly options: Iso20022ParserOptions) {
    this.now = options.now ?? (() => new Date());
  }

  parse(input: Iso20022ImportInput): Iso20022ImportPreview {
    if (input.content.length === 0) throw new Iso20022FileError('EMPTY_FILE', 'The uploaded XML file is empty.', 400);
    if (input.content.length > this.options.maxFileBytes) {
      throw new Iso20022FileError('FILE_TOO_LARGE', `The uploaded file exceeds ${this.options.maxFileBytes} bytes.`, 413);
    }

    const fileName = basename(input.fileName || 'payment.xml');
    const xml = this.decodeUtf8(input.content);
    this.assertSafeXml(xml);

    const syntaxResult = XMLValidator.validate(xml, { allowBooleanAttributes: false });
    if (syntaxResult !== true) {
      const detail = typeof syntaxResult === 'object' && syntaxResult.err
        ? `${syntaxResult.err.msg} at line ${syntaxResult.err.line}, column ${syntaxResult.err.col}`
        : 'The XML document is not well formed.';
      throw new Iso20022FileError('INVALID_XML', detail, 422);
    }

    const namespace = this.extractNamespace(xml);
    const messageType = SUPPORTED_NAMESPACES[namespace];
    if (!messageType) {
      throw new Iso20022FileError(
        'UNSUPPORTED_MESSAGE_TYPE',
        `Unsupported ISO 20022 namespace ${namespace}. Supported messages are pain.001.001.03 and pain.001.001.09.`
      );
    }

    const parsed = asRecord(xmlParser.parse(xml));
    const document = asRecord(parsed?.Document);
    const initiation = asRecord(document?.CstmrCdtTrfInitn);
    const groupHeader = asRecord(initiation?.GrpHdr);
    if (!document || !initiation || !groupHeader) {
      throw new Iso20022FileError('INVALID_MESSAGE_SHAPE', 'Expected Document/CstmrCdtTrfInitn/GrpHdr in the uploaded payment file.');
    }

    const fileSha256 = createHash('sha256').update(input.content).digest('hex');
    const importId = `iso-${fileSha256.slice(0, 24)}`;
    const documentIssues: Iso20022Issue[] = [];
    const messageId = childText(groupHeader, 'MsgId') ?? '';
    const createdAt = childText(groupHeader, 'CreDtTm');
    const initiatingParty = nestedText(groupHeader, ['InitgPty', 'Nm']);
    const groupTransactionCount = childText(groupHeader, 'NbOfTxs');

    if (!messageId) documentIssues.push(errorIssue('MISSING_MESSAGE_ID', 'GrpHdr/MsgId is required.', 'GrpHdr.MsgId'));
    if (!createdAt) {
      documentIssues.push(errorIssue('MISSING_CREATION_DATE_TIME', 'GrpHdr/CreDtTm is required.', 'GrpHdr.CreDtTm'));
    } else if (Number.isNaN(Date.parse(createdAt))) {
      documentIssues.push(errorIssue('INVALID_CREATION_DATE_TIME', 'GrpHdr/CreDtTm must be a valid ISO date-time.', 'GrpHdr.CreDtTm'));
    }
    if (!groupTransactionCount) documentIssues.push(errorIssue('MISSING_TRANSACTION_COUNT', 'GrpHdr/NbOfTxs is required.', 'GrpHdr.NbOfTxs'));
    if (!asRecord(groupHeader.InitgPty)) documentIssues.push(errorIssue('MISSING_INITIATING_PARTY', 'GrpHdr/InitgPty is required.', 'GrpHdr.InitgPty'));
    if (messageType === 'pain.001.001.03') {
      documentIssues.push(warningIssue(
        'LEGACY_MESSAGE_VERSION',
        'pain.001.001.03 is accepted for interoperability, while the current EPC SEPA customer-to-PSP profile is based on pain.001.001.09.'
      ));
    }

    const paymentInformationBlocks = asArray(initiation.PmtInf).map(asRecord).filter(isDefined);
    if (paymentInformationBlocks.length === 0) {
      documentIssues.push(errorIssue('MISSING_PAYMENT_INFORMATION', 'At least one PmtInf block is required.', 'PmtInf'));
    }

    const sourceAccountMap = normalizeSourceAccountMap(input.sourceAccountMap, documentIssues);
    const defaultSourceAccountId = validateDefaultSourceAccount(input.defaultSourceAccountId, documentIssues);

    const payments: Iso20022PaymentCandidate[] = [];
    const groupAmounts: ExactDecimal[] = [];
    let transactionIndex = 0;

    for (const [paymentInformationZeroIndex, paymentInformation] of paymentInformationBlocks.entries()) {
      const paymentInformationIndex = paymentInformationZeroIndex + 1;
      const rawPaymentInformationId = childText(paymentInformation, 'PmtInfId');
      const paymentInformationId = rawPaymentInformationId ?? `PmtInf-${paymentInformationIndex}`;
      const method = childText(paymentInformation, 'PmtMtd');
      const transactions = asArray(paymentInformation.CdtTrfTxInf).map(asRecord).filter(isDefined);
      const blockAmounts: ExactDecimal[] = [];

      if (!rawPaymentInformationId) {
        documentIssues.push(errorIssue(
          'MISSING_PAYMENT_INFORMATION_ID',
          `PmtInf block ${paymentInformationIndex} is missing PmtInfId.`,
          `PmtInf[${paymentInformationIndex}].PmtInfId`
        ));
      }
      if (!method) {
        documentIssues.push(errorIssue(
          'MISSING_PAYMENT_METHOD',
          `PmtInf ${paymentInformationId} is missing PmtMtd.`,
          `PmtInf[${paymentInformationIndex}].PmtMtd`
        ));
      } else if (method !== 'TRF') {
        documentIssues.push(errorIssue(
          'UNSUPPORTED_PAYMENT_METHOD',
          `PmtInf ${paymentInformationId} uses ${method}; only credit transfer method TRF is supported.`,
          `PmtInf[${paymentInformationIndex}].PmtMtd`
        ));
      }
      if (transactions.length === 0) {
        documentIssues.push(errorIssue(
          'EMPTY_PAYMENT_INFORMATION',
          `PmtInf ${paymentInformationId} contains no CdtTrfTxInf transactions.`,
          `PmtInf[${paymentInformationIndex}].CdtTrfTxInf`
        ));
      }

      this.checkDeclaredCount(
        childText(paymentInformation, 'NbOfTxs'),
        transactions.length,
        `PmtInf ${paymentInformationId}`,
        documentIssues,
        `PmtInf[${paymentInformationIndex}].NbOfTxs`
      );

      for (const transaction of transactions) {
        transactionIndex += 1;
        const candidate = this.mapTransaction({
          transaction,
          transactionIndex,
          paymentInformation,
          paymentInformationIndex,
          paymentInformationId,
          messageType,
          messageId,
          namespace,
          importId,
          fileName,
          fileSha256,
          sourceAccountMap,
          defaultSourceAccountId
        });
        payments.push(candidate);

        const rawAmount = extractAmount(transaction).amount;
        if (rawAmount) {
          try {
            const exact = parseExactDecimal(rawAmount, `transaction ${transactionIndex} amount`);
            blockAmounts.push(exact);
            groupAmounts.push(exact);
          } catch {
            // The transaction-level mapper already emits the actionable amount error.
          }
        }
      }

      this.checkDeclaredControlSum(
        childText(paymentInformation, 'CtrlSum'),
        blockAmounts,
        `PmtInf ${paymentInformationId}`,
        documentIssues,
        `PmtInf[${paymentInformationIndex}].CtrlSum`
      );
    }

    if (transactionIndex > this.options.maxTransactions) {
      documentIssues.push(errorIssue(
        'TRANSACTION_LIMIT_EXCEEDED',
        `The file contains ${transactionIndex} transactions; the configured maximum is ${this.options.maxTransactions}.`
      ));
    }

    const declaredTransactions = parseDeclaredCount(groupTransactionCount);
    this.checkDeclaredCount(groupTransactionCount, transactionIndex, 'GrpHdr', documentIssues, 'GrpHdr.NbOfTxs');
    const declaredControlSum = childText(groupHeader, 'CtrlSum');
    this.checkDeclaredControlSum(declaredControlSum, groupAmounts, 'GrpHdr', documentIssues, 'GrpHdr.CtrlSum');
    this.checkDuplicateIdentifiers(payments, documentIssues);

    const validPayments = payments.filter(payment => payment.valid).length;
    const allIssues = [...documentIssues, ...payments.flatMap(payment => payment.issues)];
    const errors = allIssues.filter(issue => issue.severity === 'error').length;
    const warnings = allIssues.length - errors;

    return {
      importId,
      file: { name: fileName, bytes: input.content.length, sha256: fileSha256 },
      message: {
        type: messageType,
        namespace,
        id: messageId,
        createdAt: createdAt ?? null,
        initiatingParty: initiatingParty ?? null,
        declaredTransactions,
        parsedTransactions: transactionIndex,
        declaredControlSum: declaredControlSum ?? null
      },
      validation: {
        xmlSyntax: true,
        supportedNamespace: true,
        semanticRules: true,
        officialXsd: false
      },
      documentIssues,
      payments,
      summary: {
        validPayments,
        invalidPayments: payments.length - validPayments,
        errors,
        warnings
      },
      valid: errors === 0
    };
  }

  private mapTransaction(context: {
    transaction: XmlNode;
    transactionIndex: number;
    paymentInformation: XmlNode;
    paymentInformationIndex: number;
    paymentInformationId: string;
    messageType: Iso20022MessageType;
    messageId: string;
    namespace: string;
    importId: string;
    fileName: string;
    fileSha256: string;
    sourceAccountMap: ReadonlyMap<string, string>;
    defaultSourceAccountId: string | null;
  }): Iso20022PaymentCandidate {
    const {
      transaction,
      transactionIndex,
      paymentInformation,
      paymentInformationIndex,
      paymentInformationId,
      messageType,
      messageId,
      importId,
      fileName,
      fileSha256,
      sourceAccountMap,
      defaultSourceAccountId
    } = context;
    const issues: Iso20022Issue[] = [];
    const paymentId = asRecord(transaction.PmtId);
    const instructionId = childText(paymentId, 'InstrId');
    const endToEndId = childText(paymentId, 'EndToEndId');
    if (!endToEndId) {
      issues.push(errorIssue(
        'MISSING_END_TO_END_ID',
        'PmtId/EndToEndId is required.',
        'CdtTrfTxInf.PmtId.EndToEndId',
        transactionIndex
      ));
    }
    const debtorAccount = extractAccountIdentifier(asRecord(paymentInformation.DbtrAcct));
    const debtorAccountIdentifier = debtorAccount.iban ?? debtorAccount.other;
    const mappedSourceAccountId = debtorAccountIdentifier
      ? sourceAccountMap.get(normalizeAccountIdentifier(debtorAccountIdentifier))
      : undefined;
    const sourceAccountId = mappedSourceAccountId ?? defaultSourceAccountId;

    if (!debtorAccountIdentifier) {
      issues.push(errorIssue(
        'MISSING_DEBTOR_ACCOUNT',
        'PmtInf/DbtrAcct must identify the debtor account so ownership can be reconciled to the selected Revolut source account.',
        `PmtInf[${paymentInformationIndex}].DbtrAcct.Id`,
        transactionIndex
      ));
    } else if (!mappedSourceAccountId && defaultSourceAccountId) {
      issues.push(warningIssue(
        'SOURCE_ACCOUNT_OVERRIDE_USED',
        `The selected Revolut sourceAccountId was applied to debtor account ${debtorAccountIdentifier}; production must verify that this account is owned by and matches the authenticated business.`,
        `PmtInf[${paymentInformationIndex}].DbtrAcct.Id`,
        transactionIndex
      ));
    }

    if (!sourceAccountId) {
      issues.push(errorIssue(
        'SOURCE_ACCOUNT_UNRESOLVED',
        'Select a Revolut sourceAccountId or provide a sourceAccountMap entry for the debtor account in this PmtInf block.',
        `PmtInf[${paymentInformationIndex}].DbtrAcct`,
        transactionIndex
      ));
    }

    const amount = extractAmount(transaction);
    const currency = amount.currency?.toUpperCase();
    let amountMinor: number | null = null;
    if (!amount.amount) {
      issues.push(errorIssue('MISSING_AMOUNT', 'Amt/InstdAmt is required.', 'CdtTrfTxInf.Amt.InstdAmt', transactionIndex));
    } else if (!currency || !/^[A-Z]{3}$/.test(currency)) {
      issues.push(errorIssue('MISSING_CURRENCY', 'InstdAmt must include a three-letter Ccy attribute.', 'CdtTrfTxInf.Amt.InstdAmt.@Ccy', transactionIndex));
    } else {
      try {
        amountMinor = decimalToMinorUnits(amount.amount, currency);
      } catch (error) {
        issues.push(errorIssue('INVALID_AMOUNT', (error as Error).message, 'CdtTrfTxInf.Amt.InstdAmt', transactionIndex));
      }
    }

    const creditor = asRecord(transaction.Cdtr);
    const creditorName = childText(creditor, 'Nm');
    if (!creditorName) {
      issues.push(errorIssue('MISSING_CREDITOR_NAME', 'Cdtr/Nm is required.', 'CdtTrfTxInf.Cdtr.Nm', transactionIndex));
    }

    const creditorAccount = extractAccountIdentifier(asRecord(transaction.CdtrAcct));
    if (!creditorAccount.iban && !creditorAccount.other) {
      issues.push(errorIssue('MISSING_CREDITOR_ACCOUNT', 'CdtrAcct must contain an IBAN or other account identifier.', 'CdtTrfTxInf.CdtrAcct.Id', transactionIndex));
    }

    const addressDetails = extractAddress(creditor);
    const ibanCountry = creditorAccount.iban?.slice(0, 2);
    const creditorCountry = addressDetails.country ?? ibanCountry;
    if (!creditorCountry) {
      issues.push(errorIssue(
        'MISSING_CREDITOR_COUNTRY',
        'Creditor country is required and could not be derived from Cdtr/PstlAdr/Ctry or the creditor IBAN.',
        'CdtTrfTxInf.Cdtr.PstlAdr.Ctry',
        transactionIndex
      ));
    }
    if (addressDetails.country && ibanCountry && addressDetails.country !== ibanCountry) {
      issues.push(errorIssue(
        'CREDITOR_COUNTRY_CONFLICT',
        `Creditor address country ${addressDetails.country} conflicts with IBAN country ${ibanCountry}.`,
        'CdtTrfTxInf.Cdtr',
        transactionIndex
      ));
    } else if (!addressDetails.country && ibanCountry) {
      issues.push(warningIssue(
        'CREDITOR_COUNTRY_DERIVED',
        `Creditor country was derived from the IBAN (${ibanCountry}).`,
        'CdtTrfTxInf.CdtrAcct.Id.IBAN',
        transactionIndex
      ));
    }

    const accountType = inferAccountType(creditor);
    if (accountType.inferred) {
      issues.push(warningIssue(
        'ACCOUNT_TYPE_INFERRED',
        'Creditor account type was not explicit in the XML and defaulted to business.',
        'CdtTrfTxInf.Cdtr.Id',
        transactionIndex
      ));
    }

    const creditorAgent = asRecord(transaction.CdtrAgt);
    const bic = extractBic(creditorAgent);
    const clearingMemberId = nestedText(creditorAgent, ['FinInstnId', 'ClrSysMmbId', 'MmbId']);
    const accountNumber = creditorAccount.iban ? undefined : creditorAccount.other;
    const sortCode = accountNumber && clearingMemberId?.replace(/\D/g, '').length === 6
      ? clearingMemberId.replace(/\D/g, '')
      : undefined;
    if (accountNumber && !sortCode) {
      issues.push(errorIssue(
        'UNSUPPORTED_NON_IBAN_ACCOUNT',
        'Non-IBAN creditor accounts currently require a six-digit UK sort code in CdtrAgt/FinInstnId/ClrSysMmbId/MmbId.',
        'CdtTrfTxInf.CdtrAgt.FinInstnId.ClrSysMmbId.MmbId',
        transactionIndex
      ));
    }

    const requestedExecutionDate = extractExecutionDate(paymentInformation);
    if (!requestedExecutionDate) {
      issues.push(errorIssue(
        'MISSING_EXECUTION_DATE',
        'PmtInf/ReqdExctnDt is required.',
        `PmtInf[${paymentInformationIndex}].ReqdExctnDt`,
        transactionIndex
      ));
    } else if (!/^\d{4}-\d{2}-\d{2}$/.test(requestedExecutionDate)) {
      issues.push(errorIssue(
        'INVALID_EXECUTION_DATE',
        `Requested execution date ${requestedExecutionDate} is not an ISO date.`,
        `PmtInf[${paymentInformationIndex}].ReqdExctnDt`,
        transactionIndex
      ));
    } else if (requestedExecutionDate < utcDate(this.now())) {
      issues.push(errorIssue(
        'EXECUTION_DATE_IN_PAST',
        `Requested execution date ${requestedExecutionDate} is in the past.`,
        `PmtInf[${paymentInformationIndex}].ReqdExctnDt`,
        transactionIndex
      ));
    }

    const serviceLevel = extractServiceLevel(paymentInformation, transaction);
    if (currency === 'EUR' && serviceLevel === 'SEPA' && addressDetails.unstructuredOnly) {
      const effectiveDate = requestedExecutionDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedExecutionDate)
        ? requestedExecutionDate
        : utcDate(this.now());
      if (effectiveDate >= this.options.structuredAddressCutoff) {
        issues.push(errorIssue(
          'UNSTRUCTURED_ADDRESS_NOT_PERMITTED',
          `Unstructured-only creditor addresses are not accepted for SEPA execution dates on or after ${this.options.structuredAddressCutoff}.`,
          'CdtTrfTxInf.Cdtr.PstlAdr.AdrLine',
          transactionIndex
        ));
      } else {
        issues.push(warningIssue(
          'UNSTRUCTURED_ADDRESS_DEPRECATION',
          `This SEPA payment uses an unstructured-only creditor address. Migrate to structured or hybrid address data before ${this.options.structuredAddressCutoff}.`,
          'CdtTrfTxInf.Cdtr.PstlAdr.AdrLine',
          transactionIndex
        ));
      }
    }

    const chargeBearerResult = mapChargeBearer(childText(transaction, 'ChrgBr') ?? childText(paymentInformation, 'ChrgBr'));
    if (chargeBearerResult.error) {
      issues.push(errorIssue('UNSUPPORTED_CHARGE_BEARER', chargeBearerResult.error, 'ChrgBr', transactionIndex));
    }

    const reference = extractReference(transaction, endToEndId, instructionId, paymentInformationId);
    const purposeCode = extractPurpose(paymentInformation, transaction);
    const clientReference = buildClientReference({
      messageId,
      paymentInformationId,
      transactionIndex,
      instructionId,
      endToEndId,
      amount: amount.amount,
      currency,
      creditorAccount: creditorAccount.iban ?? creditorAccount.other,
      sourceAccountId
    });

    const requestCandidate: Record<string, unknown> = {
      sourceAccountId,
      amountMinor,
      currency,
      beneficiary: {
        legalName: creditorName,
        accountType: accountType.type,
        country: creditorCountry,
        currency,
        ...(creditorAccount.iban ? { iban: creditorAccount.iban } : {}),
        ...(bic ? { bic } : {}),
        ...(accountNumber ? { accountNumber } : {}),
        ...(sortCode ? { sortCode } : {}),
        ...(addressDetails.normalized ? { address: addressDetails.normalized } : {})
      },
      reference,
      ...(purposeCode ? { purposeCode } : {}),
      ...(chargeBearerResult.value ? { chargeBearer: chargeBearerResult.value } : {}),
      ...(requestedExecutionDate && /^\d{4}-\d{2}-\d{2}$/.test(requestedExecutionDate) ? { requestedExecutionDate } : {}),
      clientReference
    };

    const requestResult = PaymentRequestSchema.safeParse(requestCandidate);
    if (!requestResult.success) {
      for (const schemaIssue of requestResult.error.issues) {
        issues.push(errorIssue(
          'PAYMENT_SCHEMA_INVALID',
          schemaIssue.message,
          schemaIssue.path.join('.'),
          transactionIndex
        ));
      }
    }

    const hasErrors = issues.some(issue => issue.severity === 'error');
    const ingestion: PaymentIngestion | null = !hasErrors && requestResult.success
      ? {
          method: 'iso20022',
          importId,
          fileName,
          fileSha256,
          validationProfile: 'syntax-semantic-v1',
          messageType,
          messageId,
          paymentInformationId,
          transactionIndex,
          ...(instructionId ? { instructionId } : {}),
          ...(endToEndId ? { endToEndId } : {}),
          ...(debtorAccountIdentifier ? { debtorAccountIdentifier } : {}),
          ...(serviceLevel ? { serviceLevel } : {})
        }
      : null;

    return {
      transactionIndex,
      paymentInformationIndex,
      paymentInformationId,
      instructionId: instructionId ?? null,
      endToEndId: endToEndId ?? null,
      debtorAccountIdentifier: debtorAccountIdentifier ?? null,
      request: !hasErrors && requestResult.success ? requestResult.data : null,
      ingestion,
      issues,
      valid: !hasErrors && requestResult.success
    };
  }

  private decodeUtf8(content: Buffer): string {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(content).replace(/^\uFEFF/, '');
    } catch {
      throw new Iso20022FileError('INVALID_ENCODING', 'The payment file must be valid UTF-8 XML.', 415);
    }
  }

  private assertSafeXml(xml: string): void {
    if (xml.includes('\u0000')) throw new Iso20022FileError('NUL_BYTE', 'The XML file contains a NUL byte.');
    if (/<!DOCTYPE\b/i.test(xml) || /<!ENTITY\b/i.test(xml)) {
      throw new Iso20022FileError('DTD_NOT_ALLOWED', 'DTD and entity declarations are not permitted in uploaded payment files.');
    }
    const withoutDeclaration = xml.replace(/^\s*<\?xml\s[^?]*\?>/i, '');
    if (/<\?/.test(withoutDeclaration)) {
      throw new Iso20022FileError('PROCESSING_INSTRUCTION_NOT_ALLOWED', 'XML processing instructions are not permitted.');
    }
    if (/<\s*(?:include|xinclude)\b/i.test(xml)) {
      throw new Iso20022FileError('XML_INCLUDE_NOT_ALLOWED', 'XML include elements are not permitted.');
    }
    if (/<\/?[A-Za-z_][\w.-]*:[A-Za-z_][\w.-]*/.test(xml)) {
      throw new Iso20022FileError(
        'PREFIXED_ELEMENTS_NOT_ALLOWED',
        'Use the canonical ISO 20022 default namespace form; namespace-prefixed elements are not accepted by this import profile.'
      );
    }

    const structure = measureXmlStructure(xml);
    if (structure.elements > this.options.maxXmlElements) {
      throw new Iso20022FileError(
        'XML_ELEMENT_LIMIT_EXCEEDED',
        `The XML contains ${structure.elements} elements; the configured maximum is ${this.options.maxXmlElements}.`,
        413
      );
    }
    if (structure.maxDepth > this.options.maxXmlDepth) {
      throw new Iso20022FileError(
        'XML_DEPTH_LIMIT_EXCEEDED',
        `The XML nesting depth is ${structure.maxDepth}; the configured maximum is ${this.options.maxXmlDepth}.`,
        413
      );
    }
  }

  private extractNamespace(xml: string): string {
    const root = /<Document\b([^>]*)>/.exec(xml);
    if (!root) throw new Iso20022FileError('MISSING_DOCUMENT_ROOT', 'The root element must be Document.');
    const namespace = /\bxmlns\s*=\s*["']([^"']+)["']/.exec(root[1] ?? '')?.[1];
    if (!namespace) throw new Iso20022FileError('MISSING_NAMESPACE', 'The Document root must declare the ISO 20022 default namespace.');
    return namespace;
  }

  private checkDeclaredCount(
    rawDeclared: string | undefined,
    actual: number,
    scope: string,
    issues: Iso20022Issue[],
    path: string
  ): void {
    if (rawDeclared === undefined) return;
    const declared = parseDeclaredCount(rawDeclared);
    if (declared === null) {
      issues.push(errorIssue('INVALID_TRANSACTION_COUNT', `${scope} NbOfTxs must contain digits only.`, path));
    } else if (declared !== actual) {
      issues.push(errorIssue('TRANSACTION_COUNT_MISMATCH', `${scope} declares ${declared} transactions but contains ${actual}.`, path));
    }
  }

  private checkDeclaredControlSum(
    rawDeclared: string | undefined,
    amounts: ExactDecimal[],
    scope: string,
    issues: Iso20022Issue[],
    path: string
  ): void {
    if (rawDeclared === undefined) return;
    try {
      const declared = parseExactDecimal(rawDeclared, `${scope} control sum`);
      const actual = amounts.reduce(addExactDecimals, { coefficient: 0n, scale: 0 });
      if (!exactDecimalsEqual(declared, actual)) {
        issues.push(errorIssue(
          'CONTROL_SUM_MISMATCH',
          `${scope} declares control sum ${formatExactDecimal(declared)} but parsed transactions total ${formatExactDecimal(actual)}.`,
          path
        ));
      }
    } catch (error) {
      issues.push(errorIssue('INVALID_CONTROL_SUM', (error as Error).message, path));
    }
  }

  private checkDuplicateIdentifiers(payments: Iso20022PaymentCandidate[], documentIssues: Iso20022Issue[]): void {
    const seen = new Map<string, number>();
    for (const payment of payments) {
      const identifiers = [payment.instructionId, payment.endToEndId]
        .filter((value): value is string => Boolean(value) && value !== 'NOTPROVIDED');
      for (const identifier of identifiers) {
        const previous = seen.get(identifier);
        if (previous !== undefined) {
          documentIssues.push(warningIssue(
            'DUPLICATE_PAYMENT_IDENTIFIER',
            `Identifier ${identifier} is reused by transactions ${previous} and ${payment.transactionIndex}.`,
            undefined,
            payment.transactionIndex
          ));
        } else {
          seen.set(identifier, payment.transactionIndex);
        }
      }
    }
  }
}

function normalizeSourceAccountMap(
  sourceAccountMap: Readonly<Record<string, string>> | undefined,
  issues: Iso20022Issue[]
): ReadonlyMap<string, string> {
  const normalized = new Map<string, string>();
  for (const [accountIdentifier, sourceAccountId] of Object.entries(sourceAccountMap ?? {})) {
    const parsed = uuidSchema.safeParse(sourceAccountId);
    if (!parsed.success) {
      issues.push(errorIssue('INVALID_SOURCE_ACCOUNT_ID', `Source account mapping for ${accountIdentifier} is not a UUID.`));
      continue;
    }
    normalized.set(normalizeAccountIdentifier(accountIdentifier), parsed.data);
  }
  return normalized;
}

function validateDefaultSourceAccount(value: string | undefined, issues: Iso20022Issue[]): string | null {
  if (!value) return null;
  const parsed = uuidSchema.safeParse(value);
  if (!parsed.success) {
    issues.push(errorIssue('INVALID_SOURCE_ACCOUNT_ID', 'defaultSourceAccountId must be a UUID.'));
    return null;
  }
  return parsed.data;
}

function extractAmount(transaction: XmlNode): { amount: string | undefined; currency: string | undefined } {
  const amountContainer = asRecord(transaction.Amt);
  const instructed = amountContainer?.InstdAmt;
  const instructedRecord = asRecord(instructed);
  return {
    amount: textValue(instructed),
    currency: instructedRecord ? textValue(instructedRecord['@_Ccy']) : undefined
  };
}

function extractAccountIdentifier(account: XmlNode | undefined): { iban: string | undefined; other: string | undefined } {
  const id = asRecord(account?.Id);
  const iban = childText(id, 'IBAN')?.replace(/\s+/g, '').toUpperCase();
  const other = nestedText(id, ['Othr', 'Id'])?.replace(/\s+/g, '');
  return { iban, other };
}

function extractBic(agent: XmlNode | undefined): string | undefined {
  const financialInstitution = asRecord(agent?.FinInstnId);
  return (childText(financialInstitution, 'BICFI') ?? childText(financialInstitution, 'BIC'))?.replace(/\s+/g, '').toUpperCase();
}

function inferAccountType(creditor: XmlNode | undefined): { type: 'business' | 'personal'; inferred: boolean } {
  const identification = asRecord(creditor?.Id);
  if (identification?.PrvtId) return { type: 'personal', inferred: false };
  if (identification?.OrgId) return { type: 'business', inferred: false };
  return { type: 'business', inferred: true };
}

function extractAddress(creditor: XmlNode | undefined): {
  country: string | undefined;
  normalized: { line1: string; city: string; region?: string; postalCode?: string; country: string } | undefined;
  unstructuredOnly: boolean;
} {
  const address = asRecord(creditor?.PstlAdr);
  if (!address) return { country: undefined, normalized: undefined, unstructuredOnly: false };

  const country = childText(address, 'Ctry')?.toUpperCase();
  const city = childText(address, 'TwnNm');
  const region = childText(address, 'CtrySubDvsn');
  const postalCode = childText(address, 'PstCd');
  const street = childText(address, 'StrtNm');
  const building = childText(address, 'BldgNb') ?? childText(address, 'BldgNm');
  const department = childText(address, 'Dept') ?? childText(address, 'SubDept');
  const addressLines = asArray(address.AdrLine).map(textValue).filter(isDefined);
  const structuredLine = [department, street, building].filter(isDefined).join(' ').trim();
  const line1 = structuredLine || addressLines[0];
  const unstructuredOnly = addressLines.length > 0 && !street && !building && !city && !postalCode;

  const normalized = line1 && city && country
    ? {
        line1,
        city,
        country,
        ...(region ? { region } : {}),
        ...(postalCode ? { postalCode } : {})
      }
    : undefined;

  return { country, normalized, unstructuredOnly };
}

function extractExecutionDate(paymentInformation: XmlNode): string | undefined {
  const value = paymentInformation.ReqdExctnDt;
  const direct = textValue(value);
  if (direct) return direct.slice(0, 10);
  const choice = asRecord(value);
  return (childText(choice, 'Dt') ?? childText(choice, 'DtTm'))?.slice(0, 10);
}

function extractServiceLevel(paymentInformation: XmlNode, transaction: XmlNode): string | undefined {
  const transactionType = asRecord(transaction.PmtTpInf);
  const informationType = asRecord(paymentInformation.PmtTpInf);
  return extractChoiceText(asRecord(transactionType?.SvcLvl)) ?? extractChoiceText(asRecord(informationType?.SvcLvl));
}

function extractPurpose(paymentInformation: XmlNode, transaction: XmlNode): string | undefined {
  const transactionPurpose = extractChoiceText(asRecord(transaction.Purp));
  if (transactionPurpose) return transactionPurpose;
  const transactionType = asRecord(transaction.PmtTpInf);
  const informationType = asRecord(paymentInformation.PmtTpInf);
  return extractChoiceText(asRecord(transactionType?.CtgyPurp)) ?? extractChoiceText(asRecord(informationType?.CtgyPurp));
}

function extractReference(
  transaction: XmlNode,
  endToEndId: string | undefined,
  instructionId: string | undefined,
  paymentInformationId: string
): string {
  const remittance = asRecord(transaction.RmtInf);
  const unstructured = asArray(remittance?.Ustrd).map(textValue).filter(isDefined).join(' ').trim();
  const structured = asArray(remittance?.Strd)
    .map(asRecord)
    .filter(isDefined)
    .map(value => nestedText(value, ['CdtrRefInf', 'Ref']))
    .find(isDefined);
  const usableEndToEnd = endToEndId && endToEndId !== 'NOTPROVIDED' ? endToEndId : undefined;
  return unstructured || structured || usableEndToEnd || instructionId || paymentInformationId;
}

function extractChoiceText(node: XmlNode | undefined): string | undefined {
  return (childText(node, 'Cd') ?? childText(node, 'Prtry'))?.toUpperCase();
}

function mapChargeBearer(value: string | undefined): {
  value: 'shared' | 'sender' | 'recipient' | undefined;
  error: string | undefined;
} {
  if (!value) return { value: undefined, error: undefined };
  switch (value.toUpperCase()) {
    case 'SLEV':
    case 'SHAR':
      return { value: 'shared', error: undefined };
    case 'DEBT':
      return { value: 'sender', error: undefined };
    case 'CRED':
      return { value: 'recipient', error: undefined };
    default:
      return { value: undefined, error: `Charge bearer ${value} is not supported.` };
  }
}

function buildClientReference(values: {
  messageId: string;
  paymentInformationId: string;
  transactionIndex: number;
  instructionId: string | undefined;
  endToEndId: string | undefined;
  amount: string | undefined;
  currency: string | undefined;
  creditorAccount: string | undefined;
  sourceAccountId: string | null;
}): string {
  const canonical = [
    values.messageId,
    values.paymentInformationId,
    String(values.transactionIndex),
    values.instructionId ?? '',
    values.endToEndId ?? '',
    values.amount ?? '',
    values.currency ?? '',
    values.creditorAccount ?? '',
    values.sourceAccountId ?? ''
  ].join('|');
  return `iso-${createHash('sha256').update(canonical).digest('hex').slice(0, 32)}`;
}

function normalizeAccountIdentifier(value: string): string {
  return value.replace(/\s+/g, '').toUpperCase();
}

function parseDeclaredCount(value: string | undefined): number | null {
  if (!value || !/^\d{1,15}$/.test(value)) return null;
  const count = Number(value);
  return Number.isSafeInteger(count) ? count : null;
}

function utcDate(value: Date): string {
  return value.toISOString().slice(0, 10);
}

function asRecord(value: unknown): XmlNode | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? value as XmlNode
    : undefined;
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (typeof value === 'number' || typeof value === 'bigint') return String(value);
  const record = asRecord(value);
  return record ? textValue(record['#text']) : undefined;
}

function childText(node: XmlNode | undefined, key: string): string | undefined {
  return node ? textValue(node[key]) : undefined;
}

function nestedText(node: XmlNode | undefined, path: string[]): string | undefined {
  let current: unknown = node;
  for (const key of path) {
    const record = asRecord(current);
    if (!record) return undefined;
    current = record[key];
  }
  return textValue(current);
}

function isDefined<T>(value: T | undefined): value is T {
  return value !== undefined;
}

function measureXmlStructure(xml: string): { elements: number; maxDepth: number } {
  const structural = xml
    .replace(/<!--[\s\S]*?-->/g, '')
    .replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '')
    .replace(/<\?[^?]*\?>/g, '');
  const tags = structural.matchAll(/<\s*(\/?)\s*([A-Za-z_][\w.-]*)(?:\s[^<>]*?)?\s*(\/?)>/g);
  let elements = 0;
  let depth = 0;
  let maxDepth = 0;
  for (const match of tags) {
    const closing = match[1] === '/';
    const selfClosing = match[3] === '/';
    if (closing) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    elements += 1;
    if (!selfClosing) {
      depth += 1;
      maxDepth = Math.max(maxDepth, depth);
    }
  }
  return { elements, maxDepth };
}

function errorIssue(code: string, message: string, path?: string, transactionIndex?: number): Iso20022Issue {
  return {
    severity: 'error',
    code,
    message,
    ...(path ? { path } : {}),
    ...(transactionIndex !== undefined ? { transactionIndex } : {})
  };
}

function warningIssue(code: string, message: string, path?: string, transactionIndex?: number): Iso20022Issue {
  return {
    severity: 'warning',
    code,
    message,
    ...(path ? { path } : {}),
    ...(transactionIndex !== undefined ? { transactionIndex } : {})
  };
}
