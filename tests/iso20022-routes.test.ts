import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/server.js';

const sourceAccountId = '8d43a0d9-f040-4c98-b9de-89cf30ab9807';
const xml = readFileSync(new URL('./fixtures/pain.001.001.03-valid.xml', import.meta.url));

function multipartPayload(file: Buffer) {
  const boundary = '----revolute-test-boundary';
  const sourceField = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="sourceAccountId"\r\n\r\n' +
    `${sourceAccountId}\r\n`
  );
  const filePrefix = Buffer.from(
    `--${boundary}\r\n` +
    'Content-Disposition: form-data; name="file"; filename="payments.xml"\r\n' +
    'Content-Type: application/xml\r\n\r\n'
  );
  const suffix = Buffer.from(`\r\n--${boundary}--\r\n`);
  return {
    body: Buffer.concat([sourceField, filePrefix, file, suffix]),
    contentType: `multipart/form-data; boundary=${boundary}`
  };
}

describe('ISO 20022 upload routes', () => {
  let app: FastifyInstance | undefined;
  afterEach(async () => { await app?.close(); });

  it('validates an uploaded file without provider-side preparation', async () => {
    app = buildApp();
    const payload = multipartPayload(xml);
    const response = await app.inject({
      method: 'POST',
      url: '/v1/payment-imports/iso20022/validate',
      headers: { 'content-type': payload.contentType },
      payload: payload.body
    });

    expect(response.statusCode).toBe(200);
    const body = response.json();
    expect(body.valid).toBe(true);
    expect(body.message.parsedTransactions).toBe(2);
    expect(body.payments[0].request.amountMinor).toBe(100_000);
  });

  it('prepares a batch, verifies aggregate funds, and reuses deterministic duplicates', async () => {
    app = buildApp();
    const firstPayload = multipartPayload(xml);
    const firstResponse = await app.inject({
      method: 'POST',
      url: '/v1/payment-imports/iso20022/prepare',
      headers: { 'content-type': firstPayload.contentType },
      payload: firstPayload.body
    });
    expect(firstResponse.statusCode).toBe(201);
    const first = firstResponse.json();
    expect(first.accepted).toBe(true);
    expect(first.summary).toEqual({ prepared: 2, existing: 0, rejected: 0 });
    expect(first.items[0].payment.fundsVerification.aggregateDebitMinor).toBe(150_100);
    expect(first.items[1].payment.fundsVerification.aggregateDebitMinor).toBe(150_100);

    const secondPayload = multipartPayload(xml);
    const secondResponse = await app.inject({
      method: 'POST',
      url: '/v1/payment-imports/iso20022/prepare',
      headers: { 'content-type': secondPayload.contentType },
      payload: secondPayload.body
    });
    expect(secondResponse.statusCode).toBe(201);
    const second = secondResponse.json();
    expect(second.summary).toEqual({ prepared: 0, existing: 2, rejected: 0 });
    expect(second.items[0].payment.id).toBe(first.items[0].payment.id);
  });
});
