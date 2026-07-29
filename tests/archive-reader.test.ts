import { describe, expect, it, vi } from 'vitest';
import yazl from 'yazl';
import {
  ArchiveValidationError,
  inspectArchive,
  type ArchiveLimits,
  type ArchiveValidationFailureCode
} from '../src/cases/archive-reader.js';
import { CleanTestScanner, type MalwareScanner } from '../src/cases/malware-scanner.js';

const limits: ArchiveLimits = {
  maximumZipBytes: 1024 * 1024,
  maximumEntries: 10,
  maximumEntryBytes: 128 * 1024,
  maximumTotalBytes: 256 * 1024,
  maximumCompressionRatio: 20
};

describe('archive reader validation failures', () => {
  it.each<[string, Buffer, ArchiveValidationFailureCode]>([
    ['rejects a non-ZIP upload', Buffer.from('not a zip'), 'ARCHIVE_NOT_ZIP'],
    ['rejects a ZIP-shaped but corrupt upload', Buffer.from([0x50, 0x4b, 0x03, 0x04]), 'ARCHIVE_STRUCTURE_INVALID']
  ])('%s with a typed error', async (_description, content, code) => {
    await expectArchiveFailure(content, code);
  });

  it('maps configured byte limits and compression limits independently', async () => {
    await expectArchiveFailure(Buffer.from('too large'), 'ARCHIVE_LIMIT_EXCEEDED', {
      maximumZipBytes: 1
    });
    await expectArchiveFailure(
      await zipBuffer([['large.txt', Buffer.alloc(4_096, 'a')]]),
      'ARCHIVE_COMPRESSION_RATIO_EXCEEDED',
      { maximumCompressionRatio: 1 }
    );
  });

  it('maps unsafe, duplicate, and unsupported artifacts independently', async () => {
    const safeName = 'good.txt';
    const unsafeName = '../x.txt';
    const safeArchive = await zipBuffer([[safeName, Buffer.from('safe')]]);
    await expectArchiveFailure(
      replaceAllAscii(safeArchive, safeName, unsafeName),
      'ARCHIVE_PATH_UNSAFE'
    );
    await expectArchiveFailure(
      await zipBuffer([
        ['A.txt', Buffer.from('one')],
        ['a.TXT', Buffer.from('two')]
      ]),
      'ARCHIVE_DUPLICATE_PATH'
    );
    await expectArchiveFailure(
      await zipBuffer([['payload.exe', Buffer.from('not executable bytes')]]),
      'UNSUPPORTED_ARTIFACT_TYPE'
    );
  });

  it('retains malformed JSON and XML as a clean diagnostic inventory', async () => {
    const archive = await inspectArchive(
      await zipBuffer([
        ['invalid.json', Buffer.from('{"unterminated":')],
        ['invalid.xml', Buffer.from('not XML')]
      ]),
      limits,
      new CleanTestScanner()
    );

    expect(archive.scanner).toBe('CLEAN');
    expect(archive.entries.map(entry => entry.normalizedPath)).toEqual(['invalid.json', 'invalid.xml']);
  });

  it('does not inspect magic or text encodings until the complete malware scan is clean', async () => {
    const scanner: MalwareScanner = {
      scan: vi.fn(async () => ({ status: 'UNAVAILABLE' as const }))
    };
    const archive = await inspectArchive(
      await zipBuffer([
        ['invalid.json', Buffer.from([0xff, 0xfe])],
        ['not-a-pdf.pdf', Buffer.from('not a PDF')]
      ]),
      limits,
      scanner
    );

    expect(archive.scanner).toBe('UNAVAILABLE');
    expect(scanner.scan).toHaveBeenCalledTimes(2);
    expect(archive.entries[0]?.scanStatus).toBe('UNAVAILABLE');
  });
});

async function expectArchiveFailure(
  content: Buffer,
  code: ArchiveValidationFailureCode,
  overrides: Partial<ArchiveLimits> = {}
) {
  const inspected = inspectArchive(content, { ...limits, ...overrides }, new CleanTestScanner());
  await expect(inspected).rejects.toBeInstanceOf(ArchiveValidationError);
  await expect(inspected).rejects.toMatchObject({ code });
}

function zipBuffer(entries: Array<[string, Buffer]>) {
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.once('error', reject);
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of entries) zip.addBuffer(content, name);
    zip.end();
  });
}

function replaceAllAscii(content: Buffer, from: string, to: string) {
  const source = Buffer.from(from, 'ascii');
  const replacement = Buffer.from(to, 'ascii');
  if (source.length !== replacement.length) throw new Error('Replacement must preserve byte length.');

  const result = Buffer.from(content);
  for (let offset = result.indexOf(source); offset !== -1; offset = result.indexOf(source, offset + source.length)) {
    replacement.copy(result, offset);
  }
  return result;
}
