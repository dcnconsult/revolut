import type { FastifyInstance, FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import type { Iso20022ImportInput } from '../../iso20022/model.js';
import { Iso20022FileError } from '../../iso20022/parser.js';
import type { Iso20022ImportService } from '../../services/iso20022-import-service.js';

const XML_MIME_TYPES = new Set(['application/xml', 'text/xml', 'application/octet-stream', 'application/x-xml']);
const ALLOWED_FIELDS = new Set(['sourceAccountId', 'defaultSourceAccountId', 'sourceAccountMap', 'atomic']);

class UploadFormError extends Error {
  constructor(readonly code: string, message: string, readonly statusCode = 400) {
    super(message);
    this.name = 'UploadFormError';
  }
}

export async function iso20022ImportRoutes(app: FastifyInstance, service: Iso20022ImportService) {
  app.post('/payment-imports/iso20022/validate', async (request, reply) => {
    try {
      const { input } = await readUpload(request);
      return reply.send(service.validate(input));
    } catch (error) {
      return sendImportError(reply, error);
    }
  });

  app.post('/payment-imports/iso20022/prepare', async (request, reply) => {
    try {
      const { input, atomic } = await readUpload(request);
      const result = await service.prepare(input, atomic);
      const statusCode = result.accepted ? 201 : result.summary.prepared + result.summary.existing > 0 ? 207 : 422;
      return reply.code(statusCode).send(result);
    } catch (error) {
      return sendImportError(reply, error);
    }
  });
}

async function readUpload(request: FastifyRequest): Promise<{ input: Iso20022ImportInput; atomic: boolean }> {
  let content: Buffer | null = null;
  let fileName = '';
  let mimeType = '';
  const fields = new Map<string, string>();

  const parts = request.parts({
    limits: {
      files: 1,
      fields: 4,
      parts: 5,
      fileSize: env.ISO20022_MAX_FILE_BYTES,
      fieldSize: 100_000
    }
  });

  for await (const part of parts) {
    if (part.type === 'file') {
      if (part.fieldname !== 'file') throw new UploadFormError('UNEXPECTED_FILE_FIELD', 'The XML file must use multipart field name file.');
      if (content) throw new UploadFormError('MULTIPLE_FILES', 'Upload exactly one XML payment file.');
      fileName = part.filename || 'payment.xml';
      mimeType = part.mimetype || 'application/octet-stream';
      content = await part.toBuffer();
      if (part.file.truncated) throw new UploadFormError('FILE_TOO_LARGE', `The XML file exceeds ${env.ISO20022_MAX_FILE_BYTES} bytes.`, 413);
    } else {
      if (!ALLOWED_FIELDS.has(part.fieldname)) {
        throw new UploadFormError('UNEXPECTED_FIELD', `Unexpected multipart field ${part.fieldname}.`);
      }
      fields.set(part.fieldname, String(part.value));
    }
  }

  if (!content) throw new UploadFormError('MISSING_FILE', 'Upload an ISO 20022 XML file using multipart field name file.');
  const hasXmlExtension = fileName.toLowerCase().endsWith('.xml');
  if (!XML_MIME_TYPES.has(mimeType) || (mimeType === 'application/octet-stream' && !hasXmlExtension)) {
    throw new UploadFormError('UNSUPPORTED_MEDIA_TYPE', `Unsupported file type ${mimeType}; upload an XML file.`, 415);
  }

  const defaultSourceAccountId = fields.get('sourceAccountId') ?? fields.get('defaultSourceAccountId');
  const sourceAccountMap = parseSourceAccountMap(fields.get('sourceAccountMap'));
  const atomic = parseBoolean(fields.get('atomic'), true);
  const input: Iso20022ImportInput = {
    fileName,
    content,
    ...(defaultSourceAccountId ? { defaultSourceAccountId } : {}),
    ...(sourceAccountMap ? { sourceAccountMap } : {})
  };
  return { input, atomic };
}

function parseSourceAccountMap(raw: string | undefined): Readonly<Record<string, string>> | undefined {
  if (!raw) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new UploadFormError('INVALID_SOURCE_ACCOUNT_MAP', 'sourceAccountMap must be a JSON object mapping debtor account identifiers to Revolut account UUIDs.');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new UploadFormError('INVALID_SOURCE_ACCOUNT_MAP', 'sourceAccountMap must be a JSON object.');
  }

  const result: Record<string, string> = Object.create(null) as Record<string, string>;
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (entries.length > env.ISO20022_MAX_TRANSACTIONS) {
    throw new UploadFormError('SOURCE_ACCOUNT_MAP_TOO_LARGE', 'sourceAccountMap contains too many entries.');
  }
  for (const [key, value] of entries) {
    if (!key || key === '__proto__' || key === 'prototype' || key === 'constructor' || typeof value !== 'string') {
      throw new UploadFormError('INVALID_SOURCE_ACCOUNT_MAP', 'sourceAccountMap contains an invalid key or value.');
    }
    result[key] = value;
  }
  return result;
}

function parseBoolean(raw: string | undefined, defaultValue: boolean): boolean {
  if (raw === undefined) return defaultValue;
  if (raw === 'true') return true;
  if (raw === 'false') return false;
  throw new UploadFormError('INVALID_BOOLEAN', 'atomic must be true or false.');
}

function sendImportError(reply: { code(statusCode: number): { send(payload: unknown): unknown } }, error: unknown) {
  if (error instanceof Iso20022FileError || error instanceof UploadFormError) {
    return reply.code(error.statusCode).send({ error: error.code, message: error.message });
  }
  const statusCode = typeof error === 'object' && error && 'statusCode' in error && typeof error.statusCode === 'number'
    ? error.statusCode
    : 500;
  const message = error instanceof Error ? error.message : 'Unexpected ISO 20022 import error.';
  return reply.code(statusCode).send({ error: statusCode === 500 ? 'import_error' : 'upload_error', message });
}
