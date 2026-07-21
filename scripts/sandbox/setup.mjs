import { createInterface } from 'node:readline/promises';
import { stdin as input, stdout as output } from 'node:process';
import {
  CONFIG_FILE,
  DEFAULT_CERTIFICATE_TITLE,
  DEFAULT_REDIRECT_URI,
  PRIVATE_KEY_FILE,
  PUBLIC_CERT_FILE,
  SANDBOX_SETTINGS_URL,
  TOKEN_FILE,
  copyToClipboard,
  deleteFileIfPresent,
  exchangeAuthorizationCode,
  extractAuthorizationCode,
  formatFailure,
  generateOrReuseCertificate,
  getAccounts,
  issuerFromRedirectUri,
  loadSandboxConfig,
  maskClientId,
  openBrowser,
  printAccounts,
  readJson,
  saveSandboxConfig,
  validateClientId
} from './shared.mjs';

const rl = createInterface({ input, output });

try {
  printBanner();
  await requireAcknowledgement();

  const certificate = await generateOrReuseCertificate();
  console.log(certificate.created
    ? '\nCreated a new Sandbox-only X.509 certificate pair.'
    : '\nFound and verified the existing Sandbox certificate pair.');
  console.log(`Private key: ${PRIVATE_KEY_FILE}`);
  console.log(`Public certificate: ${PUBLIC_CERT_FILE}`);
  console.log('The private key must stay on this computer and must never be pasted into Revolut.');

  const copied = copyToClipboard(certificate.publicCertificate);
  console.log(copied
    ? '\nThe PUBLIC certificate is now copied to the Windows clipboard.'
    : '\nThe public certificate could not be copied automatically. Open publiccert.cer in Notepad and copy all of it.');

  const existingConfig = await readJson(CONFIG_FILE);
  let config;
  if (existingConfig) {
    const answer = (await rl.question(`\nUse the saved Sandbox ClientID ${maskClientId(existingConfig.clientId)}? [Y/n]: `)).trim().toLowerCase();
    if (answer === '' || answer === 'y' || answer === 'yes') {
      config = await loadSandboxConfig();
    }
  }

  if (!config) {
    printCertificateScreenInstructions();
    openBrowser(SANDBOX_SETTINGS_URL);
    await rl.question('\nPress Enter only after you clicked Continue and can see ClientID: ');

    let clientId;
    while (!clientId) {
      try {
        clientId = validateClientId(await rl.question('Paste ClientID here, then press Enter: '));
      } catch (error) {
        console.log(`Please try again: ${formatFailure(error)}`);
      }
    }

    config = await saveSandboxConfig({ clientId, redirectUri: DEFAULT_REDIRECT_URI });
    console.log(`\nSaved the Sandbox configuration. JWT issuer: ${issuerFromRedirectUri(config.redirectUri)}`);
  }

  const existingTokens = await readJson(TOKEN_FILE);
  let setupComplete = false;
  if (existingTokens?.refreshToken) {
    while (!setupComplete) {
      const answer = (await rl.question('\nSaved Sandbox authorization exists. Type TEST, NEW, or QUIT: ')).trim().toUpperCase();
      if (answer === 'QUIT') {
        console.log('\nNo authorization changes were made.');
        setupComplete = true;
      } else if (answer === 'NEW') {
        await deleteFileIfPresent(TOKEN_FILE);
        await completeConsent(config);
        await showAccounts();
        printSuccess();
        setupComplete = true;
      } else if (answer === 'TEST') {
        try {
          await showAccounts();
          printSuccess();
          setupComplete = true;
        } catch (error) {
          console.log(`\nThe saved authorization did not work:\n${formatFailure(error)}`);
          console.log('Choose NEW to grant access again, or QUIT to stop without changing the certificate.');
        }
      } else {
        console.log('Please type TEST, NEW, or QUIT.');
      }
    }
  } else {
    await completeConsent(config);
    await showAccounts();
    printSuccess();
  }
} catch (error) {
  console.error(`\nSETUP STOPPED\n${formatFailure(error)}`);
  console.error('\nNo Production API URL was used. Fix the stated item, then run: npm run sandbox:setup');
  process.exitCode = 1;
} finally {
  rl.close();
}

function printBanner() {
  console.log('============================================================');
  console.log(' REVOLUTE — Revolut Business Sandbox guided setup');
  console.log('============================================================');
  console.log('This wizard is locked to Revolut Sandbox addresses.');
  console.log('It will not contact the Revolut Production API.');
  console.log('It stores Sandbox secrets only under .secrets/sandbox/.');
}

async function requireAcknowledgement() {
  console.log('\nSafety rule: never share privatecert.pem, access tokens, refresh tokens, or authorization codes.');
  const answer = (await rl.question('Type SANDBOX to continue: ')).trim();
  if (answer !== 'SANDBOX') throw new Error('The word SANDBOX was not entered.');
}

function printCertificateScreenInstructions() {
  console.log('\nA Sandbox Business API settings page will open. Use these exact values:');
  console.log(`  Certificate title: ${DEFAULT_CERTIFICATE_TITLE}`);
  console.log(`  OAuth redirect URI: ${DEFAULT_REDIRECT_URI}`);
  console.log('  X509 public key: press Ctrl+V to paste the PUBLIC certificate');
  console.log('\nOn the website:');
  console.log(`  Settings page: ${SANDBOX_SETTINGS_URL}`);
  console.log('  1. Confirm the address starts with https://sandbox-business.revolut.com/');
  console.log('  2. Open APIs, then Business API.');
  console.log('  3. Click Add API certificate or Add new.');
  console.log('  4. Fill the three fields above.');
  console.log('  5. Click Continue.');
  console.log('  6. Copy ClientID. Do not copy a different ID.');
}

async function completeConsent(config) {
  console.log('\nNow grant the application access in the Sandbox website:');
  console.log('  1. Stay on the API Certificate details page.');
  console.log('  2. Click Enable access.');
  console.log('  3. Click Authorise and complete the Sandbox approval steps.');
  console.log(`  4. The browser will redirect to ${config.redirectUri}.`);
  console.log('  5. The page itself may show an error. That is okay for this test.');
  console.log('  6. Click the browser address bar, press Ctrl+A, then Ctrl+C.');
  console.log('  7. Return here immediately. The code is valid for only two minutes.');

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const pasted = await rl.question('\nPaste the entire browser address here, then press Enter: ');
      const code = extractAuthorizationCode(pasted);
      console.log('Exchanging the short-lived code with Revolut Sandbox…');
      await exchangeAuthorizationCode(code, config);
      console.log('Sandbox access and refresh tokens were saved without displaying them.');
      return;
    } catch (error) {
      console.log(`\nAuthorization attempt ${attempt} did not succeed.`);
      console.log(formatFailure(error));
      if (attempt < 3) {
        console.log('Return to the certificate page, click Enable access again, authorise again, and paste the new browser address.');
      }
    }
  }
  throw new Error('Authorization did not succeed after three attempts.');
}

async function showAccounts() {
  console.log('\nTesting GET /accounts against Revolut Sandbox…');
  const accounts = await getAccounts();
  printAccounts(accounts);
}

function printSuccess() {
  console.log('\nSUCCESS: Revolut Sandbox authentication and GET /accounts both worked.');
  console.log('This proves Sandbox connectivity only. It does not enable Production and it does not send a payment.');
}
