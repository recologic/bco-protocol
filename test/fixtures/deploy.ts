import { ethers, upgrades } from 'hardhat';

/**
 * Shared deployment fixture for all tests.
 * Deploys the full BCO protocol: Token (immutable), Registry (UUPS), Staking (UUPS), Timelock.
 * Uses Hardhat's loadFixture for snapshot-based test isolation.
 */
export async function deployFullSystem() {
  const [deployer, alice, bob, carol, treasury, pauser] =
    await ethers.getSigners();

  // Admin transfer delay: 0 for tests (48h in production)
  const adminTransferDelay = 0;

  // ── 1. Deploy BCOToken (IMMUTABLE — no proxy) ──
  const BCOToken = await ethers.getContractFactory('BCOToken');
  const token = await BCOToken.deploy(
    adminTransferDelay,
    deployer.address,    // defaultAdmin
    pauser.address,      // pauser
  );
  await token.waitForDeployment();

  // ── 2. Deploy TimelockController ──
  const TimelockController = await ethers.getContractFactory('TimelockController');
  const timelockDelay = 24 * 60 * 60; // 24 hours
  const timelock = await TimelockController.deploy(
    timelockDelay,
    [deployer.address], // proposers
    [ethers.ZeroAddress], // executors (anyone)
    deployer.address, // admin
  );
  await timelock.waitForDeployment();

  // ── 3. Deploy DeedRegistry (UUPS Proxy) ──
  const DeedRegistry =
    await ethers.getContractFactory('DeedRegistry');
  const registry = await upgrades.deployProxy(
    DeedRegistry,
    [
      await token.getAddress(),
      treasury.address,
      adminTransferDelay,  // adminTransferDelay
      deployer.address,    // defaultAdmin
      deployer.address,    // registrar
      pauser.address,      // pauser
      deployer.address,    // upgrader
    ],
    { kind: 'uups' },
  );
  await registry.waitForDeployment();

  // ── 4. Deploy BCOStaking (UUPS Proxy) ──
  const BCOStaking = await ethers.getContractFactory('BCOStaking');
  const rewardDuration = 90 * 24 * 60 * 60; // 90 days
  const staking = await upgrades.deployProxy(
    BCOStaking,
    [
      await token.getAddress(),
      rewardDuration,
      adminTransferDelay,  // adminTransferDelay
      deployer.address,    // defaultAdmin
      deployer.address,    // rewardManager
      pauser.address,      // pauser
      deployer.address,    // upgrader
    ],
    { kind: 'uups' },
  );
  await staking.waitForDeployment();

  // ── 5. Grant MINTER_ROLE and BURNER_ROLE to Registry ──
  const MINTER_ROLE = await token.MINTER_ROLE();
  const BURNER_ROLE = await token.BURNER_ROLE();
  const registryAddress = await registry.getAddress();
  await token.grantRole(MINTER_ROLE, registryAddress);
  await token.grantRole(BURNER_ROLE, registryAddress);

  // ── Role constants ──
  const REGISTRAR_ROLE = await registry.REGISTRAR_ROLE();
  const PAUSER_ROLE = await token.PAUSER_ROLE();
  const REWARD_MANAGER_ROLE = await staking.REWARD_MANAGER_ROLE();
  const DEFAULT_ADMIN_ROLE = await token.DEFAULT_ADMIN_ROLE();

  return {
    // Contracts
    token,
    registry,
    staking,
    timelock,
    // Signers
    deployer,
    alice,
    bob,
    carol,
    treasury,
    pauser,
    // Role constants
    MINTER_ROLE,
    BURNER_ROLE,
    REGISTRAR_ROLE,
    PAUSER_ROLE,
    REWARD_MANAGER_ROLE,
    DEFAULT_ADMIN_ROLE,
  };
}

/**
 * Helper: generate a unique deed ID from a string.
 */
export function deedId(name: string): string {
  return ethers.keccak256(ethers.toUtf8Bytes(name));
}

/**
 * Helper: advance block timestamp by seconds.
 */
export async function advanceTime(seconds: number) {
  await ethers.provider.send('evm_increaseTime', [seconds]);
  await ethers.provider.send('evm_mine', []);
}

/**
 * Helper: get current block timestamp.
 */
export async function currentTimestamp(): Promise<number> {
  const block = await ethers.provider.getBlock('latest');
  return block!.timestamp;
}
