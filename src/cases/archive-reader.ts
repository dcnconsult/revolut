import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { sha256 } from './canonical.js';
import type { MalwareScanner } from './malware-scanner.js';

export type ArchiveValidationFailureCode =
  | 'ARCHIVE_NOT_ZIP'
  | 'ARCHIVE_STRUCTURE_INVALID'
  | 'ARCHIVE_LIMIT_EXCEEDED'
  | 'ARCHIVE_PATH_UNSAFE'
  | 'ARCHIVE_DUPLICATE_PATH'
  | 'ARCHIVE_COMPRESSION_RATIO_EXCEEDED'
  | 'UNSUPPORTED_ARTIFACT_TYPE';

export class ArchiveValidationError extends Error {
  constructor(
    readonly code: ArchiveValidationFailureCode,
    message: string
  ) {
    super(message);
    this.name = 'ArchiveValidationError';
  }
}

export interface ArchiveLimits {
  maximumZipBytes: number;
  maximumEntries: number;
  maximumEntryBytes: number;
  maximumTotalBytes: number;
  maximumCompressionRatio: number;
}

export interface InspectedEntry {
  path: string;
  normalizedPath: string;
  mediaType: string;
  content: Buffer;
  byteLength: number;
  sha256: string;
  scanStatus: 'CLEAN' | 'INFECTED' | 'UNAVAILABLE';
}

export interface InspectedArchive {
  entries: InspectedEntry[];
  packageSha256: string;
  scanner: 'CLEAN' | 'INFECTED' | 'UNAVAILABLE';
}

const executableExtensions = new Set([
  '.exe', '.dll', '.com', '.bat', '.cmd', '.ps1', '.sh', '.js', '.mjs', '.cjs',
  '.msi', '.scr', '.jar', '.app', '.dmg', '.so'
]);
const archiveExtensions = new Set([
  '.zip', '.7z', '.rar', '.tar', '.gz', '.bz2', '.xz', '.tgz'
]);

export async function inspectArchive(
  packageContent: Buffer,
  limits: ArchiveLimits,
  scanner: MalwareScanner
): Promise<InspectedArchive> {
  if (packageContent.length > limits.maximumZipBytes) {
    throw validationError(
      'ARCHIVE_LIMIT_EXCEEDED',
      `ZIP exceeds the ${limits.maximumZipBytes} byte intake limit.`
    );
  }
  if (!hasZipSignature(packageContent)) {
    throw validationError('ARCHIVE_NOT_ZIP', 'Submission is not a ZIP archive.');
  }

  const zip = await openZip(packageContent);
  const entries: InspectedEntry[] = [];
  const normalizedNames = new Set<string>();
  let totalBytes = 0;
  let scannerState: InspectedArchive['scanner'] = 'CLEAN';

  try {
    if (zip.entryCount > limits.maximumEntries) {
      throw validationError(
        'ARCHIVE_LIMIT_EXCEEDED',
        `ZIP contains more than ${limits.maximumEntries} entries.`
      );
    }

    for (;;) {
      const entry = await nextEntry(zip);
      if (!entry) break;

      const directory = entry.fileName.endsWith('/');
      const normalizedPath = normalizeEntryName(directory ? entry.fileName.slice(0, -1) : entry.fileName);
      const duplicateKey = normalizedPath.toLocaleLowerCase('en-US');
      if (normalizedNames.has(duplicateKey)) {
        throw validationError(
          'ARCHIVE_DUPLICATE_PATH',
          `ZIP contains duplicate normalized path ${normalizedPath}.`
        );
      }
      normalizedNames.add(duplicateKey);
      validateEntryMetadata(entry, limits);
      if (directory) continue;

      if (entries.length >= limits.maximumEntries) {
        throw validationError(
          'ARCHIVE_LIMIT_EXCEEDED',
          `ZIP contains more than ${limits.maximumEntries} files.`
        );
      }

      const extension = extensionOf(normalizedPath);
      if (archiveExtensions.has(extension)) {
        throw validationError(
          'UNSUPPORTED_ARTIFACT_TYPE',
          `Nested archive ${normalizedPath} is not allowed.`
        );
      }
      if (executableExtensions.has(extension)) {
        throw validationError(
          'UNSUPPORTED_ARTIFACT_TYPE',
          `Executable content ${normalizedPath} is not allowed.`
        );
      }

      totalBytes += entry.uncompressedSize;
      if (totalBytes > limits.maximumTotalBytes) {
        throw validationError(
          'ARCHIVE_LIMIT_EXCEEDED',
          `ZIP uncompressed content exceeds ${limits.maximumTotalBytes} bytes.`
        );
      }

      const content = await readEntry(zip, entry, limits.maximumEntryBytes);
      const scan = await scanner.scan(content, normalizedPath);
      if (scan.status === 'INFECTED') scannerState = 'INFECTED';
      else if (scan.status === 'UNAVAILABLE' && scannerState !== 'INFECTED') scannerState = 'UNAVAILABLE';

      entries.push({
        path: entry.fileName,
        normalizedPath,
        mediaType: mediaType(normalizedPath),
        content,
        byteLength: content.length,
        sha256: sha256(content),
        scanStatus: scan.status
      });
    }
  } finally {
    zip.close();
  }

  // Do not interpret artifacts until every archive entry has received a clean
  // malware result. Diagnostic intake can still inventory malformed JSON/XML.
  if (scannerState === 'CLEAN') {
    for (const entry of entries) {
      validateArtifactType(entry.normalizedPath, entry.content);
    }
  }

  if (entries.length === 0) {
    throw validationError('ARCHIVE_STRUCTURE_INVALID', 'ZIP contains no files.');
  }
  return { entries, packageSha256: sha256(packageContent), scanner: scannerState };
}

