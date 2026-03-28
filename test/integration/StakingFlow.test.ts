import { expect } from 'chai';
import { ethers } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { deployFullSystem, advanceTime, currentTimestamp } from '../fixtures/deploy';

describe('Integration: Staking Flow', () => {
  async function setupStakingFlow() {
    const fixture = await loadFixture(deployFullSystem);
    const { token, staking, deployer, alice, bob, MINTER_ROLE } = fixture;

    await token.grantRole(MINTER_ROLE, deployer.address);
    await token.mint(alice.address, ethers.parseEther('5000'));
    await token.mint(bob.address, ethers.parseEther('3000'));

    // Fund staking rewards and start period
    const rewardAmount = ethers.parseEther('100000');
    await token.mint(await staking.getAddress(), rewardAmount);
    await staking.notifyRewardAmount(rewardAmount);

    // Approve
    await token
      .connect(alice)
      .approve(await staking.getAddress(), ethers.MaxUint256);
    await token
      .connect(bob)
      .approve(await staking.getAddress(), ethers.MaxUint256);

    return fixture;
  }

  it('should complete full staking lifecycle: deposit → earn → claim → withdraw', async () => {
    const { staking, token, alice } = await setupStakingFlow();
    const lockDuration = 7 * 86400;

    // 1. Deposit
    await staking
      .connect(alice)
      .deposit(ethers.parseEther('2000'), lockDuration);
    expect(await staking.totalStaked()).to.equal(ethers.parseEther('2000'));

    // 2. Earn rewards over time
    await advanceTime(86400); // 1 day
    const pending = await staking.pendingReward(alice.address);
    expect(pending).to.be.gt(0);

    // 3. Claim rewards
    const balanceBefore = await token.balanceOf(alice.address);
    await staking.connect(alice).claimRewards();
    const balanceAfter = await token.balanceOf(alice.address);
    expect(balanceAfter).to.be.gt(balanceBefore);

    // 4. Wait for lock to expire and withdraw
    await advanceTime(7 * 86400);
    await staking.connect(alice).withdraw(ethers.parseEther('2000'));
    expect(await staking.totalStaked()).to.equal(0);
  });

  it('should distribute rewards proportionally between stakers', async () => {
    const { staking, alice, bob } = await setupStakingFlow();
    const lockDuration = 7 * 86400;

    // Alice stakes 2000, Bob stakes 1000
    await staking
      .connect(alice)
      .deposit(ethers.parseEther('2000'), lockDuration);
    await staking
      .connect(bob)
      .deposit(ethers.parseEther('1000'), lockDuration);

    await advanceTime(86400); // 1 day

    const alicePending = await staking.pendingReward(alice.address);
    const bobPending = await staking.pendingReward(bob.address);

    // Alice should get ~2x Bob's rewards (2000:1000 ratio)
    const ratio =
      Number(ethers.formatEther(alicePending)) /
      Number(ethers.formatEther(bobPending));
    expect(ratio).to.be.closeTo(2, 0.1);
  });

  it('should maintain staking invariant: totalStaked <= contract balance', async () => {
    const { staking, token, alice, bob } = await setupStakingFlow();

    await staking
      .connect(alice)
      .deposit(ethers.parseEther('1500'), 7 * 86400);
    await staking
      .connect(bob)
      .deposit(ethers.parseEther('1000'), 14 * 86400);

    const totalStaked = await staking.totalStaked();
    const contractBalance = await token.balanceOf(await staking.getAddress());

    expect(contractBalance).to.be.gte(totalStaked);
  });

  it('should stop distributing rewards after period ends', async () => {
    const { staking, alice } = await setupStakingFlow();
    const lockDuration = 7 * 86400;

    await staking
      .connect(alice)
      .deposit(ethers.parseEther('2000'), lockDuration);

    // Advance past period finish (90 days + buffer)
    await advanceTime(91 * 86400);

    const earningsAtEnd = await staking.earned(alice.address);
    expect(earningsAtEnd).to.be.gt(0);

    // Advance more time — earnings should NOT increase
    await advanceTime(30 * 86400);

    const earningsLater = await staking.earned(alice.address);
    expect(earningsLater).to.equal(earningsAtEnd);
  });
});
