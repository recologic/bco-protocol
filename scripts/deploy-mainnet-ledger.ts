/**
 * BCO Protocol — Mainnet Deployment with Ledger + Feee.io Energy
 *
 * Signs all transactions on the Ledger hardware wallet.
 * Buys energy from feee.io before each transaction (10-min rentals, cheapest option).
 * The private key NEVER leaves the device.
 *
 * Prerequisites:
 *   1. Ledger Nano S Plus connected via USB
 *   2. TRON app open on the Ledger
 *   3. In TRON app settings: enable "Allow contract data" and "Sign by hash"
 *   4. TRX balance on the Ledger address (at least 1500 TRX)
 *   5. npx hardhat compile (artifacts must exist)
 *   6. Feee.io API key with IP + User-Agent whitelisted
 *
 * Usage: npx ts-node scripts/deploy-mainnet-ledger.ts
 */

import { TronWeb } from 'tronweb';
// eslint-disable-next-line @typescript-eslint/no-var-requires
const TransportNodeHid = require('@ledgerhq/hw-transport-node-hid');
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Trx = require('@ledgerhq/hw-app-trx');
import * as fs from 'fs';
import * as path from 'path';

// ─── Configuration ──────────────────────────────

const TRON_FULL_NODE = 'https://api.trongrid.io';
const TRON_SOLIDITY_NODE = 'https://api.trongrid.io';
const TRON_EVENT_SERVER = 'https://api.trongrid.io';

const BIP44_PATH = "44'/195'/0'/0/0";
const ADMIN_DELAY = 172800;    // 48 hours
const TIMELOCK_DELAY = 259200; // 72 hours
const REWARD_DURATION = 7776000; // 90 days
const FEE_LIMIT = 15_000_000_000; // 15,000 TRX

// Feee.io
const FEEE_API_KEY = process.env.FEEE_API_KEY ?? '';
const FEEE_USER_AGENT = process.env.FEEE_USER_AGENT ?? '';
const FEEE_API_URL = 'https://feee.io/open/v2';

// Issuer info — set via environment or configure before deploy
const ISSUER_NAME = process.env.ISSUER_NAME ?? '';
const ISSUER_REG = process.env.ISSUER_REGISTRATION ?? '';
const ISSUER_COUNTRY = process.env.ISSUER_COUNTRY ?? '';

// Energy estimates per operation (from Nile testnet + 10% margin)
const ENERGY = {
  BCO_TOKEN_DEPLOY: 2_210_000,
  TIMELOCK_DEPLOY: 1_600_000,
  DEED_REGISTRY_IMPL: 3_620_000,
  DEED_REGISTRY_PROXY: 340_000,
  BCO_STAKING_IMPL: 3_360_000,
  BCO_STAKING_PROXY: 340_000,
  FUNCTION_CALL: 100_000, // grantRole, setTimelock, setIssuerInfo each
};

// ─── Helpers ────────────────────────────────────

