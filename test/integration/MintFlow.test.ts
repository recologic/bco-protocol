import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { deployFullSystem, deedId } from '../fixtures/deploy';

describe('Integration: Mint Flow', () => {
  it('should mint tokens when deed is registered', async () => {
    const { registry, token, treasury } = await loadFixture(deployFullSystem);

    const id = deedId('FLOW-001');
    await registry.registerDeed(id, 50000, '-22.9,-43.1', 'QmHash001');

    expect(await token.totalSupply()).to.equal(ethers.parseEther('50000'));
    expect(await token.balanceOf(treasury.address)).to.equal(
      ethers.parseEther('50000'),
    );
    expect(await registry.verifyInvariant()).to.be.true;
  });

  it('should burn tokens when deed is deactivated', async () => {
    const { registry, token, treasury } = await loadFixture(deployFullSystem);

    const id = deedId('FLOW-002');
    await registry.registerDeed(id, 30000, '-15.7,-47.9', 'QmHash002');

    await token
      .connect(treasury)
      .approve(await registry.getAddress(), ethers.MaxUint256);
    await registry.deactivateDeed(id, 'Sold');

    expect(await token.totalSupply()).to.equal(0);
    expect(await registry.totalActiveArea()).to.equal(0);
    expect(await registry.verifyInvariant()).to.be.true;
  });

  it('should maintain invariant across multiple registrations and deactivations', async () => {
    const { registry, token, treasury } = await loadFixture(deployFullSystem);

    // Register 3 deeds
    await registry.registerDeed(
      deedId('M-001'),
      10000,
      '-10,-20',
      'Qm1',
    );
    await registry.registerDeed(
      deedId('M-002'),
      25000,
      '-11,-21',
      'Qm2',
    );
    await registry.registerDeed(
      deedId('M-003'),
      15000,
      '-12,-22',
      'Qm3',
    );

    expect(await registry.totalActiveArea()).to.equal(50000);
    expect(await token.totalSupply()).to.equal(ethers.parseEther('50000'));
    expect(await registry.verifyInvariant()).to.be.true;

    // Deactivate 1 deed
    await token
      .connect(treasury)
      .approve(await registry.getAddress(), ethers.MaxUint256);
    await registry.deactivateDeed(deedId('M-002'), 'Sold');

    expect(await registry.totalActiveArea()).to.equal(25000);
    expect(await token.totalSupply()).to.equal(ethers.parseEther('25000'));
    expect(await registry.activeDeedCount()).to.equal(2);
    expect(await registry.verifyInvariant()).to.be.true;
  });

  it('should allow treasury to transfer tokens to other accounts', async () => {
    const { registry, token, treasury, alice } =
      await loadFixture(deployFullSystem);

    await registry.registerDeed(
      deedId('TRANSFER'),
      1000,
      '-10,-20',
      'QmT',
    );

    // Treasury distributes tokens
    await token
      .connect(treasury)
      .transfer(alice.address, ethers.parseEther('500'));

    expect(await token.balanceOf(alice.address)).to.equal(
      ethers.parseEther('500'),
    );
    expect(await token.balanceOf(treasury.address)).to.equal(
      ethers.parseEther('500'),
    );
    // Supply unchanged
    expect(await token.totalSupply()).to.equal(ethers.parseEther('1000'));
  });
});