function hasZipSignature(content: Buffer) {
  return content[0] === 0x50 && content[1] === 0x4b;
}

function openZip(content: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    try {
      yauzl.fromBuffer(content, {
        lazyEntries: true,
        decodeStrings: true,
        validateEntrySizes: true,
        strictFileNames: true
      }, (error, zip) => {
        if (error || !zip) {
          reject(asArchiveValidationError(
            error,
            'ARCHIVE_STRUCTURE_INVALID',
            'ZIP structure is invalid.'
          ));
          return;
        }
        resolve(zip);
      });
    } catch (error) {
      reject(asArchiveValidationError(error, 'ARCHIVE_STRUCTURE_INVALID', 'ZIP structure is invalid.'));
    }
  });
}

function nextEntry(zip: ZipFile): Promise<Entry | undefined> {
  return new Promise((resolve, reject) => {
    const onEntry = (entry: Entry) => {
      cleanup();
      resolve(entry);
    };
    const onEnd = () => {
      cleanup();
      resolve(undefined);
    };
    const onError = (error: Error) => {
      cleanup();
      reject(asArchiveValidationError(error, 'ARCHIVE_STRUCTURE_INVALID', 'ZIP structure is invalid.'));
    };
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    try {
      zip.readEntry();
    } catch (error) {
      onError(asError(error));
    }
  });
}

function readEntry(zip: ZipFile, entry: Entry, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(asArchiveValidationError(
        error,
        'ARCHIVE_STRUCTURE_INVALID',
        `Could not read ZIP entry ${entry.fileName}.`
      ));
    };
    const succeed = (content: Buffer) => {
      if (settled) return;
      settled = true;
      resolve(content);
    };

    try {
      zip.openReadStream(entry, (error, stream) => {
        if (error || !stream) {
          fail(error);
          return;
        }
        const chunks: Buffer[] = [];
        let length = 0;
        stream.on('data', (chunk: Buffer) => {
          length += chunk.length;
          if (length > maximumBytes) {
            stream.destroy(validationError(
              'ARCHIVE_LIMIT_EXCEEDED',
              `Entry ${entry.fileName} exceeds size limit.`
            ));
            return;
          }
          chunks.push(chunk);
        });
        stream.once('error', fail);
        stream.once('end', () => {
          try {
            succeed(Buffer.concat(chunks, length));
          } catch (error) {
            fail(error);
          }
        });
      });
    } catch (error) {
      fail(error);
    }
  });
}

