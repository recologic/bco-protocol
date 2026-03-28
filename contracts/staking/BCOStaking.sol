// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBCOStaking} from "../interfaces/IBCOStaking.sol";

/**
 * @title BCOStaking
 * @author REcologic
 * @notice Staking pool for BCO tokens. Deposit BCO to earn rewards over time.
 *
 * @dev UUPS upgradeable. Uses the Synthetix StakingRewards model.
 * Admin deposits reward tokens and sets a duration — `rewardRate = amount / duration`.
 * Rewards stop automatically when the period ends (`lastTimeRewardApplicable()`).
 * Pool empty = rate 0, stakers keep tokens, can unstake anytime.
 *
 * Rewards come from a pre-funded reward pool — no infinite minting.
 * This preserves the BCO invariant: totalSupply == totalActiveArea * 1e18.
 *
 * Pull pattern: users claim rewards explicitly via claimRewards().
 *
 * Emergency withdraw: bypasses lock period but forfeits ALL pending rewards.
 * This is the "fire exit" — always available, even when paused.
 *
 * Roles:
 * - DEFAULT_ADMIN_ROLE: Managed via AccessControlDefaultAdminRules (2-step transfer with delay).
 * - REWARD_MANAGER_ROLE: Multi-sig 3/5 (manages reward periods, lock parameters).
 * - PAUSER_ROLE: Multi-sig 3/5 (emergency pause).
 * - UPGRADER_ROLE: TimelockController (progressive timelock based on supply threshold).
 */
