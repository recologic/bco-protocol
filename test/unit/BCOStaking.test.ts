import { expect } from 'chai';
import { ethers, upgrades } from 'hardhat';
import { loadFixture } from '@nomicfoundation/hardhat-toolbox/network-helpers';
import { deployFullSystem, advanceTime } from '../fixtures/deploy';

describe('BCOStaking', () => {
  /**
   * Helper: mint BCO to alice, approve staking, fund reward pool, start period.
   */
  async function setupStaker() {
    const fixture = await loadFixture(deployFullSystem);
    const { token, staking, deployer, alice, MINTER_ROLE } = fixture;

    // Mint tokens to alice
    await token.grantRole(MINTER_ROLE, deployer.address);
    await token.mint(alice.address, ethers.parseEther('10000'));

    // Approve staking contract
    await token
      .connect(alice)
      .approve(await staking.getAddress(), ethers.MaxUint256);

    // Fund staking contract with reward tokens and start reward period
    const rewardAmount = ethers.parseEther('100000');
    await token.mint(await staking.getAddress(), rewardAmount);
    await staking.notifyRewardAmount(rewardAmount);

    return fixture;
  }

  // ──────────────────────────────────────────────
  //  Deposit
  // ──────────────────────────────────────────────

  describe('deposit', () => {
    it('should deposit tokens and emit event', async () => {
      const { staking, alice } = await setupStaker();
      const amount = ethers.parseEther('1000');
      const lockDuration = 7 * 24 * 60 * 60; // 7 days

      await expect(staking.connect(alice).deposit(amount, lockDuration))
        .to.emit(staking, 'Deposited');

      expect(await staking.totalStaked()).to.equal(amount);

      const info = await staking.stakeInfo(alice.address);
      expect(info.amount).to.equal(amount);
    });

    it('should REVERT on zero amount', async () => {
      const { staking, alice } = await setupStaker();

      await expect(
        staking.connect(alice).deposit(0, 7 * 86400),
      ).to.be.revertedWithCustomError(staking, 'ZeroAmount');
    });

    it('should REVERT on lock duration below minimum', async () => {
      const { staking, alice } = await setupStaker();

      await expect(
        staking.connect(alice).deposit(ethers.parseEther('100'), 60), // 60 seconds < 7 days
      ).to.be.revertedWithCustomError(staking, 'InvalidLockDuration');
    });

    it('should REVERT on lock duration above maximum', async () => {
      const { staking, alice } = await setupStaker();

      await expect(
        staking
          .connect(alice)
          .deposit(ethers.parseEther('100'), 366 * 86400), // > 365 days
      ).to.be.revertedWithCustomError(staking, 'InvalidLockDuration');
    });

    it('should allow multiple deposits', async () => {
      const { staking, alice } = await setupStaker();
      const lockDuration = 7 * 86400;

      await staking
        .connect(alice)
        .deposit(ethers.parseEther('500'), lockDuration);
      await staking
        .connect(alice)
        .deposit(ethers.parseEther('300'), lockDuration);

      const info = await staking.stakeInfo(alice.address);
      expect(info.amount).to.equal(ethers.parseEther('800'));
      expect(await staking.totalStaked()).to.equal(ethers.parseEther('800'));
    });
  });

  // ──────────────────────────────────────────────
  //  Withdraw
  // ──────────────────────────────────────────────

  describe('withdraw', () => {
    it('should withdraw after lock expires', async () => {
      const { staking, token, alice } = await setupStaker();
      const amount = ethers.parseEther('1000');
      const lockDuration = 7 * 86400;

      await staking.connect(alice).deposit(amount, lockDuration);

      // Advance past lock
      await advanceTime(lockDuration + 1);

      const balanceBefore = await token.balanceOf(alice.address);
      await staking.connect(alice).withdraw(amount);
      const balanceAfter = await token.balanceOf(alice.address);

      // Balance increases by at least the staked amount (+ accumulated rewards)
      expect(balanceAfter - balanceBefore).to.be.gte(amount);
      expect(await staking.totalStaked()).to.equal(0);
    });

    it('should REVERT before lock expires', async () => {
      const { staking, alice } = await setupStaker();
      const lockDuration = 30 * 86400;

      await staking
        .connect(alice)
        .deposit(ethers.parseEther('1000'), lockDuration);

      await expect(
        staking.connect(alice).withdraw(ethers.parseEther('1000')),
      ).to.be.revertedWithCustomError(staking, 'LockNotExpired');
    });

    it('should REVERT on zero amount', async () => {
      const { staking, alice } = await setupStaker();

      await staking
        .connect(alice)
        .deposit(ethers.parseEther('1000'), 7 * 86400);
      await advanceTime(7 * 86400 + 1);

      await expect(
        staking.connect(alice).withdraw(0),
      ).to.be.revertedWithCustomError(staking, 'ZeroAmount');
    });

    it('should REVERT when withdrawing more than staked', async () => {
      const { staking, alice } = await setupStaker();

      await staking
        .connect(alice)
        .deposit(ethers.parseEther('500'), 7 * 86400);
      await advanceTime(7 * 86400 + 1);

      await expect(
        staking.connect(alice).withdraw(ethers.parseEther('600')),
      ).to.be.revertedWithCustomError(staking, 'InsufficientStakedBalance');
    });

    it('should REVERT when nothing is staked', async () => {
      const { staking, alice } = await setupStaker();

      await expect(
        staking.connect(alice).withdraw(ethers.parseEther('100')),
      ).to.be.revertedWithCustomError(staking, 'NothingToWithdraw');
    });
  });

  // ──────────────────────────────────────────────
  //  Rewards
  // ──────────────────────────────────────────────

  describe('rewards', () => {
    it('should accumulate rewards over time', async () => {
      const { staking, alice } = await setupStaker();

      await staking
        .connect(alice)
        .deposit(ethers.parseEther('1000'), 7 * 86400);

      // Advance 100 seconds
      await advanceTime(100);

      const pending = await staking.pendingReward(alice.address);
      expect(pending).to.be.gt(0);
    });

    it('should claim rewards via claimRewards', async () => {
      const { staking, token, alice } = await setupStaker();

      await staking
        .connect(alice)
        .deposit(ethers.parseEther('1000'), 7 * 86400);

      await advanceTime(100);

      const balanceBefore = await token.balanceOf(alice.address);
      await expect(staking.connect(alice).claimRewards()).to.emit(
        staking,
        'RewardClaimed',
      );
      const balanceAfter = await token.balanceOf(alice.address);

      expect(balanceAfter).to.be.gt(balanceBefore);
    });

    it('should REVERT claimRewards when no pending reward', async () => {
      const { staking, alice } = await setupStaker();

      await expect(
        staking.connect(alice).claimRewards(),
      ).to.be.revertedWithCustomError(staking, 'NoPendingReward');
    });

    it('should stop rewards after period ends', async () => {
      const { staking, alice } = await setupStaker();

      await staking
        .connect(alice)
        .deposit(ethers.parseEther('1000'), 7 * 86400);

      // Advance past period finish (90 days + buffer)
      await advanceTime(91 * 86400);

      const earningsAtEnd = await staking.earned(alice.address);

      // Advance more — earnings should NOT increase
      await advanceTime(30 * 86400);

      const earningsLater = await staking.earned(alice.address);
      expect(earningsLater).to.equal(earningsAtEnd);
    });
  });

  // ──────────────────────────────────────────────
  //  Emergency Withdraw
  // ──────────────────────────────────────────────

  describe('emergencyWithdraw', () => {
    it('should withdraw without rewards, ignoring lock', async () => {
      const { staking, token, alice } = await setupStaker();
      const amount = ethers.parseEther('1000');

      await staking.connect(alice).deposit(amount, 365 * 86400);

      // Don't advance time — lock is active
      const balanceBefore = await token.balanceOf(alice.address);
      await expect(staking.connect(alice).emergencyWithdraw())
        .to.emit(staking, 'EmergencyWithdrawn')
        .withArgs(alice.address, amount);
      const balanceAfter = await token.balanceOf(alice.address);

      expect(balanceAfter - balanceBefore).to.equal(amount);
      expect(await staking.totalStaked()).to.equal(0);

      const info = await staking.stakeInfo(alice.address);
      expect(info.amount).to.equal(0);
    });

    it('should REVERT when nothing staked', async () => {
      const { staking, bob } = await setupStaker();

      await expect(
        staking.connect(bob).emergencyWithdraw(),
      ).to.be.revertedWithCustomError(staking, 'NothingToWithdraw');
    });

    it('should forfeit accrued rewards tracked in totalUnclaimedRewards', async () => {
      const { staking, token, alice } = await setupStaker();
      const amount = ethers.parseEther('1000');

      // Deposit
      await staking.connect(alice).deposit(amount, 365 * 86400);

      // Advance time so rewards accrue
      await advanceTime(86400);

      // Do a second deposit to trigger updateReward and checkpoint rewards
      await staking.connect(alice).deposit(ethers.parseEther('1'), 7 * 86400);

      // Now rewards[alice] > 0 and totalUnclaimedRewards > 0
      const unclaimedBefore = await staking.totalUnclaimedRewards();
      expect(unclaimedBefore).to.be.gt(0);

      // Emergency withdraw — forfeits accrued rewards
      await staking.connect(alice).emergencyWithdraw();

      // totalUnclaimedRewards should decrease
      const unclaimedAfter = await staking.totalUnclaimedRewards();
      expect(unclaimedAfter).to.be.lt(unclaimedBefore);
    });
  });

  // ──────────────────────────────────────────────
  //  Admin
  // ──────────────────────────────────────────────

  describe('admin', () => {
    it('should start reward period via notifyRewardAmount', async () => {
      const fixture = await loadFixture(deployFullSystem);
      const { token, staking, deployer, MINTER_ROLE } = fixture;

      await token.grantRole(MINTER_ROLE, deployer.address);
      const rewardAmount = ethers.parseEther('10000');
      await token.mint(await staking.getAddress(), rewardAmount);

      await expect(staking.notifyRewardAmount(rewardAmount))
        .to.emit(staking, 'RewardAdded');

      expect(await staking.rewardRate()).to.be.gt(0);
      expect(await staking.periodFinish()).to.be.gt(0);
    });

    it('should update reward duration when no period active', async () => {
      const { staking } = await loadFixture(deployFullSystem);

      const newDuration = 180 * 86400; // 180 days
      await expect(staking.setRewardDuration(newDuration))
        .to.emit(staking, 'RewardDurationUpdated');

      expect(await staking.rewardDuration()).to.equal(newDuration);
    });

    it('should REVERT setRewardDuration during active period', async () => {
      const { staking } = await setupStaker();

      await expect(
        staking.setRewardDuration(180 * 86400),
      ).to.be.revertedWithCustomError(staking, 'RewardPeriodActive');
    });

    it('should update lock parameters', async () => {
      const { staking } = await setupStaker();

      await expect(staking.setLockParameters(1 * 86400, 180 * 86400))
        .to.emit(staking, 'LockParametersUpdated');

      expect(await staking.minLockPeriod()).to.equal(1 * 86400);
      expect(await staking.maxLockPeriod()).to.equal(180 * 86400);
    });

    it('should REVERT admin calls from non-REWARD_MANAGER', async () => {
      const { staking, token, alice, deployer, MINTER_ROLE } = await setupStaker();

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(await staking.getAddress(), ethers.parseEther('1000'));

      await expect(
        staking.connect(alice).notifyRewardAmount(ethers.parseEther('1000')),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  initialize zero-address reverts
  // ──────────────────────────────────────────────

  describe('initialize zero-address validation', () => {
    it('should REVERT when rewardManager is zero address', async () => {
      const { token, deployer, pauser } =
        await loadFixture(deployFullSystem);

      const BCOStaking = await ethers.getContractFactory('BCOStaking');

      await expect(
        upgrades.deployProxy(
          BCOStaking,
          [
            await token.getAddress(),
            90 * 86400,
            0,
            deployer.address,
            ethers.ZeroAddress, // rewardManager = 0
            pauser.address,
            deployer.address,
          ],
          { kind: 'uups' },
        ),
      ).to.be.revertedWithCustomError(BCOStaking, 'ZeroAddress');
    });

    it('should REVERT when pauser is zero address', async () => {
      const { token, deployer } = await loadFixture(deployFullSystem);

      const BCOStaking = await ethers.getContractFactory('BCOStaking');

      await expect(
        upgrades.deployProxy(
          BCOStaking,
          [
            await token.getAddress(),
            90 * 86400,
            0,
            deployer.address,
            deployer.address,
            ethers.ZeroAddress, // pauser = 0
            deployer.address,
          ],
          { kind: 'uups' },
        ),
      ).to.be.revertedWithCustomError(BCOStaking, 'ZeroAddress');
    });

    it('should REVERT when upgrader is zero address', async () => {
      const { token, deployer, pauser } =
        await loadFixture(deployFullSystem);

      const BCOStaking = await ethers.getContractFactory('BCOStaking');

      await expect(
        upgrades.deployProxy(
          BCOStaking,
          [
            await token.getAddress(),
            90 * 86400,
            0,
            deployer.address,
            deployer.address,
            pauser.address,
            ethers.ZeroAddress, // upgrader = 0
          ],
          { kind: 'uups' },
        ),
      ).to.be.revertedWithCustomError(BCOStaking, 'ZeroAddress');
    });
  });

  // ──────────────────────────────────────────────
  //  notifyRewardAmount with active period (rollover)
  // ──────────────────────────────────────────────

  describe('notifyRewardAmount with active period', () => {
    it('should roll over remaining rewards when period is still active', async () => {
      const { staking, token, deployer, MINTER_ROLE } = await setupStaker();

      // Period is already active from setupStaker
      // Advance half the period (45 days)
      await advanceTime(45 * 86400);

      // Fund more rewards and notify again while period is active
      const additionalReward = ethers.parseEther('50000');
      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(await staking.getAddress(), additionalReward);

      const periodFinishBefore = await staking.periodFinish();

      await expect(
        staking.notifyRewardAmount(additionalReward),
      ).to.emit(staking, 'RewardAdded');

      // Period finish should be extended
      const periodFinishAfter = await staking.periodFinish();
      expect(periodFinishAfter).to.be.gt(periodFinishBefore);

      // Reward rate should reflect rollover
      expect(await staking.rewardRate()).to.be.gt(0);
    });

    it('should REVERT notifyRewardAmount with zero amount', async () => {
      const { staking } = await setupStaker();

      await expect(
        staking.notifyRewardAmount(0),
      ).to.be.revertedWithCustomError(staking, 'ZeroAmount');
    });

    it('should REVERT initialize when reward duration is zero', async () => {
      const fixture = await loadFixture(deployFullSystem);
      const { token, deployer } = fixture;

      const BCOStaking = await ethers.getContractFactory('BCOStaking');
      await expect(
        upgrades.deployProxy(
          BCOStaking,
          [
            await token.getAddress(),
            0, // rewardDuration = 0
            0,
            deployer.address,
            deployer.address,
            deployer.address,
            deployer.address,
          ],
          { kind: 'uups' },
        ),
      ).to.be.revertedWithCustomError(BCOStaking, 'ZeroAmount');
    });
  });

  // ──────────────────────────────────────────────
  //  setRewardDuration validation
  // ──────────────────────────────────────────────

  describe('setRewardDuration validation', () => {
    it('should REVERT when setting duration to zero', async () => {
      const { staking } = await loadFixture(deployFullSystem);

      await expect(
        staking.setRewardDuration(0),
      ).to.be.revertedWithCustomError(staking, 'ZeroAmount');
    });
  });

  // ──────────────────────────────────────────────
  //  setLockParameters validation
  // ──────────────────────────────────────────────

  describe('setLockParameters validation', () => {
    it('should REVERT when minLock is zero', async () => {
      const { staking } = await setupStaker();

      await expect(
        staking.setLockParameters(0, 180 * 86400),
      ).to.be.revertedWithCustomError(staking, 'InvalidLockParameters');
    });

    it('should REVERT when minLock exceeds maxLock', async () => {
      const { staking } = await setupStaker();

      await expect(
        staking.setLockParameters(200 * 86400, 100 * 86400),
      ).to.be.revertedWithCustomError(staking, 'InvalidLockParameters');
    });
  });

  // ──────────────────────────────────────────────
  //  setDirectUpgradeSupplyLimit
  // ──────────────────────────────────────────────

  describe('setDirectUpgradeSupplyLimit', () => {
    it('should update supply limit when supply is below threshold', async () => {
      const { staking } = await loadFixture(deployFullSystem);

      await expect(
        staking.setDirectUpgradeSupplyLimit(ethers.parseEther('500000')),
      )
        .to.emit(staking, 'DirectUpgradeSupplyLimitChanged')
        .withArgs(ethers.parseEther('1000000'), ethers.parseEther('500000'));

      expect(await staking.directUpgradeSupplyLimit()).to.equal(
        ethers.parseEther('500000'),
      );
    });

    it('should REVERT when supply exceeds threshold and caller is not timelock', async () => {
      const { staking, token, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      // Set low threshold
      await staking.setDirectUpgradeSupplyLimit(ethers.parseEther('100'));

      // Mint above threshold
      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(deployer.address, ethers.parseEther('200'));

      // Supply (200) > threshold (100)
      await expect(
        staking.setDirectUpgradeSupplyLimit(ethers.parseEther('50')),
      ).to.be.revertedWithCustomError(staking, 'TimelockRequired');
    });

    it('should REVERT when called by non-admin', async () => {
      const { staking, alice } = await loadFixture(deployFullSystem);

      await expect(
        staking
          .connect(alice)
          .setDirectUpgradeSupplyLimit(ethers.parseEther('100')),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  setTimelock with timelock enforcement
  // ──────────────────────────────────────────────

  describe('setTimelock with timelock enforcement', () => {
    it('should REVERT when supply exceeds threshold and caller is not timelock', async () => {
      const { staking, token, deployer, timelock, MINTER_ROLE } =
        await loadFixture(deployFullSystem);
      const timelockAddr = await timelock.getAddress();

      // Set low threshold and set timelock
      await staking.setDirectUpgradeSupplyLimit(ethers.parseEther('100'));
      await staking.setTimelock(timelockAddr);

      // Mint above threshold
      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(deployer.address, ethers.parseEther('200'));

      // Supply (200) > threshold (100) — deployer is not timelock
      await expect(
        staking.setTimelock(timelockAddr),
      ).to.be.revertedWithCustomError(staking, 'TimelockRequired');
    });

    it('should REVERT when newTimelock is zero address', async () => {
      const { staking } = await loadFixture(deployFullSystem);

      await expect(
        staking.setTimelock(ethers.ZeroAddress),
      ).to.be.revertedWithCustomError(staking, 'ZeroAddress');
    });
  });

  // ──────────────────────────────────────────────
  //  recoverERC20
  // ──────────────────────────────────────────────

  describe('recoverERC20', () => {
    it('should recover non-BCO ERC20 tokens', async () => {
      const { staking, deployer } = await loadFixture(deployFullSystem);

      const MockERC20 = await ethers.getContractFactory('MockERC20');
      const mockToken = await MockERC20.deploy();
      await mockToken.waitForDeployment();

      const stakingAddress = await staking.getAddress();
      const amount = ethers.parseEther('300');
      await mockToken.mint(stakingAddress, amount);

      await expect(
        staking.recoverERC20(await mockToken.getAddress(), amount),
      )
        .to.emit(staking, 'TokenRecovered')
        .withArgs(await mockToken.getAddress(), deployer.address, amount);

      expect(await mockToken.balanceOf(deployer.address)).to.equal(amount);
    });

    it('should recover excess BCO tokens (sent accidentally)', async () => {
      const { staking, token, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      // Mint BCO directly to staking contract (accident)
      await token.grantRole(MINTER_ROLE, deployer.address);
      const excessAmount = ethers.parseEther('500');
      await token.mint(await staking.getAddress(), excessAmount);

      // No active period, no staked, no unclaimed — all is excess
      const excess = await staking.excessBCO();
      expect(excess).to.equal(excessAmount);

      await expect(
        staking.recoverERC20(await token.getAddress(), excessAmount),
      )
        .to.emit(staking, 'TokenRecovered');

      expect(await staking.excessBCO()).to.equal(0);
    });

    it('should REVERT when trying to recover more BCO than excess', async () => {
      const { staking, token, alice } = await setupStaker();

      // Alice stakes so there are staked funds that can't be recovered
      await staking
        .connect(alice)
        .deposit(ethers.parseEther('1000'), 7 * 86400);

      // Advance time so rewards accrue
      await advanceTime(86400);

      // Claim to update unclaimed accounting
      await staking.connect(alice).claimRewards();

      const balance = await token.balanceOf(await staking.getAddress());

      // Try to recover entire balance — should fail because staked + rewards are committed
      await expect(
        staking.recoverERC20(await token.getAddress(), balance),
      ).to.be.revertedWithCustomError(staking, 'InsufficientExcess');
    });

    it('should REVERT when called by non-admin', async () => {
      const { staking, alice } = await loadFixture(deployFullSystem);

      await expect(
        staking.connect(alice).recoverERC20(ethers.ZeroAddress, 100),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  unpause
  // ──────────────────────────────────────────────

  describe('unpause', () => {
    it('should unpause when called by PAUSER_ROLE', async () => {
      const { staking, pauser } = await loadFixture(deployFullSystem);

      await staking.connect(pauser).pause();
      expect(await staking.paused()).to.be.true;

      await staking.connect(pauser).unpause();
      expect(await staking.paused()).to.be.false;
    });

    it('should REVERT when called by non-PAUSER', async () => {
      const { staking, pauser, alice } =
        await loadFixture(deployFullSystem);

      await staking.connect(pauser).pause();

      await expect(
        staking.connect(alice).unpause(),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  excessBCO
  // ──────────────────────────────────────────────

  describe('excessBCO', () => {
    it('should return 0 when no BCO in contract', async () => {
      const { staking } = await loadFixture(deployFullSystem);

      expect(await staking.excessBCO()).to.equal(0);
    });

    it('should return full balance when no staked, no rewards, no unclaimed', async () => {
      const { staking, token, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(await staking.getAddress(), ethers.parseEther('1000'));

      expect(await staking.excessBCO()).to.equal(ethers.parseEther('1000'));
    });

    it('should account for remaining rewards during active period', async () => {
      const { staking, token, deployer, MINTER_ROLE } = await setupStaker();

      // Active period is running — excess should exclude committed rewards
      const excess = await staking.excessBCO();
      const balance = await token.balanceOf(await staking.getAddress());

      // Excess should be less than total balance because rewards are committed
      expect(excess).to.be.lt(balance);
    });

    it('should account for unclaimed rewards', async () => {
      const { staking, token, alice } = await setupStaker();

      // Alice stakes and earns rewards
      await staking
        .connect(alice)
        .deposit(ethers.parseEther('1000'), 7 * 86400);

      await advanceTime(86400); // 1 day of rewards

      // Trigger reward accounting update by calling earned
      const earnedBefore = await staking.earned(alice.address);
      expect(earnedBefore).to.be.gt(0);

      // excessBCO should exclude unclaimed rewards
      const excess = await staking.excessBCO();
      const balance = await token.balanceOf(await staking.getAddress());
      const totalStaked = await staking.totalStaked();

      // balance - excess >= totalStaked (at minimum)
      expect(balance - excess).to.be.gte(totalStaked);
    });
  });

  // ──────────────────────────────────────────────
  //  contractURI (ERC-7572)
  // ──────────────────────────────────────────────

  describe('contractURI', () => {
    it('should return empty string initially', async () => {
      const { staking } = await loadFixture(deployFullSystem);
      expect(await staking.contractURI()).to.equal('');
    });

    it('should update URI when called by admin', async () => {
      const { staking } = await loadFixture(deployFullSystem);
      const uri = 'ipfs://QmTestMetadata123';
      await staking.setContractURI(uri);
      expect(await staking.contractURI()).to.equal(uri);
    });

    it('should emit ContractURIUpdated event (ERC-7572, no params)', async () => {
      const { staking } = await loadFixture(deployFullSystem);
      await expect(staking.setContractURI('https://recologic.io/metadata.json'))
        .to.emit(staking, 'ContractURIUpdated');
    });

    it('should allow overwriting URI with a new value', async () => {
      const { staking } = await loadFixture(deployFullSystem);
      await staking.setContractURI('ipfs://QmFirst');
      await staking.setContractURI('ipfs://QmSecond');
      expect(await staking.contractURI()).to.equal('ipfs://QmSecond');
    });

    it('should allow clearing URI to empty string', async () => {
      const { staking } = await loadFixture(deployFullSystem);
      await staking.setContractURI('ipfs://QmSomething');
      await staking.setContractURI('');
      expect(await staking.contractURI()).to.equal('');
    });

    it('should REVERT when called by non-admin', async () => {
      const { staking, alice } = await loadFixture(deployFullSystem);
      await expect(
        staking.connect(alice).setContractURI('https://evil.com'),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  setIssuerInfo
  // ──────────────────────────────────────────────

  describe('setIssuerInfo', () => {
    it('should set issuer info when called by admin', async () => {
      const { staking } = await loadFixture(deployFullSystem);
      await staking.setIssuerInfo('REcologic Ltda', '12.345.678/0001-90', 'BR');
      expect(await staking.issuerName()).to.equal('REcologic Ltda');
      expect(await staking.issuerRegistration()).to.equal('12.345.678/0001-90');
      expect(await staking.issuerCountry()).to.equal('BR');
    });

    it('should emit IssuerInfoUpdated event', async () => {
      const { staking } = await loadFixture(deployFullSystem);
      await expect(staking.setIssuerInfo('REcologic Ltda', '12.345.678/0001-90', 'BR'))
        .to.emit(staking, 'IssuerInfoUpdated')
        .withArgs('REcologic Ltda', '12.345.678/0001-90', 'BR');
    });

    it('should allow overwriting issuer info', async () => {
      const { staking } = await loadFixture(deployFullSystem);
      await staking.setIssuerInfo('REcologic Ltda', '12.345.678/0001-90', 'BR');
      await staking.setIssuerInfo('REcologic S.A.', '12.345.678/0001-90', 'BR');
      expect(await staking.issuerName()).to.equal('REcologic S.A.');
    });

    it('should REVERT when called by non-admin', async () => {
      const { staking, alice } = await loadFixture(deployFullSystem);
      await expect(
        staking.connect(alice).setIssuerInfo('Hacker', '000', 'XX'),
      ).to.be.reverted;
    });
  });

  // ──────────────────────────────────────────────
  //  _authorizeUpgrade with timelock
  // ──────────────────────────────────────────────

  describe('_authorizeUpgrade with timelock enforcement', () => {
    it('should REVERT upgrade when supply exceeds threshold and caller is not timelock', async () => {
      const { staking, token, deployer, MINTER_ROLE } =
        await loadFixture(deployFullSystem);

      // Set low threshold
      await staking.setDirectUpgradeSupplyLimit(ethers.parseEther('100'));

      // Mint above threshold
      await token.grantRole(MINTER_ROLE, deployer.address);
      await token.mint(deployer.address, ethers.parseEther('200'));

      // Try to upgrade — deployer is UPGRADER but not timelock
      const BCOStakingV2 = await ethers.getContractFactory('BCOStaking');

      await expect(
        upgrades.upgradeProxy(await staking.getAddress(), BCOStakingV2),
      ).to.be.revertedWithCustomError(staking, 'TimelockRequired');
    });
  });
});