function validateEntryMetadata(entry: Entry, limits: ArchiveLimits) {
  if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
      !Number.isSafeInteger(entry.compressedSize) || entry.compressedSize < 0) {
    throw validationError('ARCHIVE_STRUCTURE_INVALID', `ZIP entry ${entry.fileName} has invalid size metadata.`);
  }
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw validationError('ARCHIVE_STRUCTURE_INVALID', `Encrypted ZIP entry ${entry.fileName} is not allowed.`);
  }
  if (entry.uncompressedSize > limits.maximumEntryBytes) {
    throw validationError(
      'ARCHIVE_LIMIT_EXCEEDED',
      `ZIP entry ${entry.fileName} exceeds ${limits.maximumEntryBytes} bytes.`
    );
  }
  if (entry.compressedSize === 0 && entry.uncompressedSize > 0) {
    throw validationError(
      'ARCHIVE_COMPRESSION_RATIO_EXCEEDED',
      `ZIP entry ${entry.fileName} has an invalid compression ratio.`
    );
  }
  if (entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > limits.maximumCompressionRatio) {
    throw validationError(
      'ARCHIVE_COMPRESSION_RATIO_EXCEEDED',
      `ZIP entry ${entry.fileName} exceeds the compression-ratio limit.`
    );
  }
  const unixMode = entry.externalFileAttributes >>> 16;
  if ((unixMode & 0o170000) === 0o120000) {
    throw validationError('ARCHIVE_PATH_UNSAFE', `Symbolic link ${entry.fileName} is not allowed.`);
  }
}

function normalizeEntryName(name: string) {
  if (!name || name.includes('\0') || name.includes('\\')) {
    throw validationError('ARCHIVE_PATH_UNSAFE', `Unsafe ZIP path ${name}.`);
  }
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) {
    throw validationError('ARCHIVE_PATH_UNSAFE', `Absolute ZIP path ${name} is not allowed.`);
  }
  const parts = name.normalize('NFC').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw validationError('ARCHIVE_PATH_UNSAFE', `Unsafe ZIP path ${name}.`);
  }
  return parts.join('/');
}

function validateArtifactType(path: string, content: Buffer) {
  const extension = extensionOf(path);
  if (content.subarray(0, 2).toString('ascii') === 'MZ' ||
      content.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw validationError('UNSUPPORTED_ARTIFACT_TYPE', `Executable magic bytes found in ${path}.`);
  }
  if (content.subarray(0, 4).toString('binary').startsWith('PK\u0003\u0004')) {
    throw validationError('UNSUPPORTED_ARTIFACT_TYPE', `Nested archive content ${path} is not allowed.`);
  }
  if (extension === '.pdf' && content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw validationError('UNSUPPORTED_ARTIFACT_TYPE', `PDF extension/magic mismatch for ${path}.`);
  }
}

function extensionOf(path: string) {
  const name = path.toLowerCase();
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index);
}

function mediaType(path: string) {
  const extension = extensionOf(path);
  return ({
    '.json': 'application/json',
    '.pdf': 'application/pdf',
    '.csv': 'text/csv',
    '.md': 'text/markdown',
    '.txt': 'text/plain',
    '.xml': 'application/xml'
  } as Record<string, string>)[extension] ?? 'application/octet-stream';
}

function validationError(code: ArchiveValidationFailureCode, message: string) {
  return new ArchiveValidationError(code, message);
}

function asArchiveValidationError(
  error: unknown,
  fallbackCode: ArchiveValidationFailureCode,
  fallbackMessage: string
) {
  if (error instanceof ArchiveValidationError) return error;
  if (isUnsafePathError(error)) {
    return validationError('ARCHIVE_PATH_UNSAFE', 'ZIP contains an unsafe entry path.');
  }
  return validationError(fallbackCode, fallbackMessage);
}

function isUnsafePathError(error: unknown) {
  const message = error instanceof Error ? error.message : '';
  return /(?:invalid|unsafe) relative path|(?:invalid )?(?:file ?name|filename).*?(?:\\\\|\/|\.\.)|backslash/i.test(message);
}

function asError(error: unknown) {
  return error instanceof Error ? error : validationError('ARCHIVE_STRUCTURE_INVALID', 'ZIP structure is invalid.');
}
