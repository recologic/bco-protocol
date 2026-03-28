/**
 * BCO Protocol — Full Deployment Script for TRON Nile Testnet
 *
 * Deploys:
 *   1. BCOToken (IMMUTABLE — direct deploy, no proxy)
 *   2. TimelockController (OpenZeppelin, immutable)
 *   3. DeedRegistry (UUPS Proxy)
 *   4. BCOStaking (UUPS Proxy)
 *   5. Grants roles + configures timelock
 *
 * Usage:
 *   npx ts-node scripts/deploy-nile.ts
 *
 * Prerequisites:
 *   - cp .env.example .env && fill in values
 *   - npx hardhat compile (generates artifacts)
 *   - npm install tronweb dotenv
 *   - TRX faucet on Nile: https://nileex.io/join/getJoinPage
 */

import { TronWeb } from 'tronweb';
import * as dotenv from 'dotenv';
import * as fs from 'fs';
import * as path from 'path';

dotenv.config();

// ─── Configuration ───────────────────────────────────────

const FULL_NODE = process.env.TRON_FULL_NODE ?? 'https://nile.trongrid.io';
const SOLIDITY_NODE = process.env.TRON_SOLIDITY_NODE ?? 'https://nile.trongrid.io';
const EVENT_SERVER = process.env.TRON_EVENT_SERVER ?? 'https://event.nileex.io';

const PRIVATE_KEY = process.env.PRIVATE_KEY!;
const TREASURY = process.env.TREASURY_ADDRESS!;
const PAUSER = process.env.PAUSER_ADDRESS!;
const ADMIN_DELAY = Number(process.env.ADMIN_TRANSFER_DELAY ?? '0');
const REWARD_DURATION = Number(process.env.REWARD_DURATION ?? '7776000');
const TIMELOCK_DELAY = Number(process.env.TIMELOCK_DELAY ?? '60');

// ─── Helpers ─────────────────────────────────────────────

function loadArtifact(contractPath: string) {
  const fullPath = path.join(
    __dirname,
    '..',
    'artifacts',
    'contracts',
    contractPath,
  );
  const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode };
}

function loadOZArtifact(contractPath: string) {
  const fullPath = path.join(
    __dirname,
    '..',
    'artifacts',
    '@openzeppelin',
    contractPath,
  );
  const json = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
  return { abi: json.abi, bytecode: json.bytecode };
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitForConfirmation(tronWeb: TronWeb, txId: string) {
  console.log(`  Waiting for confirmation: ${txId}`);
  for (let i = 0; i < 30; i++) {
    await sleep(3000);
    const info = await tronWeb.trx.getTransactionInfo(txId);
    if (info && Object.keys(info).length > 0) {
      if (info.result === 'FAILED') {
        throw new Error(`Transaction FAILED: ${txId}`);
      }
      console.log(`  Confirmed in block ${info.blockNumber}`);
      return info;
    }
  }
  throw new Error(`Transaction not confirmed after 90s: ${txId}`);
}

// ─── Deploy Functions ────────────────────────────────────

async function deployContract(
  tronWeb: TronWeb,
  name: string,
  abi: any[],
  bytecode: string,
  params: any[],
  paramTypes: string[],
) {
  console.log(`\nDeploying ${name}...`);

  const tx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi,
      bytecode,
      feeLimit: 15_000_000_000, // 15,000 TRX
      callValue: 0,
      parameters: params,
    },
    tronWeb.defaultAddress.hex as string,
  );

  const signed = await tronWeb.trx.sign(tx);
  const result = await tronWeb.trx.sendRawTransaction(signed);

  if (!result.result) {
    throw new Error(`Deploy ${name} failed: ${JSON.stringify(result)}`);
  }

  await waitForConfirmation(tronWeb, result.txid);

  const contractAddress = tronWeb.address.fromHex(
    '41' + result.txid.substring(0, 40),
  );

  // Get actual contract address from transaction info
  const txInfo = await tronWeb.trx.getTransactionInfo(result.txid);
  const hexAddr = txInfo.contract_address;
  const base58Addr = tronWeb.address.fromHex(hexAddr);

  console.log(`  ${name} deployed at: ${base58Addr}`);
  console.log(`  Hex: ${hexAddr}`);

  return { address: base58Addr, hexAddress: hexAddr, txId: result.txid };
}