contract BCOStaking is
    IBCOStaking,
    Initializable,
    AccessControlDefaultAdminRulesUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // ──────────────────────────────────────────────
    //  Types
    // ──────────────────────────────────────────────

    struct StakeInfo {
        uint256 amount;
        uint48 lastDepositTime;
        uint48 lockUntil;
    }

    // ──────────────────────────────────────────────
    //  Roles
    // ──────────────────────────────────────────────

    /// @notice Role for managing reward periods and lock parameters.
    bytes32 public constant REWARD_MANAGER_ROLE = keccak256("REWARD_MANAGER_ROLE");

    /// @notice Role for emergency pause/unpause.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Role for UUPS contract upgrades (protected by progressive timelock).
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // ──────────────────────────────────────────────
    //  Constants
    // ──────────────────────────────────────────────

    /// @dev Precision factor for reward per token calculations.
    uint256 private constant PRECISION = 1e18;

    /// @dev Default supply threshold for progressive timelock (1M BCO).
    uint256 private constant DEFAULT_SUPPLY_THRESHOLD = 1e6 * 1e18;

    /// @dev Default minimum lock period (7 days).
    uint48 private constant DEFAULT_MIN_LOCK = 7 days;

    /// @dev Default maximum lock period (365 days).
    uint48 private constant DEFAULT_MAX_LOCK = 365 days;

    // ──────────────────────────────────────────────
    //  State — Core
    // ──────────────────────────────────────────────

    /// @notice The staked token (BCO).
    IERC20 public bcoToken;

    /// @notice Per-user staking data.
    mapping(address => StakeInfo) public stakeInfo;

    /// @notice Total BCO staked in the pool.
    uint256 public totalStaked;

    // ──────────────────────────────────────────────
    //  State — Synthetix Reward Model
    // ──────────────────────────────────────────────

    /// @notice Reward tokens distributed per second during an active period.
    uint256 public rewardRate;

    /// @notice Duration of each reward period in seconds (e.g. 90 days).
    uint256 public rewardDuration;

    /// @notice Timestamp when the current reward period ends. After this, rewards stop.
    uint256 public periodFinish;

    /// @notice Accumulated reward per token stored (precision 1e18).
    uint256 public rewardPerTokenStored;

    /// @notice Last time rewards were calculated (capped at periodFinish).
    uint256 public lastUpdateTime;

    /// @notice Per-user checkpoint of rewardPerToken at last interaction.
    mapping(address => uint256) public userRewardPerTokenPaid;

    /// @notice Per-user unclaimed rewards.
    mapping(address => uint256) public rewards;

    /// @notice Total rewards earned but not yet claimed by stakers. Used by excessBCO().
    uint256 public totalUnclaimedRewards;

    // ──────────────────────────────────────────────
    //  State — Lock
    // ──────────────────────────────────────────────

    /// @notice Minimum lock duration in seconds.
    uint48 public minLockPeriod;

    /// @notice Maximum lock duration in seconds.
    uint48 public maxLockPeriod;

    // ──────────────────────────────────────────────
    //  State — Progressive Timelock
    // ──────────────────────────────────────────────

    /// @notice Supply threshold below which upgrades bypass the timelock.
    uint256 public directUpgradeSupplyLimit;

    /// @notice TimelockController address for gated upgrades.
    address public timelock;

    // ──── Metadata ────

    /// @notice Legal name of the token issuer (on-chain backup).
    string public issuerName;

    /// @notice Official registration number of the issuer (e.g. CNPJ).
    string public issuerRegistration;

    /// @notice Country code of the issuer (ISO 3166-1 alpha-2, e.g. "BR").
    string public issuerCountry;

    /// @notice Contract metadata URI (ERC-7572). Points to JSON with issuer details.
    string private _contractURI;

    // ──────────────────────────────────────────────
    //  Storage Gap (reserved for future upgrades)
    // ──────────────────────────────────────────────

    /// @dev Reserved storage slots for future versions.
    uint256[44] private __gap;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

    /// @notice Emitted when a user deposits tokens into the staking pool.
    event Deposited(address indexed user, uint256 amount, uint48 lockUntil);

    /// @notice Emitted when a user withdraws staked tokens.
    event Withdrawn(address indexed user, uint256 amount);

    /// @notice Emitted when a user claims accumulated rewards.
    event RewardClaimed(address indexed user, uint256 reward);

    /// @notice Emitted when a user performs an emergency withdrawal (forfeiting rewards).
    event EmergencyWithdrawn(address indexed user, uint256 amount);

    /// @notice Emitted when a new reward period is started or extended.
    event RewardAdded(uint256 amount, uint256 rewardRate, uint256 periodFinish);

    /// @notice Emitted when the reward period duration is updated.
    event RewardDurationUpdated(uint256 newDuration);

    /// @notice Emitted when lock period parameters are updated.
    event LockParametersUpdated(uint48 minLock, uint48 maxLock);

    /// @notice Emitted when the supply threshold for direct upgrades is changed.
    event DirectUpgradeSupplyLimitChanged(uint256 oldLimit, uint256 newLimit);

    /// @notice Emitted when the timelock controller address is changed.
    event TimelockChanged(address indexed oldTimelock, address indexed newTimelock);

    /// @notice Emitted when accidentally sent tokens are recovered.
    event TokenRecovered(address indexed token, address indexed to, uint256 amount);

    /// @notice Emitted when native currency (TRX/ETH) is recovered.
    event NativeRecovered(address indexed to, uint256 amount);

    /// @notice Emitted when the contract metadata URI is updated (ERC-7572).
    event ContractURIUpdated();

    /// @notice Emitted when issuer identity information is updated.
    event IssuerInfoUpdated(string name, string registration, string country);

    // ──────────────────────────────────────────────
    //  Errors
    // ──────────────────────────────────────────────

    /// @notice Thrown when a zero amount is provided.
    error ZeroAmount();

    /// @notice Thrown when a zero address is provided.
    error ZeroAddress();

    /// @notice Thrown when withdrawal is attempted before lock expiry.
    error LockNotExpired(uint48 lockUntil, uint48 currentTime);

    /// @notice Thrown when lock duration is outside allowed bounds.
    error InvalidLockDuration(uint48 duration, uint48 min, uint48 max);

    /// @notice Thrown when lock parameters are invalid (min > max or min == 0).
    error InvalidLockParameters(uint48 min, uint48 max);

    /// @notice Thrown when withdrawal amount exceeds staked balance.
    error InsufficientStakedBalance(uint256 requested, uint256 available);

    /// @notice Thrown when user has nothing staked.
    error NothingToWithdraw();

    /// @notice Thrown when user has no pending rewards to claim.
    error NoPendingReward();

    /// @notice Thrown when an operation requires the timelock but caller is not timelock.
    error TimelockRequired();

    /// @notice Thrown when caller is neither admin nor timelock.
    error Unauthorized();

    /// @notice Thrown when attempting to renounce admin (transfer to address(0)).
    error AdminRenounceBlocked();

    /// @notice Thrown when there is no native currency to recover.
    error NoNativeToRecover();

    /// @notice Thrown when native currency transfer fails.
    error NativeTransferFailed();

    /// @notice Thrown when reward duration has not been set.
    error RewardDurationNotSet();

    /// @notice Thrown when trying to change reward duration during an active period.
    error RewardPeriodActive();

    /// @notice Thrown when reward rate would exceed available balance.
    error RewardTooHigh(uint256 rate, uint256 balance);

    /// @notice Thrown when trying to recover excess but requested amount exceeds available.
    error InsufficientExcess(uint256 requested, uint256 available);

    /// @notice Thrown when the timelock address is not a deployed contract.
    error NotAContract(address account);

    // ──────────────────────────────────────────────
    //  Modifiers
    // ──────────────────────────────────────────────

    /**
     * @dev Core Synthetix modifier — updates global and per-user reward accounting.
     *      Tracks totalUnclaimedRewards for accurate excessBCO() calculation.
     */
    modifier updateReward(address account) {
        rewardPerTokenStored = rewardPerToken();
        lastUpdateTime = lastTimeRewardApplicable();
        if (account != address(0)) {
            uint256 newEarned = earned(account);
            uint256 previousRewards = rewards[account];
            if (newEarned > previousRewards) {
                totalUnclaimedRewards += (newEarned - previousRewards);
            }
            rewards[account] = newEarned;
            userRewardPerTokenPaid[account] = rewardPerTokenStored;
        }
        _;
    }

    // ──────────────────────────────────────────────
    //  Initializer
    // ──────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the staking pool.
     * @param bcoTokenAddress Address of the BCO token.
     * @param initialRewardDuration Duration of the first reward period in seconds.
     * @param adminTransferDelay Delay for DEFAULT_ADMIN_ROLE transfer (e.g. 48 hours).
     * @param defaultAdmin Address for DEFAULT_ADMIN_ROLE.
     * @param rewardManager Address for REWARD_MANAGER_ROLE.
     * @param pauser Address for PAUSER_ROLE.
     * @param upgrader Address for UPGRADER_ROLE.
     */
    function initialize(
        address bcoTokenAddress,
        uint256 initialRewardDuration,
        uint48 adminTransferDelay,
        address defaultAdmin,
        address rewardManager,
        address pauser,
        address upgrader
    ) external initializer {
        if (bcoTokenAddress == address(0)) revert ZeroAddress();
        if (defaultAdmin == address(0)) revert ZeroAddress();
        if (initialRewardDuration == 0) revert ZeroAmount();

        __AccessControlDefaultAdminRules_init(adminTransferDelay, defaultAdmin);
        __Pausable_init();

        bcoToken = IERC20(bcoTokenAddress);
        rewardDuration = initialRewardDuration;

        minLockPeriod = DEFAULT_MIN_LOCK;
        maxLockPeriod = DEFAULT_MAX_LOCK;

        // Progressive timelock: 1M BCO threshold
        directUpgradeSupplyLimit = DEFAULT_SUPPLY_THRESHOLD;

        if (rewardManager == address(0)) revert ZeroAddress();
        if (pauser == address(0)) revert ZeroAddress();
        if (upgrader == address(0)) revert ZeroAddress();

        _grantRole(REWARD_MANAGER_ROLE, rewardManager);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(UPGRADER_ROLE, upgrader);
    }

    // ──────────────────────────────────────────────
    //  External Functions — Staking
    // ──────────────────────────────────────────────

    /**
     * @notice Deposit BCO tokens into the staking pool.
     * @param amount Amount of BCO to stake.
     * @param lockDuration Lock period in seconds (min: minLockPeriod, max: maxLockPeriod).
     */
    function deposit(
        uint256 amount,
        uint48 lockDuration
    ) external nonReentrant whenNotPaused updateReward(msg.sender) {
        if (amount == 0) revert ZeroAmount();
        if (lockDuration < minLockPeriod || lockDuration > maxLockPeriod) {
            revert InvalidLockDuration(lockDuration, minLockPeriod, maxLockPeriod);
        }

        StakeInfo storage info = stakeInfo[msg.sender];

        // Effects
        info.amount += amount;
        info.lastDepositTime = uint48(block.timestamp);

        uint48 newLockUntil = uint48(block.timestamp) + lockDuration;
        if (newLockUntil > info.lockUntil) {
            info.lockUntil = newLockUntil;
        }

        totalStaked += amount;

        // Interaction
        bcoToken.safeTransferFrom(msg.sender, address(this), amount);

        emit Deposited(msg.sender, amount, info.lockUntil);
    }

    /**
     * @notice Withdraw staked BCO tokens. Requires lock period expired.
     * @dev Also claims any pending rewards automatically.
     * @param amount Amount of BCO to withdraw.
     */
    function withdraw(uint256 amount) external nonReentrant whenNotPaused updateReward(msg.sender) {
        StakeInfo storage info = stakeInfo[msg.sender];
        if (amount == 0) revert ZeroAmount();
        if (info.amount == 0) revert NothingToWithdraw();
        if (amount > info.amount) revert InsufficientStakedBalance(amount, info.amount);
        if (block.timestamp < info.lockUntil) {
            revert LockNotExpired(info.lockUntil, uint48(block.timestamp));
        }

        // Effects
        info.amount -= amount;
        totalStaked -= amount;

        // Pay earned rewards along with withdraw
        uint256 reward = rewards[msg.sender];
        if (reward > 0) {
            rewards[msg.sender] = 0;
            totalUnclaimedRewards -= reward;
            bcoToken.safeTransfer(msg.sender, reward);
            emit RewardClaimed(msg.sender, reward);
        }

        // Interaction
        bcoToken.safeTransfer(msg.sender, amount);

        emit Withdrawn(msg.sender, amount);
    }

    /**
     * @notice Claim accumulated staking rewards without withdrawing.
     */
    function claimRewards() external nonReentrant whenNotPaused updateReward(msg.sender) {
        uint256 reward = rewards[msg.sender];
        if (reward == 0) revert NoPendingReward();

        rewards[msg.sender] = 0;
        totalUnclaimedRewards -= reward;
        bcoToken.safeTransfer(msg.sender, reward);

        emit RewardClaimed(msg.sender, reward);
    }

    /**
     * @notice Emergency withdraw without claiming rewards.
     * @dev Forfeits all pending rewards. Bypasses lock period. Always available (even when paused).
     *      Use only in emergencies — calling withdraw() is preferred for normal operations.
     */
    function emergencyWithdraw() external nonReentrant {
        StakeInfo storage info = stakeInfo[msg.sender];
        uint256 amount = info.amount;
        if (amount == 0) revert NothingToWithdraw();

        // Effects — reset user completely (forfeit rewards)
        uint256 forfeitedRewards = rewards[msg.sender];
        info.amount = 0;
        info.lockUntil = 0;
        rewards[msg.sender] = 0;
        userRewardPerTokenPaid[msg.sender] = 0;
        totalStaked -= amount;
        if (forfeitedRewards > 0) {
            totalUnclaimedRewards -= forfeitedRewards;
        }

        // Interaction
        bcoToken.safeTransfer(msg.sender, amount);

        emit EmergencyWithdrawn(msg.sender, amount);
    }

    // ──────────────────────────────────────────────
    //  External Functions — Admin
    // ──────────────────────────────────────────────

    /**
     * @notice Start or extend a reward period by depositing reward tokens.
     * @dev REWARD_MANAGER must transfer reward tokens to this contract BEFORE calling.
     *      If a period is active, leftover rewards roll into the new period.
     * @param amount Amount of reward tokens being added for this period.
     */
    function notifyRewardAmount(
        uint256 amount
    ) external onlyRole(REWARD_MANAGER_ROLE) updateReward(address(0)) {
        if (rewardDuration == 0) revert RewardDurationNotSet();
        if (amount == 0) revert ZeroAmount();

        uint256 newRate;
        if (block.timestamp >= periodFinish) {
            // No active period — start fresh
            newRate = amount / rewardDuration;
        } else {
            // Active period — add remaining rewards to new period
            uint256 remaining = (periodFinish - block.timestamp) * rewardRate;
            newRate = (remaining + amount) / rewardDuration;
        }

        rewardRate = newRate;
        lastUpdateTime = block.timestamp;
        periodFinish = block.timestamp + rewardDuration;

        // Verify the contract has enough tokens to cover the full period + unclaimed
        uint256 balance = bcoToken.balanceOf(address(this));
        uint256 required = rewardRate * rewardDuration + totalStaked + totalUnclaimedRewards;
        if (balance < required) revert RewardTooHigh(rewardRate, balance);

        emit RewardAdded(amount, rewardRate, periodFinish);
    }

    /**
     * @notice Set the duration for future reward periods.
     * @dev Cannot change while a period is active (must wait for it to end).
     * @param duration New duration in seconds.
     */
    function setRewardDuration(
        uint256 duration
    ) external onlyRole(REWARD_MANAGER_ROLE) {
        if (block.timestamp < periodFinish) revert RewardPeriodActive();
        if (duration == 0) revert ZeroAmount();
        rewardDuration = duration;
        emit RewardDurationUpdated(duration);
    }

    /**
     * @notice Update lock period parameters.
     * @dev Validates that min > 0 and min <= max to prevent bricking deposit().
     * @param newMinLock Minimum lock duration in seconds (must be > 0).
     * @param newMaxLock Maximum lock duration in seconds (must be >= newMinLock).
     */
    function setLockParameters(
        uint48 newMinLock,
        uint48 newMaxLock
    ) external onlyRole(REWARD_MANAGER_ROLE) {
        if (newMinLock == 0 || newMinLock > newMaxLock) {
            revert InvalidLockParameters(newMinLock, newMaxLock);
        }
        minLockPeriod = newMinLock;
        maxLockPeriod = newMaxLock;
        emit LockParametersUpdated(newMinLock, newMaxLock);
    }

    /**
     * @notice Set supply threshold for direct upgrades.
     * @dev Below threshold: admin calls directly. Above threshold: must come from timelock.
     *      Timelock does NOT need DEFAULT_ADMIN_ROLE — prevents single-admin lockout.
     * @param newLimit New supply threshold in wei.
     */
    function setDirectUpgradeSupplyLimit(uint256 newLimit) external {
        bool isAdmin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        bool isTimelock = msg.sender == timelock;
        if (!isAdmin && !isTimelock) revert Unauthorized();

        if (bcoToken.totalSupply() > directUpgradeSupplyLimit) {
            if (!isTimelock) revert TimelockRequired();
        }
        uint256 oldLimit = directUpgradeSupplyLimit;
        directUpgradeSupplyLimit = newLimit;
        emit DirectUpgradeSupplyLimitChanged(oldLimit, newLimit);
    }

    /**
     * @notice Set the timelock controller address.
     * @dev Below threshold: admin calls directly. Above threshold: must come from timelock.
     *      Timelock does NOT need DEFAULT_ADMIN_ROLE — prevents single-admin lockout.
     * @param newTimelock Address of the TimelockController (cannot be zero).
     */
    function setTimelock(address newTimelock) external {
        if (newTimelock == address(0)) revert ZeroAddress();
        bool isAdmin = hasRole(DEFAULT_ADMIN_ROLE, msg.sender);
        bool isTimelock = msg.sender == timelock;
        if (!isAdmin && !isTimelock) revert Unauthorized();

        if (bcoToken.totalSupply() > directUpgradeSupplyLimit) {
            if (!isTimelock) revert TimelockRequired();
        }
        if (newTimelock == address(this)) revert NotAContract(newTimelock);
        if (newTimelock.code.length == 0) revert NotAContract(newTimelock);
        address old = timelock;
        timelock = newTimelock;
        emit TimelockChanged(old, newTimelock);
    }

    /**
     * @notice Recover ERC20 tokens accidentally sent to this contract.
     * @dev For the staked token (BCO): only excess tokens can be recovered.
     *      Excess = balance - totalStaked - remainingRewards - totalUnclaimedRewards.
     *      Stakers' deposits, committed rewards, and unclaimed rewards are NEVER recoverable.
     *      For any other token: full amount recoverable.
     * @param tokenAddress The ERC20 token to recover.
     * @param amount Amount to recover.
     */
    function recoverERC20(
        address tokenAddress,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (tokenAddress == address(bcoToken)) {
            uint256 excess = excessBCO();
            if (amount > excess) revert InsufficientExcess(amount, excess);
        }
        IERC20(tokenAddress).safeTransfer(msg.sender, amount);
        emit TokenRecovered(tokenAddress, msg.sender, amount);
    }

    /**
     * @notice Recover native currency (TRX/ETH) force-deposited via selfdestruct.
     */
    function recoverNative() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NoNativeToRecover();
        (bool success,) = payable(msg.sender).call{value: balance}("");
        if (!success) revert NativeTransferFailed();
        emit NativeRecovered(msg.sender, balance);
    }

    /**
     * @notice Block admin renouncement (transfer to address(0)).
     * @dev Prevents permanent governance loss. Can be enabled via upgrade if ever needed.
     * @param newAdmin The new admin address (cannot be address(0)).
     */
    function beginDefaultAdminTransfer(address newAdmin) public override {
        if (newAdmin == address(0)) revert AdminRenounceBlocked();
        super.beginDefaultAdminTransfer(newAdmin);
    }

    /**
     * @notice Update the contract metadata URI (ERC-7572).
     * @param newURI New metadata URI (e.g. IPFS or HTTPS URL).
     */
    function setContractURI(string calldata newURI) external onlyRole(DEFAULT_ADMIN_ROLE) {
        _contractURI = newURI;
        emit ContractURIUpdated();
    }

    /**
     * @notice Update issuer identity information stored on-chain.
     * @dev On-chain backup of essential issuer data. Survives even if off-chain storage is lost.
     * @param name Legal name of the issuer (e.g. "REcologic Ltda").
     * @param registration Official registration number (e.g. CNPJ).
     * @param country ISO 3166-1 alpha-2 country code (e.g. "BR").
     */
    function setIssuerInfo(
        string calldata name,
        string calldata registration,
        string calldata country
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        issuerName = name;
        issuerRegistration = registration;
        issuerCountry = country;
        emit IssuerInfoUpdated(name, registration, country);
    }

    /// @notice Pause all staking operations (deposit, withdraw, claimRewards). Emergency only.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume staking operations after emergency pause.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────
    //  View Functions
    // ──────────────────────────────────────────────

    /**
     * @notice Returns the contract metadata URI (ERC-7572).
     * @return URI pointing to a JSON with issuer metadata.
     */
    function contractURI() external view returns (string memory) {
        return _contractURI;
    }

    /**
     * @notice View excess BCO tokens in the contract (safe to recover).
     * @dev Excess = balance - totalStaked - remainingRewards - totalUnclaimedRewards.
     *      Includes unclaimed rewards to prevent draining earned but unclaimed staker rewards.
     * @return Excess BCO amount (0 if none).
     */
    function excessBCO() public view returns (uint256) {
        uint256 balance = bcoToken.balanceOf(address(this));
        uint256 remainingRewards = 0;
        if (block.timestamp < periodFinish) {
            remainingRewards = (periodFinish - block.timestamp) * rewardRate;
        }
        uint256 committed = totalStaked + remainingRewards + totalUnclaimedRewards;
        return balance > committed ? balance - committed : 0;
    }

    /**
     * @notice Returns the smaller of block.timestamp and periodFinish.
     * @dev This is what makes rewards stop automatically when the period ends.
     * @return The last time rewards were applicable.
     */
    function lastTimeRewardApplicable() public view returns (uint256) {
        return block.timestamp < periodFinish ? block.timestamp : periodFinish;
    }

    /**
     * @notice Current accumulated reward per token (precision 1e18).
     * @return The accumulated reward per token.
     */
    function rewardPerToken() public view returns (uint256) {
        if (totalStaked == 0) {
            return rewardPerTokenStored;
        }
        return rewardPerTokenStored +
            ((lastTimeRewardApplicable() - lastUpdateTime) * rewardRate * PRECISION) / totalStaked;
    }

    /**
     * @notice View earned (unclaimed) rewards for a user.
     * @param account The staker's address.
     * @return Earned reward amount.
     */
    function earned(address account) public view returns (uint256) {
        StakeInfo storage info = stakeInfo[account];
        return (info.amount * (rewardPerToken() - userRewardPerTokenPaid[account])) / PRECISION
            + rewards[account];
    }

    /**
     * @notice View pending reward for a user (alias for earned, interface compatibility).
     * @param account The staker's address.
     * @return Pending reward amount.
     */
    function pendingReward(address account) external view returns (uint256) {
        return earned(account);
    }

    // ──────────────────────────────────────────────
    //  Internal Functions
    // ──────────────────────────────────────────────

    /**
     * @dev UUPS upgrade authorization with progressive timelock.
     *      Below directUpgradeSupplyLimit: any UPGRADER_ROLE can upgrade directly.
     *      Above directUpgradeSupplyLimit: upgrade must come from the timelock address.
     */
    function _authorizeUpgrade(
        address /* newImplementation */
    ) internal view override onlyRole(UPGRADER_ROLE) {
        if (bcoToken.totalSupply() > directUpgradeSupplyLimit) {
            if (msg.sender != timelock) revert TimelockRequired();
        }
    }
}
