import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { deployFullSystem, deedId, advanceTime } from '../fixtures/deploy';

describe('Integration: Upgrade Flow', () => {
  // ──────────────────────────────────────────────
  //  DeedRegistry Upgrade
  // ──────────────────────────────────────────────

  describe('DeedRegistry upgrade safety', () => {
    it('should preserve MINTER_ROLE on proxy after upgrade', async () => {
      const { token, registry, deployer, treasury, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      const registryAddress = await registry.getAddress();

      // Verify MINTER_ROLE before upgrade
      expect(await token.hasRole(MINTER_ROLE, registryAddress)).to.be.true;

      // Upgrade
      const DeedRegistryV2 = await ethers.getContractFactory('DeedRegistry');
      await upgrades.upgradeProxy(registryAddress, DeedRegistryV2);

      // MINTER_ROLE still on same proxy address
      expect(await token.hasRole(MINTER_ROLE, registryAddress)).to.be.true;
    });

    it('should mint tokens after upgrade (registerDeed still works)', async () => {
      const { token, registry, deployer, treasury } =
        await loadFixture(deployFullSystem);

      // Register a deed BEFORE upgrade
      await registry.registerDeed(deedId('PRE-UPGRADE'), 10000, '-10,-20', 'QmPre');
      expect(await token.totalSupply()).to.equal(ethers.parseEther('10000'));

      // Upgrade the registry
      const DeedRegistryV2 = await ethers.getContractFactory('DeedRegistry');
      await upgrades.upgradeProxy(await registry.getAddress(), DeedRegistryV2);

      // Register a deed AFTER upgrade
      await registry.registerDeed(deedId('POST-UPGRADE'), 5000, '-11,-21', 'QmPost');
      expect(await token.totalSupply()).to.equal(ethers.parseEther('15000'));

      // Invariant holds
      expect(await registry.verifyInvariant()).to.be.true;
    });

    it('should preserve registered deeds after upgrade', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      // Register deeds
      await registry.registerDeed(deedId('DEED-A'), 1000, '-10,-20', 'QmA');
      await registry.registerDeed(deedId('DEED-B'), 2000, '-11,-21', 'QmB');

      expect(await registry.totalActiveArea()).to.equal(3000);
      expect(await registry.activeDeedCount()).to.equal(2);

      // Upgrade
      const DeedRegistryV2 = await ethers.getContractFactory('DeedRegistry');
      await upgrades.upgradeProxy(await registry.getAddress(), DeedRegistryV2);

      // State preserved
      expect(await registry.totalActiveArea()).to.equal(3000);
      expect(await registry.activeDeedCount()).to.equal(2);

      // Can still read deeds
      const deedA = await registry.getDeed(deedId('DEED-A'));
      expect(deedA.areaM2).to.equal(1000);

      const deedB = await registry.getDeed(deedId('DEED-B'));
      expect(deedB.areaM2).to.equal(2000);
    });

    it('should preserve invariant through upgrade', async () => {
      const { token, registry, treasury } = await loadFixture(deployFullSystem);

      // Register deed
      await registry.registerDeed(deedId('INV-UP'), 50000, '-10,-20', 'QmInv');
      expect(await registry.verifyInvariant()).to.be.true;

      // Upgrade
      const DeedRegistryV2 = await ethers.getContractFactory('DeedRegistry');
      await upgrades.upgradeProxy(await registry.getAddress(), DeedRegistryV2);

      // Invariant still holds after upgrade
      expect(await registry.verifyInvariant()).to.be.true;
      expect(await token.totalSupply()).to.equal(ethers.parseEther('50000'));
      expect(await registry.totalActiveArea()).to.equal(50000);
    });

    it('should allow deactivation after upgrade (burn works)', async () => {
      const { token, registry, treasury } = await loadFixture(deployFullSystem);

      // Register deed
      const id = deedId('BURN-UP');
      await registry.registerDeed(id, 30000, '-10,-20', 'QmBurn');

      // Upgrade
      const DeedRegistryV2 = await ethers.getContractFactory('DeedRegistry');
      await upgrades.upgradeProxy(await registry.getAddress(), DeedRegistryV2);

      // Approve and deactivate after upgrade
      await token
        .connect(treasury)
        .approve(await registry.getAddress(), ethers.MaxUint256);
      await registry.deactivateDeed(id, 'Post-upgrade deactivation');

      expect(await token.totalSupply()).to.equal(0);
      expect(await registry.totalActiveArea()).to.equal(0);
      expect(await registry.verifyInvariant()).to.be.true;
    });

    it('should preserve rate limits and treasury after upgrade', async () => {
      const { registry, treasury } = await loadFixture(deployFullSystem);

      // Check defaults
      expect(await registry.maxDailyRegistrations()).to.equal(10);
      expect(await registry.treasury()).to.equal(treasury.address);

      // Change rate limits
      await registry.setRateLimits(5, 5000000);

      // Upgrade
      const DeedRegistryV2 = await ethers.getContractFactory('DeedRegistry');
      await upgrades.upgradeProxy(await registry.getAddress(), DeedRegistryV2);

      // Settings preserved
      expect(await registry.maxDailyRegistrations()).to.equal(5);
      expect(await registry.maxAreaPerDeed()).to.equal(5000000);
      expect(await registry.treasury()).to.equal(treasury.address);
    });

    it('should preserve roles after upgrade', async () => {
      const { registry, deployer, REGISTRAR_ROLE } =
        await loadFixture(deployFullSystem);

      expect(await registry.hasRole(REGISTRAR_ROLE, deployer.address)).to.be
        .true;

      // Upgrade
      const DeedRegistryV2 = await ethers.getContractFactory('DeedRegistry');
      await upgrades.upgradeProxy(await registry.getAddress(), DeedRegistryV2);

      // Role preserved
      expect(await registry.hasRole(REGISTRAR_ROLE, deployer.address)).to.be
        .true;
    });
  });

  // ──────────────────────────────────────────────
  //  BCOStaking Upgrade
  // ──────────────────────────────────────────────

  describe('BCOStaking upgrade safety', () => {
    async function setupStakingWithDeposit() {
      const fixture = await loadFixture(deployFullSystem);
      const { token, staking, deployer, alice, MINTER_ROLE } = fixture;

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(alice.address, ethers.parseEther('5000'));
      await token.mint(await staking.getAddress(), ethers.parseEther('50000'));
      await staking.notifyRewardAmount(ethers.parseEther('50000'));

      await token
        .connect(alice)
        .approve(await staking.getAddress(), ethers.MaxUint256);
      await staking.connect(alice).deposit(ethers.parseEther('2000'), 7 * 86400);

      return fixture;
    }

    it('should preserve staked tokens after upgrade', async () => {
      const { staking, alice } = await setupStakingWithDeposit();

      const stakedBefore = await staking.totalStaked();
      const userBefore = await staking.stakeInfo(alice.address);

      // Upgrade
      const BCOStakingV2 = await ethers.getContractFactory('BCOStaking');
      await upgrades.upgradeProxy(await staking.getAddress(), BCOStakingV2);

      // State preserved
      expect(await staking.totalStaked()).to.equal(stakedBefore);
      const userAfter = await staking.stakeInfo(alice.address);
      expect(userAfter.amount).to.equal(userBefore.amount);
    });

    it('should allow withdraw after upgrade', async () => {
      const { staking, token, alice } = await setupStakingWithDeposit();

      // Advance past lock
      await advanceTime(7 * 86400 + 1);

      // Upgrade
      const BCOStakingV2 = await ethers.getContractFactory('BCOStaking');
      await upgrades.upgradeProxy(await staking.getAddress(), BCOStakingV2);

      // Withdraw after upgrade
      const balanceBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).withdraw(ethers.parseEther('2000'));
      const balanceAfter = await token.balanceOf(alice.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
      expect(await staking.totalStaked()).to.equal(0);
    });

    it('should preserve reward accounting after upgrade', async () => {
      const { staking, alice } = await setupStakingWithDeposit();

      // Earn some rewards
      await advanceTime(86400);
      const earnedBefore = await staking.earned(alice.address);
      expect(earnedBefore).to.be.gt(0);

      // Upgrade
      const BCOStakingV2 = await ethers.getContractFactory('BCOStaking');
      await upgrades.upgradeProxy(await staking.getAddress(), BCOStakingV2);

      // Earned rewards preserved (may be slightly more due to time passing)
      const earnedAfter = await staking.earned(alice.address);
      expect(earnedAfter).to.be.gte(earnedBefore);
    });

    it('should preserve reward period after upgrade', async () => {
      const { staking } = await setupStakingWithDeposit();

      const rateBefore = await staking.rewardRate();
      const finishBefore = await staking.periodFinish();

      // Upgrade
      const BCOStakingV2 = await ethers.getContractFactory('BCOStaking');
      await upgrades.upgradeProxy(await staking.getAddress(), BCOStakingV2);

      // Period preserved
      expect(await staking.rewardRate()).to.equal(rateBefore);
      expect(await staking.periodFinish()).to.equal(finishBefore);
    });
  });

  // ──────────────────────────────────────────────
  //  Mint Security Post-Upgrade
  // ──────────────────────────────────────────────

  describe('Mint security through upgrades', () => {
    it('should ONLY allow mint via registerDeed (no backdoor after upgrade)', async () => {
      const { token, registry, deployer, alice, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      // Upgrade registry
      const DeedRegistryV2 = await ethers.getContractFactory('DeedRegistry');
      await upgrades.upgradeProxy(await registry.getAddress(), DeedRegistryV2);

      // Direct mint by deployer should still fail (deployer is NOT minter)
      await expect(
        token.connect(deployer).mint(alice.address, ethers.parseEther('999999')),
      ).to.be.reverted;

      // Direct mint by alice should fail
      await expect(
        token.connect(alice).mint(alice.address, ethers.parseEther('999999')),
      ).to.be.reverted;

      // Only registerDeed can mint
      await registry.registerDeed(deedId('SAFE-MINT'), 100, '-10,-20', 'QmSafe');
      expect(await token.totalSupply()).to.equal(ethers.parseEther('100'));
      expect(await registry.verifyInvariant()).to.be.true;
    });

    it('should maintain MINTER_ROLE exclusively on Registry proxy across upgrades', async () => {
      const { token, registry, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      const registryProxy = await registry.getAddress();

      // Upgrade twice
      const V2 = await ethers.getContractFactory('DeedRegistry');
      await upgrades.upgradeProxy(registryProxy, V2);

      const V3 = await ethers.getContractFactory('DeedRegistry');
      await upgrades.upgradeProxy(registryProxy, V3);

      // MINTER_ROLE still only on proxy
      expect(await token.hasRole(MINTER_ROLE, registryProxy)).to.be.true;
      expect(await token.hasRole(MINTER_ROLE, deployer.address)).to.be.false;
    });

    it('should block upgrade when supply exceeds threshold and caller is not timelock', async () => {
      const { token, registry, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      // Set low threshold
      await registry.setDirectUpgradeSupplyLimit(ethers.parseEther('100'));

      // Register deed to push supply above threshold
      await registry.registerDeed(deedId('OVER-LIMIT'), 200, '-10,-20', 'QmOver');
      // Supply is now 200e18 > 100e18 threshold

      // Attempt upgrade without timelock
      const DeedRegistryV2 = await ethers.getContractFactory('DeedRegistry');
      await expect(
        upgrades.upgradeProxy(await registry.getAddress(), DeedRegistryV2),
      ).to.be.revertedWithCustomError(registry, 'TimelockRequired');
    });
  });

});