async function deployProxy(
  tronWeb: TronWeb,
  name: string,
  implAbi: any[],
  implBytecode: string,
  initParams: any[],
  initParamTypes: string[],
) {
  // 1. Deploy implementation
  console.log(`\nDeploying ${name} (UUPS Proxy)...`);
  console.log(`  Step 1: Deploy implementation...`);

  const implTx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi: implAbi,
      bytecode: implBytecode,
      feeLimit: 15_000_000_000,
      callValue: 0,
      parameters: [],
    },
    tronWeb.defaultAddress.hex as string,
  );

  const implSigned = await tronWeb.trx.sign(implTx);
  const implResult = await tronWeb.trx.sendRawTransaction(implSigned);
  await waitForConfirmation(tronWeb, implResult.txid);

  const implInfo = await tronWeb.trx.getTransactionInfo(implResult.txid);
  const implHex = implInfo.contract_address;
  const implAddr = tronWeb.address.fromHex(implHex);
  console.log(`  Implementation at: ${implAddr}`);

  // 2. Encode initialize call
  const initSelector = tronWeb.sha3('initialize(' + initParamTypes.join(',') + ')').substring(0, 10);
  const encodedParams = tronWeb.utils.abi.encodeParams(initParamTypes, initParams);
  const initData = initSelector + encodedParams.substring(2);

  // 3. Deploy ERC1967Proxy
  console.log(`  Step 2: Deploy ERC1967Proxy...`);
  const proxyArtifact = loadOZArtifact(
    'contracts/proxy/ERC1967/ERC1967Proxy.sol/ERC1967Proxy.json',
  );

  const proxyTx = await tronWeb.transactionBuilder.createSmartContract(
    {
      abi: proxyArtifact.abi,
      bytecode: proxyArtifact.bytecode,
      feeLimit: 15_000_000_000,
      callValue: 0,
      parameters: [implHex, initData],
    },
    tronWeb.defaultAddress.hex as string,
  );

  const proxySigned = await tronWeb.trx.sign(proxyTx);
  const proxyResult = await tronWeb.trx.sendRawTransaction(proxySigned);
  await waitForConfirmation(tronWeb, proxyResult.txid);

  const proxyInfo = await tronWeb.trx.getTransactionInfo(proxyResult.txid);
  const proxyHex = proxyInfo.contract_address;
  const proxyAddr = tronWeb.address.fromHex(proxyHex);
  console.log(`  Proxy at: ${proxyAddr}`);
  console.log(`  ${name} ready (proxy → implementation)`);

  return {
    proxy: proxyAddr,
    proxyHex: proxyHex,
    implementation: implAddr,
    implementationHex: implHex,
  };
}

// ─── Main ────────────────────────────────────────────────

