import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { deployFullSystem, deedId } from '../fixtures/deploy';

describe('Security: Progressive Timelock', () => {
  describe('DeedRegistry supply threshold', () => {
    it('should allow direct upgrade when supply is below threshold', async () => {
      const { registry, deployer } = await loadFixture(deployFullSystem);

      // Supply is 0 — below 1M threshold
      // Deployer has UPGRADER_ROLE and can upgrade directly
      const DeedRegistryV2 =
        await ethers.getContractFactory('DeedRegistry');

      // This should succeed (supply = 0 < 1M threshold)
      await expect(
        upgrades.upgradeProxy(await registry.getAddress(), DeedRegistryV2),
      ).to.not.be.reverted;
    });

    it('should report correct directUpgradeSupplyLimit', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      expect(await registry.directUpgradeSupplyLimit()).to.equal(
        ethers.parseEther('1000000'),
      );
    });

    it('should allow setting timelock address', async () => {
      const { registry, timelock } = await loadFixture(deployFullSystem);
      const timelockAddr = await timelock.getAddress();

      await expect(registry.setTimelock(timelockAddr))
        .to.emit(registry, 'TimelockChanged');

      expect(await registry.timelock()).to.equal(timelockAddr);
    });

    it('should allow changing supply limit when below current threshold', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.setDirectUpgradeSupplyLimit(ethers.parseEther('500000')),
      )
        .to.emit(registry, 'DirectUpgradeSupplyLimitChanged');

      expect(await registry.directUpgradeSupplyLimit()).to.equal(
        ethers.parseEther('500000'),
      );
    });

    it('should REVERT limit change without timelock when supply exceeds threshold', async () => {
      const { registry, token, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      // Set a very low threshold
      await registry.setDirectUpgradeSupplyLimit(ethers.parseEther('100'));

      // Mint tokens above threshold
      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(deployer.address, ethers.parseEther('200'));

      // Now supply (200) > threshold (100) — changing threshold requires timelock
      // deployer is not the timelock, so this should revert
      await expect(
        registry.setDirectUpgradeSupplyLimit(ethers.parseEther('50')),
      ).to.be.revertedWithCustomError(registry, 'TimelockRequired');
    });
  });

  describe('BCOStaking supply threshold', () => {
    it('should report correct directUpgradeSupplyLimit', async () => {
      const { staking } = await loadFixture(deployFullSystem);

      expect(await staking.directUpgradeSupplyLimit()).to.equal(
        ethers.parseEther('1000000'),
      );
    });

    it('should allow setting timelock address', async () => {
      const { staking, timelock } = await loadFixture(deployFullSystem);
      const timelockAddr = await timelock.getAddress();

      await expect(staking.setTimelock(timelockAddr))
        .to.emit(staking, 'TimelockChanged');
    });

    it('should allow direct upgrade when supply is below threshold', async () => {
      const { staking, deployer } = await loadFixture(deployFullSystem);

      const BCOStakingV2 = await ethers.getContractFactory('BCOStaking');

      await expect(
        upgrades.upgradeProxy(await staking.getAddress(), BCOStakingV2),
      ).to.not.be.reverted;
    });
  });

  describe('Ratchet mechanism', () => {
    it('should prevent disabling timelock once supply exceeds threshold', async () => {
      const { registry, token, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      // Set low threshold
      await registry.setDirectUpgradeSupplyLimit(ethers.parseEther('1000'));

      // Mint above threshold
      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(deployer.address, ethers.parseEther('2000'));

      // Supply (2000) > threshold (1000)
      // Cannot raise threshold to bypass timelock without going through timelock
      await expect(
        registry.setDirectUpgradeSupplyLimit(ethers.parseEther('999999')),
      ).to.be.revertedWithCustomError(registry, 'TimelockRequired');
    });
  });
});
