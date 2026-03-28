import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { deployFullSystem, deedId, advanceTime } from '../fixtures/deploy';

describe('RecoverNative & Admin Safety', function () {
  // ────────────────────────────────────────────
  //  recoverNative() — all 3 contracts
  // ────────────────────────────────────────────

  describe('BCOToken — recoverNative', function () {
    it('should recover force-deposited native currency', async function () {
      const { token, deployer } = await loadFixture(deployFullSystem);

      // Force-deposit ETH via selfdestruct simulation
      const SelfDestruct = await ethers.getContractFactory('SelfDestructAttacker');
      const attacker = await SelfDestruct.deploy();
      await attacker.waitForDeployment();

      const depositAmount = ethers.parseEther('1.0');
      await deployer.sendTransaction({ to: await attacker.getAddress(), value: depositAmount });
      await attacker.attack(await token.getAddress());

      // Verify ETH is in the token contract
      const tokenAddress = await token.getAddress();
      expect(await ethers.provider.getBalance(tokenAddress)).to.equal(depositAmount);

      // Recover
      const balanceBefore = await ethers.provider.getBalance(deployer.address);
      const tx = await token.recoverNative();
      const receipt = await tx.wait();
      const gasCost = receipt!.gasUsed * receipt!.gasPrice;

      expect(await ethers.provider.getBalance(tokenAddress)).to.equal(0);
      expect(await ethers.provider.getBalance(deployer.address)).to.be.closeTo(
        balanceBefore + depositAmount - gasCost,
        ethers.parseEther('0.001'),
      );
    });

    it('should REVERT when no native currency to recover', async function () {
      const { token } = await loadFixture(deployFullSystem);
      await expect(token.recoverNative()).to.be.revertedWithCustomError(token, 'NoNativeToRecover');
    });

    it('should REVERT when called by non-admin', async function () {
      const { token, alice } = await loadFixture(deployFullSystem);
      await expect(token.connect(alice).recoverNative()).to.be.reverted;
    });
  });

  describe('DeedRegistry — recoverNative', function () {
    it('should REVERT when no native currency to recover', async function () {
      const { registry } = await loadFixture(deployFullSystem);
      await expect(registry.recoverNative()).to.be.revertedWithCustomError(registry, 'NoNativeToRecover');
    });

    it('should REVERT when called by non-admin', async function () {
      const { registry, alice } = await loadFixture(deployFullSystem);
      await expect(registry.connect(alice).recoverNative()).to.be.reverted;
    });
  });

  describe('BCOStaking — recoverNative', function () {
    it('should REVERT when no native currency to recover', async function () {
      const { staking } = await loadFixture(deployFullSystem);
      await expect(staking.recoverNative()).to.be.revertedWithCustomError(staking, 'NoNativeToRecover');
    });

    it('should REVERT when called by non-admin', async function () {
      const { staking, alice } = await loadFixture(deployFullSystem);
      await expect(staking.connect(alice).recoverNative()).to.be.reverted;
    });
  });

  // ────────────────────────────────────────────
  //  Admin Renounce Block — all 3 contracts
  // ────────────────────────────────────────────

  describe('BCOToken — Admin Renounce Block', function () {
    it('should REVERT when transferring admin to address(0)', async function () {
      const { token } = await loadFixture(deployFullSystem);
      await expect(
        token.beginDefaultAdminTransfer(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(token, 'AdminRenounceBlocked');
    });

    it('should allow transferring admin to valid address', async function () {
      const { token, alice } = await loadFixture(deployFullSystem);
      await expect(token.beginDefaultAdminTransfer(alice.address)).to.not.be.reverted;
    });
  });

  describe('DeedRegistry — Admin Renounce Block', function () {
    it('should REVERT when transferring admin to address(0)', async function () {
      const { registry } = await loadFixture(deployFullSystem);
      await expect(
        registry.beginDefaultAdminTransfer(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(registry, 'AdminRenounceBlocked');
    });

    it('should allow transferring admin to valid address', async function () {
      const { registry, alice } = await loadFixture(deployFullSystem);
      await expect(registry.beginDefaultAdminTransfer(alice.address)).to.not.be.reverted;
    });
  });

  describe('BCOStaking — Admin Renounce Block', function () {
    it('should REVERT when transferring admin to address(0)', async function () {
      const { staking } = await loadFixture(deployFullSystem);
      await expect(
        staking.beginDefaultAdminTransfer(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(staking, 'AdminRenounceBlocked');
    });

    it('should allow transferring admin to valid address', async function () {
      const { staking, alice } = await loadFixture(deployFullSystem);
      await expect(staking.beginDefaultAdminTransfer(alice.address)).to.not.be.reverted;
    });
  });

  // ────────────────────────────────────────────
  //  Timelock Auth — accepts timelock OR admin
  // ────────────────────────────────────────────

  describe('DeedRegistry — Timelock Auth Pattern', function () {
    it('should allow admin to call setTimelock below threshold', async function () {
      const { registry, timelock } = await loadFixture(deployFullSystem);
      await expect(registry.setTimelock(await timelock.getAddress())).to.not.be.reverted;
    });

    it('should REVERT when random user calls setTimelock', async function () {
      const { registry, alice, timelock } = await loadFixture(deployFullSystem);
      await expect(
        registry.connect(alice).setTimelock(await timelock.getAddress()),
      ).to.be.revertedWithCustomError(registry, 'Unauthorized');
    });
  });

  describe('BCOStaking — Timelock Auth Pattern', function () {
    it('should allow admin to call setTimelock below threshold', async function () {
      const { staking, timelock } = await loadFixture(deployFullSystem);
      await expect(staking.setTimelock(await timelock.getAddress())).to.not.be.reverted;
    });

    it('should REVERT when random user calls setTimelock', async function () {
      const { staking, alice, timelock } = await loadFixture(deployFullSystem);
      await expect(
        staking.connect(alice).setTimelock(await timelock.getAddress()),
      ).to.be.revertedWithCustomError(staking, 'Unauthorized');
    });
  });
});