async function main() {
  // Validate env
  if (!PRIVATE_KEY || PRIVATE_KEY === 'your_private_key_here') {
    throw new Error('Set PRIVATE_KEY in .env');
  }
  if (!TREASURY || TREASURY.startsWith('TYour')) {
    throw new Error('Set TREASURY_ADDRESS in .env');
  }
  if (!PAUSER || PAUSER.startsWith('TYour')) {
    throw new Error('Set PAUSER_ADDRESS in .env');
  }

  const tronWeb = new TronWeb({
    fullNode: FULL_NODE,
    solidityNode: SOLIDITY_NODE,
    eventServer: EVENT_SERVER,
    privateKey: PRIVATE_KEY,
  });

  const deployer = tronWeb.defaultAddress.base58!;
  const deployerHex = tronWeb.defaultAddress.hex as string;
  console.log('═══════════════════════════════════════════════');
  console.log('  BCO Protocol — Nile Testnet Deployment');
  console.log('═══════════════════════════════════════════════');
  console.log(`Deployer:  ${deployer}`);
  console.log(`Treasury:  ${TREASURY}`);
  console.log(`Pauser:    ${PAUSER}`);
  console.log(`Admin delay: ${ADMIN_DELAY}s`);
  console.log(`Reward duration: ${REWARD_DURATION}s`);
  console.log(`Timelock delay: ${TIMELOCK_DELAY}s`);

  const balance = await tronWeb.trx.getBalance(deployer);
  console.log(`Balance:   ${(balance / 1e6).toFixed(2)} TRX`);
  if (balance < 500_000_000) {
    throw new Error('Need at least 500 TRX. Get faucet at https://nileex.io/join/getJoinPage');
  }

  const treasuryHex = tronWeb.address.toHex(TREASURY);
  const pauserHex = tronWeb.address.toHex(PAUSER);

  // Check for partial deployment (resume support)
  const deploymentFile = path.join(__dirname, '..', 'deployment-nile.json');
  let prev: any = {};
  if (fs.existsSync(deploymentFile)) {
    prev = JSON.parse(fs.readFileSync(deploymentFile, 'utf8')).contracts ?? {};
    console.log('\nResuming from previous partial deployment...');
  }

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
    tokenResult = await deployContract(
      tronWeb,
      'BCOToken',
      tokenArtifact.abi,
      tokenArtifact.bytecode,
      [ADMIN_DELAY, deployerHex, pauserHex],
      ['uint48', 'address', 'address'],
    );
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
    timelockResult = await deployContract(
      tronWeb,
      'TimelockController',
      timelockArtifact.abi,
      timelockArtifact.bytecode,
      [TIMELOCK_DELAY, [deployerHex], [zeroAddress], deployerHex],
      ['uint256', 'address[]', 'address[]', 'address'],
    );
  }

  // ── 3. Deploy DeedRegistry (UUPS Proxy) ──
  const registryArtifact = loadArtifact('registry/DeedRegistry.sol/DeedRegistry.json');
  const registryResult = await deployProxy(
    tronWeb,
    'DeedRegistry',
    registryArtifact.abi,
    registryArtifact.bytecode,
    [
      tokenResult.hexAddress,   // bcoToken
      treasuryHex,              // treasury
      ADMIN_DELAY,              // adminTransferDelay
      deployerHex,              // defaultAdmin
      deployerHex,              // registrar (deployer for testing)
      pauserHex,                // pauser
      deployerHex,              // upgrader
    ],
    ['address', 'address', 'uint48', 'address', 'address', 'address', 'address'],
  );

  // ── 4. Deploy BCOStaking (UUPS Proxy) ──
  const stakingArtifact = loadArtifact('staking/BCOStaking.sol/BCOStaking.json');
  const stakingResult = await deployProxy(
    tronWeb,
    'BCOStaking',
    stakingArtifact.abi,
    stakingArtifact.bytecode,
    [
      tokenResult.hexAddress,   // bcoToken
      REWARD_DURATION,          // initialRewardDuration
      ADMIN_DELAY,              // adminTransferDelay
      deployerHex,              // defaultAdmin
      deployerHex,              // rewardManager (deployer for testing)
      pauserHex,                // pauser
      deployerHex,              // upgrader
    ],
    ['address', 'uint256', 'uint48', 'address', 'address', 'address', 'address'],
  );

  // ── 5. Grant MINTER_ROLE + BURNER_ROLE to DeedRegistry ──
  console.log('\nGranting roles...');
  const tokenContract = await tronWeb.contract(tokenArtifact.abi, tokenResult.hexAddress);

  const MINTER_ROLE = await tokenContract.MINTER_ROLE().call();
  const BURNER_ROLE = await tokenContract.BURNER_ROLE().call();

  console.log('  Granting MINTER_ROLE to DeedRegistry...');
  const mintTx = await tokenContract.grantRole(MINTER_ROLE, registryResult.proxyHex).send({
    feeLimit: 1_000_000_000,
  });
  await waitForConfirmation(tronWeb, mintTx);

  console.log('  Granting BURNER_ROLE to DeedRegistry...');
  const burnTx = await tokenContract.grantRole(BURNER_ROLE, registryResult.proxyHex).send({
    feeLimit: 1_000_000_000,
  });
  await waitForConfirmation(tronWeb, burnTx);

  // ── 6. Set timelock on DeedRegistry + BCOStaking ──
  console.log('\nSetting timelock...');
  const registryContract = await tronWeb.contract(
    registryArtifact.abi,
    registryResult.proxyHex,
  );
  const stakingContract = await tronWeb.contract(
    stakingArtifact.abi,
    stakingResult.proxyHex,
  );

  console.log('  Setting timelock on DeedRegistry...');
  const regTlTx = await registryContract
    .setTimelock(timelockResult.hexAddress)
    .send({ feeLimit: 1_000_000_000 });
  await waitForConfirmation(tronWeb, regTlTx);

  console.log('  Setting timelock on BCOStaking...');
  const stkTlTx = await stakingContract
    .setTimelock(timelockResult.hexAddress)
    .send({ feeLimit: 1_000_000_000 });
  await waitForConfirmation(tronWeb, stkTlTx);

  // ── 7. Verify invariant ──
  console.log('\nVerifying invariant...');
  const invariant = await registryContract.verifyInvariant().call();
  console.log(`  verifyInvariant() = ${invariant} (expected: true)`);

  // ── Summary ──
  console.log('\n═══════════════════════════════════════════════');
  console.log('  DEPLOYMENT COMPLETE');
  console.log('═══════════════════════════════════════════════');
  console.log(`BCOToken (IMMUTABLE):     ${tokenResult.address}`);
  console.log(`TimelockController:       ${timelockResult.address}`);
  console.log(`DeedRegistry (Proxy):     ${registryResult.proxy}`);
  console.log(`DeedRegistry (Impl):      ${registryResult.implementation}`);
  console.log(`BCOStaking (Proxy):       ${stakingResult.proxy}`);
  console.log(`BCOStaking (Impl):        ${stakingResult.implementation}`);
  console.log('');
  console.log('Next steps:');
  console.log('  1. Verify contracts on NileScan');
  console.log('  2. Test registerDeed → check invariant');
  console.log('  3. Test staking flow');
  console.log('  4. Transfer admin to multi-sig when ready');

  // Save deployment addresses
  const deployment = {
    network: 'nile',
    timestamp: new Date().toISOString(),
    deployer,
    contracts: {
      BCOToken: { address: tokenResult.address, type: 'immutable' },
      TimelockController: { address: timelockResult.address, type: 'immutable' },
      DeedRegistry: {
        proxy: registryResult.proxy,
        implementation: registryResult.implementation,
        type: 'uups',
      },
      BCOStaking: {
        proxy: stakingResult.proxy,
        implementation: stakingResult.implementation,
        type: 'uups',
      },
    },
  };

  fs.writeFileSync(
    path.join(__dirname, '..', 'deployment-nile.json'),
    JSON.stringify(deployment, null, 2),
  );
  console.log('\nAddresses saved to deployment-nile.json');
}

main().catch((err) => {
  console.error('\nDEPLOYMENT FAILED:', err.message);
  process.exit(1);
});
