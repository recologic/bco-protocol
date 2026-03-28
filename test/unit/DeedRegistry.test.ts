import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import {
  deployFullSystem,
  deedId,
  advanceTime,
} from '../fixtures/deploy';

describe('DeedRegistry', () => {
  // ──────────────────────────────────────────────
  //  Registration
  // ──────────────────────────────────────────────

  describe('registerDeed', () => {
    it('should register a deed and mint tokens', async () => {
      const { registry, token, treasury } = await loadFixture(deployFullSystem);

      const id = deedId('PROP-001');
      const area = 50000;

      await expect(
        registry.registerDeed(id, area, '-22.9,-43.1', 'QmHash001'),
      )
        .to.emit(registry, 'DeedRegistered')
        .withArgs(
          id,
          area,
          '-22.9,-43.1',
          'QmHash001',
          (await ethers.getSigners())[0].address,
          ethers.parseEther(area.toString()),
        );

      expect(await token.totalSupply()).to.equal(ethers.parseEther('50000'));
      expect(await token.balanceOf(treasury.address)).to.equal(
        ethers.parseEther('50000'),
      );
      expect(await registry.totalActiveArea()).to.equal(area);
      expect(await registry.activeDeedCount()).to.equal(1);
    });

    it('should maintain invariant after registration', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      const id = deedId('PROP-001');
      await registry.registerDeed(id, 50000, '-22.9,-43.1', 'QmHash001');

      expect(await registry.verifyInvariant()).to.be.true;
    });

    it('should store deed data correctly', async () => {
      const { registry, deployer } = await loadFixture(deployFullSystem);

      const id = deedId('PROP-001');
      await registry.registerDeed(id, 75000, '-15.7,-47.9', 'QmHash002');

      const esc = await registry.getDeed(id);
      expect(esc.id).to.equal(id);
      expect(esc.areaM2).to.equal(75000);
      expect(esc.geolocation).to.equal('-15.7,-47.9');
      expect(esc.documentHash).to.equal('QmHash002');
      expect(esc.registeredBy).to.equal(deployer.address);
      expect(esc.status).to.equal(0); // ACTIVE
      expect(esc.deactivatedAt).to.equal(0);
    });

    it('should REVERT on duplicate ID', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      const id = deedId('PROP-DUP');
      await registry.registerDeed(id, 1000, '-10,-20', 'QmHash');

      await expect(
        registry.registerDeed(id, 2000, '-10,-20', 'QmHash2'),
      ).to.be.revertedWithCustomError(registry, 'DeedAlreadyExists');
    });

    it('should REVERT on zero area', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.registerDeed(
          deedId('ZERO'),
          0,
          '-10,-20',
          'QmHash',
        ),
      ).to.be.revertedWithCustomError(registry, 'ZeroArea');
    });

    it('should REVERT when area exceeds limit', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.registerDeed(
          deedId('BIG'),
          10_000_001,
          '-10,-20',
          'QmHash',
        ),
      ).to.be.revertedWithCustomError(registry, 'AreaExceedsLimit');
    });

    it('should REVERT on empty geolocation', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.registerDeed(deedId('GEO'), 1000, '', 'QmHash'),
      ).to.be.revertedWithCustomError(registry, 'EmptyGeolocation');
    });

    it('should REVERT on empty document hash', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.registerDeed(deedId('DOC'), 1000, '-10,-20', ''),
      ).to.be.revertedWithCustomError(registry, 'EmptyDocumentHash');
    });

    it('should REVERT when called by non-REGISTRAR', async () => {
      const { registry, alice } = await loadFixture(deployFullSystem);

      await expect(
        registry
          .connect(alice)
          .registerDeed(deedId('UNAUTH'), 1000, '-10,-20', 'QmHash'),
      ).to.be.reverted;
    });

    it('should REVERT when paused', async () => {
      const { registry, pauser } = await loadFixture(deployFullSystem);

      await registry.connect(pauser).pause();

      await expect(
        registry.registerDeed(
          deedId('PAUSED'),
          1000,
          '-10,-20',
          'QmHash',
        ),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  Rate Limiting
  // ──────────────────────────────────────────────

  describe('Rate Limiting', () => {
    it('should allow up to maxDailyRegistrations per day', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      for (let i = 0; i < 10; i++) {
        await registry.registerDeed(
          deedId(`RATE-${i}`),
          100,
          '-10,-20',
          `QmHash${i}`,
        );
      }

      expect(await registry.todayRegistrations()).to.equal(10);
    });

    it('should REVERT when rate limit exceeded', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      for (let i = 0; i < 10; i++) {
        await registry.registerDeed(
          deedId(`LIMIT-${i}`),
          100,
          '-10,-20',
          `QmHash${i}`,
        );
      }

      await expect(
        registry.registerDeed(
          deedId('LIMIT-11'),
          100,
          '-10,-20',
          'QmHash11',
        ),
      ).to.be.revertedWithCustomError(registry, 'RateLimitExceeded');
    });

    it('should reset rate limit on new day', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      for (let i = 0; i < 10; i++) {
        await registry.registerDeed(
          deedId(`DAY1-${i}`),
          100,
          '-10,-20',
          `QmHash${i}`,
        );
      }

      // Advance 1 day
      await advanceTime(86400);

      // Should work on new day
      await expect(
        registry.registerDeed(
          deedId('DAY2-0'),
          100,
          '-10,-20',
          'QmHashNew',
        ),
      ).to.not.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  Deactivation
  // ──────────────────────────────────────────────

  describe('deactivateDeed', () => {
    it('should deactivate deed and burn tokens', async () => {
      const { registry, token, treasury } = await loadFixture(deployFullSystem);

      const id = deedId('DEACT-001');
      await registry.registerDeed(id, 30000, '-22.9,-43.1', 'QmHash');

      // Treasury must approve registry to burn
      await token
        .connect(treasury)
        .approve(await registry.getAddress(), ethers.MaxUint256);

      await expect(
        registry.deactivateDeed(id, 'Land sold'),
      )
        .to.emit(registry, 'DeedDeactivated')
        .withArgs(id, 30000, 'Land sold', ethers.parseEther('30000'));

      expect(await token.totalSupply()).to.equal(0);
      expect(await registry.totalActiveArea()).to.equal(0);
      expect(await registry.activeDeedCount()).to.equal(0);
      expect(await registry.verifyInvariant()).to.be.true;
    });

    it('should REVERT when deactivating non-existent deed', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.deactivateDeed(deedId('NOPE'), 'reason'),
      ).to.be.revertedWithCustomError(registry, 'DeedNotFound');
    });

    it('should REVERT when deactivating already deactivated deed', async () => {
      const { registry, token, treasury } = await loadFixture(deployFullSystem);

      const id = deedId('DOUBLE-DEACT');
      await registry.registerDeed(id, 1000, '-10,-20', 'QmHash');

      await token
        .connect(treasury)
        .approve(await registry.getAddress(), ethers.MaxUint256);

      await registry.deactivateDeed(id, 'first');

      await expect(
        registry.deactivateDeed(id, 'second'),
      ).to.be.revertedWithCustomError(registry, 'DeedNotActive');
    });
  });

  // ──────────────────────────────────────────────
  //  Update Documents
  // ──────────────────────────────────────────────

  describe('updateDocuments', () => {
    it('should update document hash and emit event', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      const id = deedId('UPDATE-001');
      await registry.registerDeed(id, 5000, '-10,-20', 'QmOldHash');

      await expect(
        registry.updateDocuments(id, 'QmNewHash', 'Updated certidão'),
      )
        .to.emit(registry, 'DocumentsUpdated')
        .withArgs(id, 'QmOldHash', 'QmNewHash', 'Updated certidão');

      const esc = await registry.getDeed(id);
      expect(esc.documentHash).to.equal('QmNewHash');
    });

    it('should REVERT on non-existent deed', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.updateDocuments(deedId('NOPE'), 'QmNew', 'reason'),
      ).to.be.revertedWithCustomError(registry, 'DeedNotFound');
    });

    it('should REVERT on empty document hash', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      const id = deedId('EMPTY-DOC');
      await registry.registerDeed(id, 1000, '-10,-20', 'QmOld');

      await expect(
        registry.updateDocuments(id, '', 'reason'),
      ).to.be.revertedWithCustomError(registry, 'EmptyDocumentHash');
    });
  });

  // ──────────────────────────────────────────────
  //  Admin Functions
  // ──────────────────────────────────────────────

  describe('Admin', () => {
    it('should update rate limits', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(registry.setRateLimits(20, 50_000_000))
        .to.emit(registry, 'RateLimitsUpdated')
        .withArgs(20, 50_000_000);

      expect(await registry.maxDailyRegistrations()).to.equal(20);
      expect(await registry.maxAreaPerDeed()).to.equal(50_000_000);
    });

    it('should update treasury', async () => {
      const { registry, alice } = await loadFixture(deployFullSystem);

      await expect(registry.setTreasury(alice.address)).to.emit(
        registry,
        'TreasuryUpdated',
      );
    });

    it('should REVERT on zero address treasury', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.setTreasury(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(registry, 'ZeroAddress');
    });
  });

  // ──────────────────────────────────────────────
  //  View Functions
  // ──────────────────────────────────────────────

  describe('View Functions', () => {
    it('should return correct totalDeedCount', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await registry.registerDeed(
        deedId('V1'),
        1000,
        '-10,-20',
        'QmH1',
      );
      await registry.registerDeed(
        deedId('V2'),
        2000,
        '-10,-20',
        'QmH2',
      );

      expect(await registry.totalDeedCount()).to.equal(2);
    });

    it('should REVERT getDeed on non-existent ID', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.getDeed(deedId('DOESNT-EXIST')),
      ).to.be.revertedWithCustomError(registry, 'DeedNotFound');
    });
  });

  // ──────────────────────────────────────────────
  //  initialize zero-address reverts
  // ──────────────────────────────────────────────

  describe('initialize zero-address validation', () => {
    it('should REVERT when registrar is zero address', async () => {
      const { token, treasury, deployer, pauser } =
        await loadFixture(deployFullSystem);

      const DeedRegistry =
        await ethers.getContractFactory('DeedRegistry');

      await expect(
        upgrades.deployProxy(
          DeedRegistry,
          [
            await token.getAddress(),
            treasury.address,
            0,
            deployer.address,
            ethers.ZeroAddress, // registrar = 0
            pauser.address,
            deployer.address,
          ],
          { kind: 'uups' },
        ),
      ).to.be.revertedWithCustomError(DeedRegistry, 'ZeroAddress');
    });

    it('should REVERT when pauser is zero address', async () => {
      const { token, treasury, deployer } =
        await loadFixture(deployFullSystem);

      const DeedRegistry =
        await ethers.getContractFactory('DeedRegistry');

      await expect(
        upgrades.deployProxy(
          DeedRegistry,
          [
            await token.getAddress(),
            treasury.address,
            0,
            deployer.address,
            deployer.address,
            ethers.ZeroAddress, // pauser = 0
            deployer.address,
          ],
          { kind: 'uups' },
        ),
      ).to.be.revertedWithCustomError(DeedRegistry, 'ZeroAddress');
    });

    it('should REVERT when upgrader is zero address', async () => {
      const { token, treasury, deployer, pauser } =
        await loadFixture(deployFullSystem);

      const DeedRegistry =
        await ethers.getContractFactory('DeedRegistry');

      await expect(
        upgrades.deployProxy(
          DeedRegistry,
          [
            await token.getAddress(),
            treasury.address,
            0,
            deployer.address,
            deployer.address,
            pauser.address,
            ethers.ZeroAddress, // upgrader = 0
          ],
          { kind: 'uups' },
        ),
      ).to.be.revertedWithCustomError(DeedRegistry, 'ZeroAddress');
    });
  });

  // ──────────────────────────────────────────────
  //  setRateLimits validation
  // ──────────────────────────────────────────────

  describe('setRateLimits validation', () => {
    it('should REVERT when maxDaily is zero', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.setRateLimits(0, 10_000_000),
      ).to.be.revertedWithCustomError(registry, 'InvalidRateLimits');
    });

    it('should REVERT when maxArea is zero', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.setRateLimits(10, 0),
      ).to.be.revertedWithCustomError(registry, 'InvalidRateLimits');
    });

    it('should REVERT when both are zero', async () => {
      const { registry } = await loadFixture(deployFullSystem);

      await expect(
        registry.setRateLimits(0, 0),
      ).to.be.revertedWithCustomError(registry, 'InvalidRateLimits');
    });
  });

  // ──────────────────────────────────────────────
  //  recoverERC20
  // ──────────────────────────────────────────────

  describe('recoverERC20', () => {
    it('should recover accidentally sent ERC20 tokens', async () => {
      const { registry, deployer } = await loadFixture(deployFullSystem);

      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const mockToken = await MockERC20.deploy();
      await mockToken.waitForDeployment();

      const registryAddress = await registry.getAddress();
      const amount = ethers.parseEther('200');
      await mockToken.mint(registryAddress, amount);

      await expect(
        registry.recoverERC20(await mockToken.getAddress(), amount),
      )
        .to.emit(registry, 'TokenRecovered')
        .withArgs(await mockToken.getAddress(), deployer.address, amount);

      expect(await mockToken.balanceOf(deployer.address)).to.equal(amount);
      expect(await mockToken.balanceOf(registryAddress)).to.equal(0);
    });

    it('should REVERT when called by non-admin', async () => {
      const { registry, alice } = await loadFixture(deployFullSystem);

      await expect(
        registry.connect(alice).recoverERC20(ethers.ZeroAddress, 100),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  unpause
  // ──────────────────────────────────────────────

  describe('unpause', () => {
    it('should unpause when called by PAUSER_ROLE', async () => {
      const { registry, pauser } = await loadFixture(deployFullSystem);

      await registry.connect(pauser).pause();
      expect(await registry.paused()).to.be.true;

      await registry.connect(pauser).unpause();
      expect(await registry.paused()).to.be.false;
    });

    it('should REVERT when called by non-PAUSER', async () => {
      const { registry, pauser, alice } =
        await loadFixture(deployFullSystem);

      await registry.connect(pauser).pause();

      await expect(
        registry.connect(alice).unpause(),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  setTimelock with timelock required
  // ──────────────────────────────────────────────

  describe('setTimelock with timelock enforcement', () => {
    it('should REVERT when supply exceeds threshold and caller is not timelock', async () => {
      const { registry, token, deployer, timelock, MINTER_ROLE } =
        await loadFixture(deployFullSystem);
      const timelockAddr = await timelock.getAddress();

      // Set a low threshold and set timelock
      await registry.setDirectUpgradeSupplyLimit(ethers.parseEther('100'));
      await registry.setTimelock(timelockAddr);

      // Mint above threshold
      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(deployer.address, ethers.parseEther('200'));

      // Supply (200) > threshold (100) — deployer is not timelock
      await expect(
        registry.setTimelock(timelockAddr),
      ).to.be.revertedWithCustomError(registry, 'TimelockRequired');
    });
  });

  // ──────────────────────────────────────────────
  //  setDirectUpgradeSupplyLimit with timelock
  // ──────────────────────────────────────────────

  describe('setDirectUpgradeSupplyLimit with timelock enforcement', () => {
    it('should REVERT when supply exceeds threshold and caller is not timelock', async () => {
      const { registry, token, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      // Set low threshold
      await registry.setDirectUpgradeSupplyLimit(ethers.parseEther('100'));

      // Mint above threshold
      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(deployer.address, ethers.parseEther('200'));

      // Supply (200) > threshold (100) — changing limit requires timelock
      await expect(
        registry.setDirectUpgradeSupplyLimit(ethers.parseEther('50')),
      ).to.be.revertedWithCustomError(registry, 'TimelockRequired');
    });
  });

  // ──────────────────────────────────────────────
  //  contractURI (ERC-7572)
  // ──────────────────────────────────────────────

  describe('contractURI', () => {
    it('should return empty string initially', async () => {
      const { registry } = await loadFixture(deployFullSystem);
      expect(await registry.contractURI()).to.equal('');
    });

    it('should update URI when called by admin', async () => {
      const { registry } = await loadFixture(deployFullSystem);
      const uri = 'ipfs://QmTestMetadata123';
      await registry.setContractURI(uri);
      expect(await registry.contractURI()).to.equal(uri);
    });

    it('should emit ContractURIUpdated event (ERC-7572, no params)', async () => {
      const { registry } = await loadFixture(deployFullSystem);
      await expect(registry.setContractURI('https://recologic.io/metadata.json'))
        .to.emit(registry, 'ContractURIUpdated');
    });

    it('should allow overwriting URI with a new value', async () => {
      const { registry } = await loadFixture(deployFullSystem);
      await registry.setContractURI('ipfs://QmFirst');
      await registry.setContractURI('ipfs://QmSecond');
      expect(await registry.contractURI()).to.equal('ipfs://QmSecond');
    });

    it('should allow clearing URI to empty string', async () => {
      const { registry } = await loadFixture(deployFullSystem);
      await registry.setContractURI('ipfs://QmSomething');
      await registry.setContractURI('');
      expect(await registry.contractURI()).to.equal('');
    });

    it('should REVERT when called by non-admin', async () => {
      const { registry, alice } = await loadFixture(deployFullSystem);
      await expect(
        registry.connect(alice).setContractURI('https://evil.com'),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  setIssuerInfo
  // ──────────────────────────────────────────────

  describe('setIssuerInfo', () => {
    it('should set issuer info when called by admin', async () => {
      const { registry } = await loadFixture(deployFullSystem);
      await registry.setIssuerInfo('REcologic Ltda', '12.345.678/0001-90', 'BR');
      expect(await registry.issuerName()).to.equal('REcologic Ltda');
      expect(await registry.issuerRegistration()).to.equal('12.345.678/0001-90');
      expect(await registry.issuerCountry()).to.equal('BR');
    });

    it('should emit IssuerInfoUpdated event', async () => {
      const { registry } = await loadFixture(deployFullSystem);
      await expect(registry.setIssuerInfo('REcologic Ltda', '12.345.678/0001-90', 'BR'))
        .to.emit(registry, 'IssuerInfoUpdated')
        .withArgs('REcologic Ltda', '12.345.678/0001-90', 'BR');
    });

    it('should allow overwriting issuer info', async () => {
      const { registry } = await loadFixture(deployFullSystem);
      await registry.setIssuerInfo('REcologic Ltda', '12.345.678/0001-90', 'BR');
      await registry.setIssuerInfo('REcologic S.A.', '12.345.678/0001-90', 'BR');
      expect(await registry.issuerName()).to.equal('REcologic S.A.');
    });

    it('should REVERT when called by non-admin', async () => {
      const { registry, alice } = await loadFixture(deployFullSystem);
      await expect(
        registry.connect(alice).setIssuerInfo('Hacker', '000', 'XX'),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  _authorizeUpgrade with timelock
  // ──────────────────────────────────────────────

  describe('_authorizeUpgrade with timelock enforcement', () => {
    it('should REVERT upgrade when supply exceeds threshold and caller is not timelock', async () => {
      const { registry, token, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      // Set low threshold
      await registry.setDirectUpgradeSupplyLimit(ethers.parseEther('100'));

      // Mint above threshold
      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(deployer.address, ethers.parseEther('200'));

      // Try to upgrade — deployer is UPGRADER but not timelock
      const DeedRegistryV2 =
        await ethers.getContractFactory('DeedRegistry');

      await expect(
        upgrades.upgradeProxy(await registry.getAddress(), DeedRegistryV2),
      ).to.be.revertedWithCustomError(registry, 'TimelockRequired');
    });
  });
});
