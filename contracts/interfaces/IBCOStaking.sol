// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IBCOStaking
 * @author REcologic
 * @notice Interface for the BCO Staking Pool — Synthetix StakingRewards model.
 * @dev Deposit BCO to earn rewards over finite periods. Rewards stop automatically
 * when the period ends. No infinite minting — rewards from pre-funded pool only.
 */
interface IBCOStaking {
    /// @notice Deposit BCO tokens into the staking pool.
    /// @param amount Amount of BCO to stake.
    /// @param lockDuration Lock period in seconds.
    function deposit(uint256 amount, uint48 lockDuration) external;

    /// @notice Withdraw staked BCO tokens (requires lock expired).
    /// @param amount Amount of BCO to withdraw.
    function withdraw(uint256 amount) external;

    /// @notice Claim accumulated staking rewards.
    function claimRewards() external;

    /// @notice Emergency withdraw without rewards (forfeits pending rewards).
    function emergencyWithdraw() external;

    /// @notice Start or extend a reward period.
    /// @param amount Amount of reward tokens for this period.
    function notifyRewardAmount(uint256 amount) external;

    /// @notice Set the duration for future reward periods.
    /// @param duration Duration in seconds.
    function setRewardDuration(uint256 duration) external;

    /// @notice View pending rewards for a user.
    /// @param user The staker's address.
    /// @return Pending reward amount.
    function pendingReward(address user) external view returns (uint256);

    /// @notice View earned (unclaimed) rewards for a user.
    /// @param account The staker's address.
    /// @return Earned reward amount.
    function earned(address account) external view returns (uint256);

    /// @notice Current accumulated reward per token.
    /// @return Accumulated reward per token (precision 1e18).
    function rewardPerToken() external view returns (uint256);

    /// @notice Last time rewards were applicable (capped at periodFinish).
    /// @return Timestamp of last applicable reward calculation.
    function lastTimeRewardApplicable() external view returns (uint256);

    /// @notice Total BCO currently staked in the pool.
    /// @return Total staked amount in wei.
    function totalStaked() external view returns (uint256);

    /// @notice Current reward rate (tokens per second).
    /// @return Reward rate in wei per second.
    function rewardRate() external view returns (uint256);

    /// @notice Duration of each reward period.
    /// @return Duration in seconds.
    function rewardDuration() external view returns (uint256);

    /// @notice Timestamp when the current reward period ends.
    /// @return Unix timestamp of period end.
    function periodFinish() external view returns (uint256);

    /// @notice Returns the contract metadata URI (ERC-7572).
    /// @return URI pointing to a JSON with issuer metadata.
    function contractURI() external view returns (string memory);

    /// @notice Update the contract metadata URI (ERC-7572).
    /// @param newURI New metadata URI (e.g. IPFS or HTTPS URL).
    function setContractURI(string calldata newURI) external;

    /// @notice Update issuer identity information stored on-chain.
    /// @param name Legal name of the issuer.
    /// @param registration Official registration number (e.g. CNPJ).
    /// @param country ISO 3166-1 alpha-2 country code.
    function setIssuerInfo(string calldata name, string calldata registration, string calldata country) external;
}
