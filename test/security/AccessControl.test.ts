import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { deployFullSystem, deedId } from '../fixtures/deploy';

describe('Security: Access Control', () => {
  // ──────────────────────────────────────────────
  //  Token Access Control
  // ──────────────────────────────────────────────

  describe('BCOToken permissions', () => {
    it('should prevent unauthorized mint', async () => {
      const { token, alice, bob } = await loadFixture(deployFullSystem);

      await expect(
        token.connect(alice).mint(bob.address, ethers.parseEther('1000000')),
      ).to.be.reverted;
    });

    it('should prevent unauthorized pause', async () => {
      const { token, alice } = await loadFixture(deployFullSystem);
      await expect(token.connect(alice).pause()).to.be.reverted;
    });

    it('should prevent unauthorized unpause', async () => {
      const { token, pauser, alice } = await loadFixture(deployFullSystem);
      await token.connect(pauser).pause();
      await expect(token.connect(alice).unpause()).to.be.reverted;
    });

    it('should prevent unauthorized role grant', async () => {
      const { token, alice, bob, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      await expect(
        token.connect(alice).grantRole(MINTER_ROLE, bob.address),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  Registry Access Control
  // ──────────────────────────────────────────────

  describe('DeedRegistry permissions', () => {
    it('should prevent unauthorized registration', async () => {
      const { registry, alice } = await loadFixture(deployFullSystem);

      await expect(
        registry
          .connect(alice)
          .registerDeed(deedId('HACK'), 1000000, '-10,-20', 'QmFake'),
      ).to.be.reverted;
    });

    it('should prevent unauthorized deactivation', async () => {
      const { registry, alice } = await loadFixture(deployFullSystem);

      const id = deedId('DEACT-HACK');
      await registry.registerDeed(id, 1000, '-10,-20', 'QmReal');

      await expect(
        registry.connect(alice).deactivateDeed(id, 'hacked'),
      ).to.be.reverted;
    });

    it('should prevent unauthorized rate limit change', async () => {
      const { registry, alice } = await loadFixture(deployFullSystem);

      await expect(
        registry.connect(alice).setRateLimits(999999, 999999999),
      ).to.be.reverted;
    });

    it('should prevent unauthorized treasury change', async () => {
      const { registry, alice } = await loadFixture(deployFullSystem);

      await expect(
        registry.connect(alice).setTreasury(alice.address),
      ).to.be.reverted;
    });

    it('should prevent unauthorized document update', async () => {
      const { registry, alice } = await loadFixture(deployFullSystem);

      const id = deedId('DOC-HACK');
      await registry.registerDeed(id, 1000, '-10,-20', 'QmReal');

      await expect(
        registry.connect(alice).updateDocuments(id, 'QmFake', 'hacked'),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  Staking Access Control
  // ──────────────────────────────────────────────

  describe('BCOStaking permissions', () => {
    it('should prevent unauthorized reward notification', async () => {
      const { staking, alice } = await loadFixture(deployFullSystem);

      await expect(
        staking.connect(alice).notifyRewardAmount(ethers.parseEther('1000')),
      ).to.be.reverted;
    });

    it('should prevent unauthorized lock parameter change', async () => {
      const { staking, alice } = await loadFixture(deployFullSystem);

      await expect(
        staking.connect(alice).setLockParameters(0, 0),
      ).to.be.reverted;
    });

    it('should prevent unauthorized pause', async () => {
      const { staking, alice } = await loadFixture(deployFullSystem);
      await expect(staking.connect(alice).pause()).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  Circuit Breaker (Pause)
  // ──────────────────────────────────────────────

  describe('Circuit Breaker', () => {
    it('should block all operations when registry is paused', async () => {
      const { registry, pauser } = await loadFixture(deployFullSystem);

      await registry.connect(pauser).pause();

      await expect(
        registry.registerDeed(
          deedId('PAUSED-REG'),
          1000,
          '-10,-20',
          'QmHash',
        ),
      ).to.be.reverted;
    });

    it('should block staking operations when staking is paused', async () => {
      const { staking, token, deployer, alice, pauser, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(alice.address, ethers.parseEther('1000'));
      await token
        .connect(alice)
        .approve(await staking.getAddress(), ethers.MaxUint256);

      await staking.connect(pauser).pause();

      await expect(
        staking.connect(alice).deposit(ethers.parseEther('100'), 7 * 86400),
      ).to.be.reverted;
    });

    it('should block token transfers when token is paused', async () => {
      const { token, deployer, alice, bob, pauser, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(alice.address, ethers.parseEther('1000'));

      await token.connect(pauser).pause();

      await expect(
        token.connect(alice).transfer(bob.address, ethers.parseEther('100')),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  Rate Limiting Protection
  // ──────────────────────────────────────────────

  describe('Rate Limiting Protection', () => {
    it('should enforce daily registration limit', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      // Register 10 (max)
      for (let i = 0; i < 10; i++) {
        await registry.registerDeed(
          deedId(`SEC-RATE-${i}`),
          100,
          '-10,-20',
          `QmH${i}`,
        );
      }

      // 11th should fail
      await expect(
        registry.registerDeed(
          deedId('SEC-RATE-11'),
          100,
          '-10,-20',
          'QmH11',
        ),
      ).to.be.revertedWithCustomError(registry, 'RateLimitExceeded');
    });

    it('should enforce max area per deed', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.registerDeed(
          deedId('BIG-AREA'),
          10_000_001, // 1 more than limit
          '-10,-20',
          'QmBig',
        ),
      ).to.be.revertedWithCustomError(registry, 'AreaExceedsLimit');
    });
  });

  // ──────────────────────────────────────────────
  //  Supply Invariant
  // ──────────────────────────────────────────────

  describe('Supply Invariant', () => {
    it('should maintain totalSupply == totalActiveArea * 1e18 through operations', async () => {
      const { registry, token, treasury } = await loadFixture(deployFullSystem);

      // Register multiple deeds
      await registry.registerDeed(
        deedId('INV-1'),
        10000,
        '-10,-20',
        'Qm1',
      );
      expect(await registry.verifyInvariant()).to.be.true;

      await registry.registerDeed(
        deedId('INV-2'),
        25000,
        '-11,-21',
        'Qm2',
      );
      expect(await registry.verifyInvariant()).to.be.true;

      await registry.registerDeed(
        deedId('INV-3'),
        5000,
        '-12,-22',
        'Qm3',
      );
      expect(await registry.verifyInvariant()).to.be.true;

      // Deactivate one
      await token
        .connect(treasury)
        .approve(await registry.getAddress(), ethers.MaxUint256);
      await registry.deactivateDeed(deedId('INV-2'), 'Test');
      expect(await registry.verifyInvariant()).to.be.true;

      // Verify final state
      expect(await registry.totalActiveArea()).to.equal(15000);
      expect(await token.totalSupply()).to.equal(ethers.parseEther('15000'));
    });
  });
});