function loadArtifact(contractPath: string) {
  const fullPath = path.join(__dirname, '..', 'artifacts', 'contracts', contractPath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function loadOZArtifact(contractPath: string) {
  const fullPath = path.join(__dirname, '..', 'artifacts', '@openzeppelin', contractPath);
  return JSON.parse(fs.readFileSync(fullPath, 'utf8'));
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConfirmation(tronWeb: TronWeb, txId: string, label: string) {
  process.stdout.write(`  Waiting: ${label}...`);
  for (let i = 0; i < 60; i++) {
    await sleep(3000);
    try {
      const info = await tronWeb.trx.getTransactionInfo(txId);
      if (info && Object.keys(info).length > 0) {
        if (info.result === 'FAILED') {
          console.log(' FAILED');
          throw new Error(`Transaction FAILED: ${txId}\n  Reason: ${Buffer.from(info.resMessage || '', 'hex').toString()}`);
        }
        console.log(` OK (block ${info.blockNumber})`);
        return info;
      }
    } catch (e: any) {
      if (e.message?.includes('FAILED')) throw e;
    }
  }
  throw new Error(`Transaction not confirmed after 3 min: ${txId}`);
}

// ─── Feee.io Energy ─────────────────────────────

let totalEnergySpent = 0;
let totalEnergyCost = 0;

async function buyEnergy(receiverAddress: string, energyAmount: number, label: string) {
  console.log(`\n  Buying ${energyAmount.toLocaleString()} energy for "${label}"...`);

  // Get price first
  const priceRes = await fetch(
    `${FEEE_API_URL}/order/price?resource_value=${energyAmount}&rent_duration=10&rent_time_unit=m`,
    { headers: { key: FEEE_API_KEY, 'User-Agent': FEEE_USER_AGENT } },
  );
  const priceData = await priceRes.json();

  if (priceData.code !== 0) {
    throw new Error(`Feee.io price query failed: ${priceData.msg}`);
  }

  const cost = priceData.data.pay_amount;
  console.log(`  Price: ${cost} TRX (${priceData.data.price_in_sun} sun/energy)`);

  // Create order
  const orderRes = await fetch(`${FEEE_API_URL}/order/submit`, {
    method: 'POST',
    headers: {
      key: FEEE_API_KEY,
      'User-Agent': FEEE_USER_AGENT,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      resource_type: 1, // energy
      receive_address: receiverAddress,
      resource_value: energyAmount,
      rent_duration: 10,
      rent_time_unit: 'm',
    }),
  });
  const orderData = await orderRes.json();

  if (orderData.code !== 0) {
    if (orderData.msg?.includes('Insufficient') || orderData.msg?.includes('balance')) {
      throw new Error(
        `Feee.io: Saldo insuficiente.\n` +
        `  Precisa de ${cost} TRX para esta operacao.\n` +
        `  Deposite TRX na feee.io via DAPP Payment (TronLink + Ledger) e rode o script novamente.\n` +
        `  O script retoma de onde parou.`,
      );
    }
    throw new Error(`Feee.io order failed: ${orderData.msg}`);
  }

  console.log(`  Order created: ${orderData.data?.order_no || 'OK'} — ${cost} TRX`);

  // Wait for energy to arrive (typically 10-30 seconds)
  console.log('  Waiting for energy delivery...');
  await sleep(15000);

  totalEnergySpent += energyAmount;
  totalEnergyCost += cost;

  return cost;
}

// ─── Ledger Signing ─────────────────────────────

async function signWithLedger(ledgerApp: any, tx: any, label: string): Promise<any> {
  console.log(`  >>> Confirm "${label}" on your Ledger <<<`);

  try {
    const signature = await ledgerApp.signTransaction(BIP44_PATH, tx.raw_data_hex, []);
    tx.signature = [signature];
  } catch {
    console.log('  (Using sign-by-hash for large transaction)');
    const signature = await ledgerApp.signTransactionHash(BIP44_PATH, tx.txID);
    tx.signature = [signature];
  }

  return tx;
}

async function deployAndSign(
  tronWeb: TronWeb,
  ledgerApp: any,
  name: string,
  abi: any[],
  bytecode: string,
  params: any[],
  energyEstimate: number,
): Promise<{ address: string; hexAddress: string; txId: string }> {
  console.log(`\n══ Deploying ${name} ══`);

  const deployerHex = tronWeb.defaultAddress.hex! as string;
  const deployerBase58 = tronWeb.defaultAddress.base58 as string;

  // Buy energy
  await buyEnergy(deployerBase58, energyEstimate, `Deploy ${name}`);

  // Build and sign
  const tx = await tronWeb.transactionBuilder.createSmartContract(
    { abi, bytecode, feeLimit: FEE_LIMIT, callValue: 0, parameters: params },
    deployerHex,
  );

  const signed = await signWithLedger(ledgerApp, tx, `Deploy ${name}`);
  const result = await tronWeb.trx.sendRawTransaction(signed);

  if (!result.result) {
    throw new Error(`Deploy ${name} broadcast failed: ${JSON.stringify(result)}`);
  }

  const info = await waitForConfirmation(tronWeb, result.txid, name);
  const hexAddr = info.contract_address;
  const base58Addr = tronWeb.address.fromHex(hexAddr);

  console.log(`  ${name}: ${base58Addr}`);
  return { address: base58Addr, hexAddress: hexAddr, txId: result.txid };
}

async function deployProxyAndSign(
  tronWeb: TronWeb,
  ledgerApp: any,
  name: string,
  implAbi: any[],
  implBytecode: string,
  initParams: any[],
  initParamTypes: string[],
  implEnergy: number,
  proxyEnergy: number,
): Promise<{ proxy: string; proxyHex: string; implementation: string; implementationHex: string }> {
  console.log(`\n══ Deploying ${name} (UUPS Proxy) ══`);

  const deployerHex = tronWeb.defaultAddress.hex! as string;
  const deployerBase58 = tronWeb.defaultAddress.base58 as string;

  // 1. Deploy implementation
  await buyEnergy(deployerBase58, implEnergy, `${name} Implementation`);

  const implTx = await tronWeb.transactionBuilder.createSmartContract(
    { abi: implAbi, bytecode: implBytecode, feeLimit: FEE_LIMIT, callValue: 0, parameters: [] },
    deployerHex,
  );

  const implSigned = await signWithLedger(ledgerApp, implTx, `${name} Implementation`);
  const implResult = await tronWeb.trx.sendRawTransaction(implSigned);
  const implInfo = await waitForConfirmation(tronWeb, implResult.txid, `${name} Impl`);
  const implHex = implInfo.contract_address;
  console.log(`  Implementation: ${tronWeb.address.fromHex(implHex)}`);

  // 2. Encode initialize call
  const initSelector = tronWeb.sha3('initialize(' + initParamTypes.join(',') + ')').substring(0, 10);
  const encodedParams = tronWeb.utils.abi.encodeParams(initParamTypes, initParams);
  const initData = initSelector + encodedParams.substring(2);

  // 3. Deploy ERC1967Proxy
  await buyEnergy(deployerBase58, proxyEnergy, `${name} Proxy`);

  const proxyArtifact = loadOZArtifact('contracts/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json');

  const proxyTx = await tronWeb.transactionBuilder.createSmartContract(
    { abi: proxyArtifact.abi, bytecode: proxyArtifact.bytecode, feeLimit: FEE_LIMIT, callValue: 0, parameters: [implHex, initData] },
    deployerHex,
  );

  const proxySigned = await signWithLedger(ledgerApp, proxyTx, `${name} Proxy`);
  const proxyResult = await tronWeb.trx.sendRawTransaction(proxySigned);
  const proxyInfo = await waitForConfirmation(tronWeb, proxyResult.txid, `${name} Proxy`);
  const proxyHex = proxyInfo.contract_address;

  console.log(`  Proxy: ${tronWeb.address.fromHex(proxyHex)}`);
  return {
    proxy: tronWeb.address.fromHex(proxyHex),
    proxyHex,
    implementation: tronWeb.address.fromHex(implHex),
    implementationHex: implHex,
  };
}

async function triggerAndSign(
  tronWeb: TronWeb,
  ledgerApp: any,
  contractAddress: string,
  functionSelector: string,
  parameters: { type: string; value: any }[],
  label: string,
  buyEnergyForThis: boolean = true,
) {
  if (buyEnergyForThis) {
    await buyEnergy(tronWeb.defaultAddress.base58 as string, ENERGY.FUNCTION_CALL, label);
  }

  const deployerHex = tronWeb.defaultAddress.hex! as string;

  const tx = await tronWeb.transactionBuilder.triggerSmartContract(
    contractAddress,
    functionSelector,
    { feeLimit: 1_000_000_000 },
    parameters,
    deployerHex,
  );

  if (!tx.result?.result) {
    throw new Error(`Build tx failed for ${label}: ${JSON.stringify(tx)}`);
  }

  const signed = await signWithLedger(ledgerApp, tx.transaction, label);
  const result = await tronWeb.trx.sendRawTransaction(signed);

  if (!result.result) {
    throw new Error(`Broadcast failed for ${label}: ${JSON.stringify(result)}`);
  }

  await waitForConfirmation(tronWeb, result.txid, label);
}

// Buy energy for a batch of function calls at once (cheaper than individual)
async function buyEnergyForBatch(address: string, count: number, label: string) {
  const total = ENERGY.FUNCTION_CALL * count;
  await buyEnergy(address, total, `${label} (${count} calls)`);
}

// ─── Main ───────────────────────────────────────

async function main() {
  console.log('═══════════════════════════════════════════════');
  console.log('  BCO Protocol — MAINNET Deployment');
  console.log('  Ledger + Feee.io Energy Optimization');
  console.log('═══════════════════════════════════════════════');
  console.log('');
  console.log('Config:');
  console.log(`  Admin delay:     ${ADMIN_DELAY}s (${ADMIN_DELAY / 3600}h)`);
  console.log(`  Timelock delay:  ${TIMELOCK_DELAY}s (${TIMELOCK_DELAY / 3600}h)`);
  console.log(`  Reward duration: ${REWARD_DURATION}s (${REWARD_DURATION / 86400} days)`);
  console.log(`  Energy provider: feee.io (10-min rentals @ 65 sun/energy)`);

  // ── Connect Ledger ──
  console.log('\nConnecting to Ledger...');
  console.log('  Make sure TRON app is OPEN on your Ledger');

  const TransportClass = TransportNodeHid.default || TransportNodeHid;
  const TrxClass = Trx.default || Trx;
  const transport = await TransportClass.create();
  const ledgerApp = new TrxClass(transport);

  const config = await ledgerApp.getAppConfiguration();
  console.log(`  App version: ${config.version}`);

  if (!config.allowData) {
    throw new Error(
      'Enable these in TRON app > Settings on your Ledger:\n' +
      '  - Allow extra data in transactions → ON\n' +
      '  - Allow unverified contracts → ON\n' +
      '  - Allow hash only transaction → ON',
    );
  }
  console.log(`  Allow extra data: ${config.allowData}`);
  console.log(`  Allow contracts: ${config.allowContract}`);
  console.log(`  Sign by hash: ${config.signByHash}`);

  const { address: ledgerAddress } = await ledgerApp.getAddress(BIP44_PATH, true);
  console.log(`  Ledger address: ${ledgerAddress}`);
  console.log('  (Verify this address on your Ledger screen)');

  // ── Setup TronWeb ──
  const tronWeb = new TronWeb({
    fullNode: TRON_FULL_NODE,
    solidityNode: TRON_SOLIDITY_NODE,
    eventServer: TRON_EVENT_SERVER,
  });

  const ledgerHex = tronWeb.address.toHex(ledgerAddress);
  tronWeb.setAddress(ledgerAddress);

  const balance = await tronWeb.trx.getBalance(ledgerAddress);
  console.log(`  Balance: ${(balance / 1e6).toFixed(2)} TRX`);

  // Only need ~100 TRX in Ledger for bandwidth fees — energy comes from feee.io
  if (balance < 100_000_000) {
    throw new Error('Need at least 100 TRX in Ledger for bandwidth fees');
  }

  // ── Check for partial deployment ──
  const deploymentFile = path.join(__dirname, '..', 'deployment-mainnet.json');
  let prev: any = {};
  if (fs.existsSync(deploymentFile)) {
    prev = JSON.parse(fs.readFileSync(deploymentFile, 'utf8')).contracts ?? {};
    console.log('\nResuming from previous partial deployment...');
  }

  // ── Calculate remaining energy needed ──
  let remainingEnergy = 0;
  if (!prev.BCOToken?.address) remainingEnergy += ENERGY.BCO_TOKEN_DEPLOY;
  if (!prev.TimelockController?.address) remainingEnergy += ENERGY.TIMELOCK_DEPLOY;
  if (!prev.DeedRegistry?.proxy) remainingEnergy += ENERGY.DEED_REGISTRY_IMPL + ENERGY.DEED_REGISTRY_PROXY;
  if (!prev.BCOStaking?.proxy) remainingEnergy += ENERGY.BCO_STAKING_IMPL + ENERGY.BCO_STAKING_PROXY;
  remainingEnergy += ENERGY.FUNCTION_CALL * 4; // roles + timelock (issuerInfo later)

  const estimatedCostTRX = (remainingEnergy * 65) / 1_000_000;

  console.log(`\n── Energy estimate (remaining work) ──`);
  console.log(`  Energy needed:  ${remainingEnergy.toLocaleString()}`);
  console.log(`  Feee.io cost:   ~${estimatedCostTRX.toFixed(0)} TRX (@ 65 sun/energy)`);
  console.log(`  Ledger balance: ${(balance / 1e6).toFixed(2)} TRX (used for bandwidth only)`);
  console.log(`  Make sure you have ~${estimatedCostTRX.toFixed(0)} TRX deposited in feee.io`);
  console.log('');

  // ── 1. Deploy BCOToken (IMMUTABLE) ──
  const tokenArtifact = loadArtifact('token/BCOToken.sol/BCOToken.json');
  let tokenResult: { address: string; hexAddress: string; txId: string };

  if (prev.BCOToken?.address) {
    tokenResult = {
      address: prev.BCOToken.address,
      hexAddress: tronWeb.address.toHex(prev.BCOToken.address),
      txId: 'resumed',
    };
    console.log(`\nBCOToken already deployed: ${tokenResult.address} (skipping)`);
  } else {
    tokenResult = await deployAndSign(
      tronWeb, ledgerApp, 'BCOToken',
      tokenArtifact.abi, tokenArtifact.bytecode,
      [ADMIN_DELAY, ledgerHex, ledgerHex],
      ENERGY.BCO_TOKEN_DEPLOY,
    );
    savePartial(deploymentFile, ledgerAddress, tokenResult, null, null, null);
  }

  // ── 2. Deploy TimelockController ──
  const timelockArtifact = loadOZArtifact(
    'contracts/governance/TimelockController.sol/TimelockController.json',
  );
  const zeroAddress = '410000000000000000000000000000000000000000';
  let timelockResult: { address: string; hexAddress: string; txId: string };

  if (prev.TimelockController?.address) {
    timelockResult = {
      address: prev.TimelockController.address,
      hexAddress: tronWeb.address.toHex(prev.TimelockController.address),
      txId: 'resumed',
    };
    console.log(`\nTimelockController already deployed: ${timelockResult.address} (skipping)`);
  } else {
    timelockResult = await deployAndSign(
      tronWeb, ledgerApp, 'TimelockController',
      timelockArtifact.abi, timelockArtifact.bytecode,
      [TIMELOCK_DELAY, [ledgerHex], [zeroAddress], ledgerHex],
      ENERGY.TIMELOCK_DEPLOY,
    );
    savePartial(deploymentFile, ledgerAddress, tokenResult, timelockResult, null, null);
  }

  // ── 3. Deploy DeedRegistry (UUPS Proxy) ──
  const registryArtifact = loadArtifact('registry/DeedRegistry.sol/DeedRegistry.json');
  let registryResult: any;

  if (prev.DeedRegistry?.proxy) {
    registryResult = {
      proxy: prev.DeedRegistry.proxy,
      proxyHex: tronWeb.address.toHex(prev.DeedRegistry.proxy),
      implementation: prev.DeedRegistry.implementation,
      implementationHex: tronWeb.address.toHex(prev.DeedRegistry.implementation),
    };
    console.log(`\nDeedRegistry already deployed: ${registryResult.proxy} (skipping)`);
  } else {
    registryResult = await deployProxyAndSign(
      tronWeb, ledgerApp, 'DeedRegistry',
      registryArtifact.abi, registryArtifact.bytecode,
      [tokenResult.hexAddress, ledgerHex, ADMIN_DELAY, ledgerHex, ledgerHex, ledgerHex, ledgerHex],
      ['address', 'address', 'uint48', 'address', 'address', 'address', 'address'],
      ENERGY.DEED_REGISTRY_IMPL,
      ENERGY.DEED_REGISTRY_PROXY,
    );
    savePartial(deploymentFile, ledgerAddress, tokenResult, timelockResult, registryResult, null);
  }

  // ── 4. Deploy BCOStaking (UUPS Proxy) ──
  const stakingArtifact = loadArtifact('staking/BCOStaking.sol/BCOStaking.json');
  let stakingResult: any;

  if (prev.BCOStaking?.proxy) {
    stakingResult = {
      proxy: prev.BCOStaking.proxy,
      proxyHex: tronWeb.address.toHex(prev.BCOStaking.proxy),
      implementation: prev.BCOStaking.implementation,
      implementationHex: tronWeb.address.toHex(prev.BCOStaking.implementation),
    };
    console.log(`\nBCOStaking already deployed: ${stakingResult.proxy} (skipping)`);
  } else {
    stakingResult = await deployProxyAndSign(
      tronWeb, ledgerApp, 'BCOStaking',
      stakingArtifact.abi, stakingArtifact.bytecode,
      [tokenResult.hexAddress, REWARD_DURATION, ADMIN_DELAY, ledgerHex, ledgerHex, ledgerHex, ledgerHex],
      ['address', 'uint256', 'uint48', 'address', 'address', 'address', 'address'],
      ENERGY.BCO_STAKING_IMPL,
      ENERGY.BCO_STAKING_PROXY,
    );
    savePartial(deploymentFile, ledgerAddress, tokenResult, timelockResult, registryResult, stakingResult);
  }

  // ── 5-7. Function calls (batch energy purchase) ──
  // 2 grantRole + 2 setTimelock = 4 calls (issuerInfo deferred)
  console.log('\n══ Configuring roles and timelock ══');
  await buyEnergyForBatch(ledgerAddress, 4, 'Roles + Timelock');

  const MINTER_ROLE = '0x9f2df0fed2c77648de5860a4cc508cd0818c85b8b8a1ab4ceeef8d981c8956a6';
  const BURNER_ROLE = '0x3c11d16cbaffd01df69ce1c404f6340ee057498f5f00246190ea54220576a848';

  // Grant roles
  await triggerAndSign(tronWeb, ledgerApp, tokenResult.hexAddress,
    'grantRole(bytes32,address)',
    [{ type: 'bytes32', value: MINTER_ROLE }, { type: 'address', value: registryResult.proxyHex }],
    'Grant MINTER_ROLE to DeedRegistry', false);

  await triggerAndSign(tronWeb, ledgerApp, tokenResult.hexAddress,
    'grantRole(bytes32,address)',
    [{ type: 'bytes32', value: BURNER_ROLE }, { type: 'address', value: registryResult.proxyHex }],
    'Grant BURNER_ROLE to DeedRegistry', false);

  // Set timelock
  await triggerAndSign(tronWeb, ledgerApp, registryResult.proxyHex,
    'setTimelock(address)',
    [{ type: 'address', value: timelockResult.hexAddress }],
    'setTimelock on DeedRegistry', false);

  await triggerAndSign(tronWeb, ledgerApp, stakingResult.proxyHex,
    'setTimelock(address)',
    [{ type: 'address', value: timelockResult.hexAddress }],
    'setTimelock on BCOStaking', false);

  // issuerInfo + contractURI skipped — set later when client provides data
  console.log('\n  issuerInfo + contractURI: SKIPPED (set later with real data)');

  // ── 8. Verify ──
  console.log('\n══ Verification ══');

  const tokenContract = await tronWeb.contract(tokenArtifact.abi, tokenResult.hexAddress);
  const registryContract = await tronWeb.contract(registryArtifact.abi, registryResult.proxyHex);

  const invariant = await registryContract.verifyInvariant().call();
  const issuer = await tokenContract.issuerName().call();

  console.log(`  verifyInvariant: ${invariant}`);
  console.log(`  issuerName: ${issuer}`);

  // ── Save final deployment ──
  const deployment = {
    network: 'mainnet',
    timestamp: new Date().toISOString(),
    deployer: ledgerAddress,
    config: {
      adminDelay: `${ADMIN_DELAY}s (${ADMIN_DELAY / 3600}h)`,
      timelockDelay: `${TIMELOCK_DELAY}s (${TIMELOCK_DELAY / 3600}h)`,
      rewardDuration: `${REWARD_DURATION}s (${REWARD_DURATION / 86400} days)`,
    },
    contracts: {
      BCOToken: { address: tokenResult.address, type: 'immutable' },
      TimelockController: { address: timelockResult.address, type: 'immutable' },
      DeedRegistry: { proxy: registryResult.proxy, implementation: registryResult.implementation, type: 'uups' },
      BCOStaking: { proxy: stakingResult.proxy, implementation: stakingResult.implementation, type: 'uups' },
    },
    energy: {
      totalEnergyUsed: totalEnergySpent,
      totalEnergyCost: `${totalEnergyCost.toFixed(2)} TRX`,
      provider: 'feee.io',
    },
  };

  fs.writeFileSync(deploymentFile, JSON.stringify(deployment, null, 2));

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════');
  console.log('  MAINNET DEPLOYMENT COMPLETE');
  console.log('═══════════════════════════════════════════════');
  console.log(`BCOToken (IMMUTABLE):  ${tokenResult.address}`);
  console.log(`TimelockController:    ${timelockResult.address}`);
  console.log(`DeedRegistry (Proxy):  ${registryResult.proxy}`);
  console.log(`BCOStaking (Proxy):    ${stakingResult.proxy}`);
  console.log('');
  console.log(`Energy spent: ${totalEnergySpent.toLocaleString()} energy`);
  console.log(`Energy cost:  ${totalEnergyCost.toFixed(2)} TRX (via feee.io)`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Verify contracts on TronScan');
  console.log('  2. Upload metadata JSON to IPFS');
  console.log('  3. Call setContractURI() with IPFS hash');
  console.log('  4. Test registerDeed on mainnet');
  console.log('  5. Transfer admin to client multi-sig when ready');
  console.log('');
  console.log('Addresses saved to deployment-mainnet.json');

  transport.close();
}

function savePartial(
  file: string, deployer: string,
  token: any, timelock: any, registry: any, staking: any,
) {
  const data: any = { network: 'mainnet', timestamp: new Date().toISOString(), deployer, contracts: {} };
  if (token) data.contracts.BCOToken = { address: token.address, type: 'immutable' };
  if (timelock) data.contracts.TimelockController = { address: timelock.address, type: 'immutable' };
  if (registry) data.contracts.DeedRegistry = { proxy: registry.proxy, implementation: registry.implementation, type: 'uups' };
  if (staking) data.contracts.BCOStaking = { proxy: staking.proxy, implementation: staking.implementation, type: 'uups' };
  fs.writeFileSync(file, JSON.stringify(data, null, 2));
}

main().catch((err) => {
  console.error('\nDEPLOYMENT FAILED:', err.message);
  console.error('The script saves progress. Run again to resume.');
  process.exit(1);
});
