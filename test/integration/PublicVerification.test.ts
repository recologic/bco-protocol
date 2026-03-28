import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { deployFullSystem, deedId } from '../fixtures/deploy';

describe('Integration: Public Verification', () => {
  async function setupWithDeeds() {
    const fixture = await loadFixture(deployFullSystem);
    const { registry } = fixture;

    // Register 3 deeds
    await registry.registerDeed(
      deedId('FOREST-001'),
      50000,
      '-22.9068,-43.1729',
      'QmForest001Hash',
    );
    await registry.registerDeed(
      deedId('FOREST-002'),
      30000,
      '-15.7801,-47.9292',
      'QmForest002Hash',
    );
    await registry.registerDeed(
      deedId('FOREST-003'),
      20000,
      '-3.1190,-60.0217',
      'QmForest003Hash',
    );

    return fixture;
  }

  // ──────────────────────────────────────────────
  //  Browse All Deeds
  // ──────────────────────────────────────────────

  describe('Browse deeds', () => {
    it('should list all deed IDs with pagination', async () => {
      const { registry } = await setupWithDeeds();

      // Get first 2
      const page1 = await registry.getDeedIds(0, 2);
      expect(page1.length).to.equal(2);
      expect(page1[0]).to.equal(deedId('FOREST-001'));
      expect(page1[1]).to.equal(deedId('FOREST-002'));

      // Get next page
      const page2 = await registry.getDeedIds(2, 2);
      expect(page2.length).to.equal(1); // Only 1 left
      expect(page2[0]).to.equal(deedId('FOREST-003'));
    });

    it('should get deed by index', async () => {
      const { registry } = await setupWithDeeds();

      const id = await registry.getDeedIdByIndex(1);
      expect(id).to.equal(deedId('FOREST-002'));
    });

    it('should return empty array for offset beyond total', async () => {
      const { registry } = await setupWithDeeds();

      const result = await registry.getDeedIds(100, 10);
      expect(result.length).to.equal(0);
    });

    it('should REVERT getDeedIdByIndex beyond range', async () => {
      const { registry } = await setupWithDeeds();

      await expect(
        registry.getDeedIdByIndex(99),
      ).to.be.revertedWithCustomError(registry, 'DeedNotFound');
    });
  });

  // ──────────────────────────────────────────────
  //  Verify Document
  // ──────────────────────────────────────────────

  describe('Verify document on-chain', () => {
    it('should return true when document hash matches', async () => {
      const { registry } = await setupWithDeeds();

      const [isValid, esc] = await registry.verifyDocument(
        deedId('FOREST-001'),
        'QmForest001Hash',
      );

      expect(isValid).to.be.true;
      expect(esc.areaM2).to.equal(50000);
      expect(esc.geolocation).to.equal('-22.9068,-43.1729');
    });

    it('should return false when document hash does NOT match', async () => {
      const { registry } = await setupWithDeeds();

      const [isValid] = await registry.verifyDocument(
        deedId('FOREST-001'),
        'QmFAKEHash999',
      );

      expect(isValid).to.be.false;
    });

    it('should REVERT for non-existent deed', async () => {
      const { registry } = await setupWithDeeds();

      await expect(
        registry.verifyDocument(deedId('DOESNT-EXIST'), 'QmAny'),
      ).to.be.revertedWithCustomError(registry, 'DeedNotFound');
    });
  });

  // ──────────────────────────────────────────────
  //  Full Public Verification Flow
  // ──────────────────────────────────────────────

  describe('Full verification flow (simulates what a user would do)', () => {
    it('should allow anyone to verify the entire system', async () => {
      const { registry, token } = await setupWithDeeds();

      // Step 1: Check how many deeds exist
      const totalDeeds = await registry.totalDeedCount();
      expect(totalDeeds).to.equal(3);

      // Step 2: Check active count
      const activeCount = await registry.activeDeedCount();
      expect(activeCount).to.equal(3);

      // Step 3: Check total area
      const totalArea = await registry.totalActiveArea();
      expect(totalArea).to.equal(100000); // 50k + 30k + 20k

      // Step 4: Verify supply invariant
      expect(await registry.verifyInvariant()).to.be.true;

      // Step 5: Verify total supply matches
      expect(await token.totalSupply()).to.equal(
        ethers.parseEther('100000'),
      );

      // Step 6: Browse all deed IDs
      const allIds = await registry.getDeedIds(0, 100);
      expect(allIds.length).to.equal(3);

      // Step 7: For each deed, get details and verify document
      for (let i = 0; i < allIds.length; i++) {
        const esc = await registry.getDeed(allIds[i]);
        expect(esc.status).to.equal(0); // ACTIVE

        // Verify the document hash matches (user would download from IPFS to check)
        const [docValid] = await registry.verifyDocument(
          allIds[i],
          esc.documentHash,
        );
        expect(docValid).to.be.true;
      }
    });
  });
});
