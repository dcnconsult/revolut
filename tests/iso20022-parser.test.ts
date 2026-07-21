import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { Iso20022FileError, Iso20022ParserService } from '../src/iso20022/parser.js';

const sourceAccountId = '8d43a0d9-f040-4c98-b9de-89cf30ab9807';
const parser = new Iso20022ParserService({
  maxFileBytes: 2_000_000,
  maxTransactions: 100,
  maxXmlElements: 20_000,
  maxXmlDepth: 64,
  structuredAddressCutoff: '2026-11-15',
  now: () => new Date('2026-07-21T12:00:00Z')
});

function fixture(name: string) {
  return readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
}

function parse(name: string) {
  return parser.parse({
    fileName: name,
    content: fixture(name),
    defaultSourceAccountId: sourceAccountId
  });
}

describe('ISO 20022 pain.001 parser', () => {
  it('maps a multi-payment pain.001.001.03 file to canonical payments with deterministic references', () => {
    const first = parse('pain.001.001.03-valid.xml');
    const second = parse('pain.001.001.03-valid.xml');

    expect(first.message.type).toBe('pain.001.001.03');
    expect(first.message.parsedTransactions).toBe(2);
    expect(first.message.declaredControlSum).toBe('1500.50');
    expect(first.payments.map(payment => payment.request?.amountMinor)).toEqual([100_000, 50_050]);
    expect(first.payments[0]?.request?.beneficiary.iban).toBe('DE89370400440532013000');
    expect(first.payments[1]?.request?.reference).toBe('RF18539007547034');
    expect(first.payments.map(payment => payment.request?.clientReference))
      .toEqual(second.payments.map(payment => payment.request?.clientReference));
    expect(first.importId).toBe(second.importId);
    expect(first.valid).toBe(true);
  });

  it('supports pain.001.001.09 date choices and BICFI elements', () => {
    const parsed = parse('pain.001.001.09-valid.xml');

    expect(parsed.message.type).toBe('pain.001.001.09');
    expect(parsed.payments).toHaveLength(1);
    expect(parsed.payments[0]?.request?.requestedExecutionDate).toBe('2099-07-24');
    expect(parsed.payments[0]?.request?.beneficiary.bic).toBe('COBADEFFXXX');
    expect(parsed.valid).toBe(true);
  });

  it('flags a control-sum mismatch before any payment is prepared', () => {
    const xml = fixture('pain.001.001.03-valid.xml').toString('utf8').replace(
      '<CtrlSum>1500.50</CtrlSum>',
      '<CtrlSum>1500.51</CtrlSum>'
    );
    const parsed = parser.parse({
      fileName: 'mismatch.xml',
      content: Buffer.from(xml),
      defaultSourceAccountId: sourceAccountId
    });

    expect(parsed.valid).toBe(false);
    expect(parsed.documentIssues).toContainEqual(expect.objectContaining({ code: 'CONTROL_SUM_MISMATCH' }));
  });

  it('rejects DTD and entity-capable XML constructs', () => {
    const xml = fixture('pain.001.001.09-valid.xml').toString('utf8').replace(
      '?>',
      '?>\n<!DOCTYPE Document [<!ENTITY xxe SYSTEM "file:///etc/passwd">]>'
    );

    expect(() => parser.parse({
      fileName: 'unsafe.xml',
      content: Buffer.from(xml),
      defaultSourceAccountId: sourceAccountId
    })).toThrowError(Iso20022FileError);
  });
});
