import { TextDecoder } from 'node:util';
import yauzl, { type Entry, type ZipFile } from 'yauzl';
import { strictJsonParse, sha256 } from './canonical.js';
import type { MalwareScanner } from './malware-scanner.js';

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
    throw new Error(`ZIP exceeds the ${limits.maximumZipBytes} byte intake limit.`);
  }
  if (!(packageContent[0] === 0x50 && packageContent[1] === 0x4b)) {
    throw new Error('Submission is not a ZIP archive.');
  }
  const zip = await openZip(packageContent);
  if (zip.entryCount > limits.maximumEntries) {
    zip.close();
    throw new Error(`ZIP contains more than ${limits.maximumEntries} entries.`);
  }
  const entries: InspectedEntry[] = [];
  const normalizedNames = new Set<string>();
  let totalBytes = 0;
  let scannerState: InspectedArchive['scanner'] = 'CLEAN';
  try {
    for (;;) {
      const entry = await nextEntry(zip);
      if (!entry) break;
      if (/\/$/.test(entry.fileName)) continue;
      if (entries.length >= limits.maximumEntries) {
        throw new Error(`ZIP contains more than ${limits.maximumEntries} files.`);
      }
      validateEntryMetadata(entry, limits);
      const normalizedPath = normalizeEntryName(entry.fileName);
      const duplicateKey = normalizedPath.toLocaleLowerCase('en-US');
      if (normalizedNames.has(duplicateKey)) {
        throw new Error(`ZIP contains duplicate normalized path ${normalizedPath}.`);
      }
      normalizedNames.add(duplicateKey);
      const extension = extensionOf(normalizedPath);
      if (archiveExtensions.has(extension)) throw new Error(`Nested archive ${normalizedPath} is not allowed.`);
      if (executableExtensions.has(extension)) throw new Error(`Executable content ${normalizedPath} is not allowed.`);
      totalBytes += entry.uncompressedSize;
      if (totalBytes > limits.maximumTotalBytes) {
        throw new Error(`ZIP uncompressed content exceeds ${limits.maximumTotalBytes} bytes.`);
      }
      const content = await readEntry(zip, entry, limits.maximumEntryBytes);
      validateMagic(normalizedPath, content);
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
  if (entries.length === 0) throw new Error('ZIP contains no files.');
  return { entries, packageSha256: sha256(packageContent), scanner: scannerState };
}

function openZip(content: Buffer): Promise<ZipFile> {
  return new Promise((resolve, reject) => {
    yauzl.fromBuffer(content, {
      lazyEntries: true,
      decodeStrings: true,
      validateEntrySizes: true,
      strictFileNames: true
    }, (error, zip) => error || !zip ? reject(error ?? new Error('Could not open ZIP.')) : resolve(zip));
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
      reject(error);
    };
    const cleanup = () => {
      zip.off('entry', onEntry);
      zip.off('end', onEnd);
      zip.off('error', onError);
    };
    zip.once('entry', onEntry);
    zip.once('end', onEnd);
    zip.once('error', onError);
    zip.readEntry();
  });
}

function readEntry(zip: ZipFile, entry: Entry, maximumBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    zip.openReadStream(entry, (error, stream) => {
      if (error || !stream) {
        reject(error ?? new Error(`Could not stream ${entry.fileName}.`));
        return;
      }
      const chunks: Buffer[] = [];
      let length = 0;
      stream.on('data', (chunk: Buffer) => {
        length += chunk.length;
        if (length > maximumBytes) stream.destroy(new Error(`Entry ${entry.fileName} exceeds size limit.`));
        else chunks.push(chunk);
      });
      stream.once('error', reject);
      stream.once('end', () => resolve(Buffer.concat(chunks, length)));
    });
  });
}

function validateEntryMetadata(entry: Entry, limits: ArchiveLimits) {
  if ((entry.generalPurposeBitFlag & 0x1) !== 0) {
    throw new Error(`Encrypted ZIP entry ${entry.fileName} is not allowed.`);
  }
  if (entry.uncompressedSize > limits.maximumEntryBytes) {
    throw new Error(`ZIP entry ${entry.fileName} exceeds ${limits.maximumEntryBytes} bytes.`);
  }
  if (entry.compressedSize === 0 && entry.uncompressedSize > 0) {
    throw new Error(`ZIP entry ${entry.fileName} has an invalid compression ratio.`);
  }
  if (entry.compressedSize > 0 &&
      entry.uncompressedSize / entry.compressedSize > limits.maximumCompressionRatio) {
    throw new Error(`ZIP entry ${entry.fileName} exceeds the compression-ratio limit.`);
  }
  const unixMode = entry.externalFileAttributes >>> 16;
  if ((unixMode & 0o170000) === 0o120000) {
    throw new Error(`Symbolic link ${entry.fileName} is not allowed.`);
  }
}

function normalizeEntryName(name: string) {
  if (!name || name.includes('\0') || name.includes('\\')) throw new Error(`Unsafe ZIP path ${name}.`);
  if (name.startsWith('/') || /^[A-Za-z]:/.test(name)) throw new Error(`Absolute ZIP path ${name} is not allowed.`);
  const parts = name.normalize('NFC').split('/');
  if (parts.some(part => !part || part === '.' || part === '..' || part.includes(':'))) {
    throw new Error(`Unsafe ZIP path ${name}.`);
  }
  return parts.join('/');
}

function extensionOf(path: string) {
  const name = path.toLowerCase();
  const index = name.lastIndexOf('.');
  return index === -1 ? '' : name.slice(index);
}

function decodeUtf8(content: Buffer, path: string) {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    throw new Error(`Text artifact ${path} is not valid UTF-8.`);
  }
}

function validateMagic(path: string, content: Buffer) {
  const extension = extensionOf(path);
  if (content.subarray(0, 2).toString('ascii') === 'MZ' ||
      content.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46]))) {
    throw new Error(`Executable magic bytes found in ${path}.`);
  }
  if (content.subarray(0, 4).toString('binary').startsWith('PK\u0003\u0004')) {
    throw new Error(`Nested archive content ${path} is not allowed.`);
  }
  if (extension === '.pdf' && content.subarray(0, 5).toString('ascii') !== '%PDF-') {
    throw new Error(`PDF extension/magic mismatch for ${path}.`);
  }
  if (extension === '.json') {
    strictJsonParse(decodeUtf8(content, path));
  }
  if (['.md', '.txt', '.csv', '.xml'].includes(extension)) {
    const text = decodeUtf8(content, path);
    if (extension === '.xml' && !text.trimStart().startsWith('<')) {
      throw new Error(`XML extension/content mismatch for ${path}.`);
    }
  }
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
