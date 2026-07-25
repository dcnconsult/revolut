import { createHash } from 'node:crypto';
import yazl from 'yazl';

export async function legacyAssetDeclarationPackage() {
  const contract = Buffer.from(JSON.stringify({
    asset: {
      ticker: 'ETH',
      network: 'Ethereum Mainnet'
    },
    balance: {
      amount: '14073.648011944244',
      wei: '14073648011944244000000'
    },
    compliance: {
      kyc_aml_status: 'CLEARED',
      screening_reference: null
    },
    valuation: {
      source: 'Manual declaration'
    }
  }));
  const rpcInterface = Buffer.from(JSON.stringify({
    verification_workflow: {
      step_2_balance: {
        expect_wei: '14073648011944244000000',
        expect_hex: '0x2faa35db1d4b6acf880'
      }
    }
  }));
  const declaration = Buffer.from('field,value\nasset_type,Native ETH\nstatus,CONFIRMED\n');
  const manifest = Buffer.from(JSON.stringify({
    package: 'ETH_ASSET_DECLARATION',
    version: '1.0.0',
    files: {
      'contract.json': inventory(contract),
      'interface.json': inventory(rpcInterface),
      'declaration.csv': {
        size_bytes: declaration.length + 17,
        sha256: '0'.repeat(64)
      },
      'missing-proof.json': {
        size_bytes: 100,
        sha256: '1'.repeat(64)
      },
      'missing-instructions.xml': {
        size_bytes: 100,
        sha256: '2'.repeat(64)
      }
    }
  }));

  return zipBuffer([
    ['manifest.json', manifest],
    ['contract.json', contract],
    ['interface.json', rpcInterface],
    ['declaration.csv', declaration],
    ['undeclared-evidence.pdf', Buffer.from('%PDF-1.4\n%%EOF\n')]
  ]);
}

function inventory(content: Buffer) {
  return {
    size_bytes: content.length,
    sha256: createHash('sha256').update(content).digest('hex')
  };
}

function zipBuffer(entries: Array<[string, Buffer]>) {
  return new Promise<Buffer>((resolve, reject) => {
    const zip = new yazl.ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on('data', (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.once('error', reject);
    zip.outputStream.once('end', () => resolve(Buffer.concat(chunks)));
    for (const [name, content] of entries) {
      zip.addBuffer(content, name, {
        compress: false,
        mtime: new Date('2026-07-25T00:00:00Z'),
        mode: 0o100644
      });
    }
    zip.end();
  });
}
