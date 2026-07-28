import { readFileSync } from 'node:fs';
import type { ServerOptions as HttpsServerOptions } from 'node:https';

export type AppTransport = 'http' | 'https' | 'mtls';

export interface ServerConnectionConfig {
  transport: AppTransport;
  trustProxy: string;
  tlsCertificatePath?: string;
  tlsPrivateKeyPath?: string;
  tlsClientCaPath?: string;
  tlsPrivateKeyPassphrasePath?: string;
}

export interface ServerConnectionOptions {
  trustProxy: boolean | string[];
  https?: HttpsServerOptions;
}

export function buildServerConnectionOptions(
  config: ServerConnectionConfig
): ServerConnectionOptions {
  const trustProxy = parseTrustProxy(config.trustProxy);
  if (config.transport === 'http') {
    if (hasTlsSetting(config)) {
      throw new Error(
        'APP_TRANSPORT=http cannot be combined with APP_TLS_* paths. ' +
        'Use APP_TRANSPORT=https/mtls or remove the TLS settings.'
      );
    }
    return { trustProxy };
  }

  const keyPath = requiredPath(config.tlsPrivateKeyPath, 'APP_TLS_KEY_PATH');
  const certificatePath = requiredPath(config.tlsCertificatePath, 'APP_TLS_CERT_PATH');
  const https: HttpsServerOptions = {
    key: readRequiredFile(keyPath, 'TLS private key'),
    cert: readRequiredFile(certificatePath, 'TLS certificate'),
    minVersion: 'TLSv1.2'
  };

  if (config.tlsPrivateKeyPassphrasePath) {
    https.passphrase = readRequiredFile(
      config.tlsPrivateKeyPassphrasePath,
      'TLS private-key passphrase'
    ).toString('utf8').trimEnd();
  }

  if (config.transport === 'mtls') {
    const clientCaPath = requiredPath(config.tlsClientCaPath, 'APP_TLS_CLIENT_CA_PATH');
    https.ca = readRequiredFile(clientCaPath, 'TLS client CA');
    https.requestCert = true;
    https.rejectUnauthorized = true;
  } else if (config.tlsClientCaPath) {
    throw new Error('APP_TLS_CLIENT_CA_PATH requires APP_TRANSPORT=mtls.');
  }

  return { trustProxy, https };
}

export function parseTrustProxy(value: string): false | string[] {
  const proxies = value.split(',').map(entry => entry.trim()).filter(Boolean);
  return proxies.length === 0 ? false : proxies;
}

export function shouldUseSecureCookies(configured: boolean, transport: AppTransport) {
  return configured || transport !== 'http';
}

function hasTlsSetting(config: ServerConnectionConfig) {
  return Boolean(
    config.tlsCertificatePath ||
    config.tlsPrivateKeyPath ||
    config.tlsClientCaPath ||
    config.tlsPrivateKeyPassphrasePath
  );
}

function requiredPath(value: string | undefined, name: string) {
  const normalized = value?.trim();
  if (!normalized) throw new Error(`${name} is required for the selected APP_TRANSPORT.`);
  return normalized;
}

function readRequiredFile(path: string, description: string) {
  try {
    const value = readFileSync(path);
    if (value.length === 0) throw new Error('file is empty');
    return value;
  } catch (error) {
    throw new Error(
      `Could not read ${description} file at ${path}: ` +
      `${error instanceof Error ? error.message : String(error)}`
    );
  }
}
