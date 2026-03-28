// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {ERC20Pausable} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Pausable.sol";
import {ERC20Permit} from "@openzeppelin/contracts/token/ERC20/extensions/ERC20Permit.sol";
import {AccessControlDefaultAdminRules} from "@openzeppelin/contracts/access/extensions/AccessControlDefaultAdminRules.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBCOToken} from "../interfaces/IBCOToken.sol";

/**
 * @title BCOToken
 * @author REcologic
 * @notice Forest-backed TRC20 token for the REcologic ecosystem.
 *
 * @dev IMMUTABLE (no proxy, no upgrades). Supply is elastic — minted when forest deeds
 * are registered and burned when deeds are deactivated. The invariant
 * `totalSupply() / 1e18 == totalActiveArea()` is enforced by the DeedRegistry.
 *
 * IMPORTANT: Holders CANNOT burn tokens. Burn is restricted to BURNER_ROLE
 * (DeedRegistry only) to preserve the 1:1 forest-backing invariant.
 *
 * No freeze, seizure, or address blocking — token holders have full custody.
 *
 * Admin safety: Uses AccessControlDefaultAdminRules (OZ v5) — exactly 1 admin
 * at a time, 2-step transfer with delay. Prevents accidental lockout and adds protection
 * against compromised admin keys (delay gives time to detect and cancel).
 *
 * Roles:
 * - DEFAULT_ADMIN_ROLE: Manages all roles. 2-step transfer with delay.
 * - MINTER_ROLE: DeedRegistry only (sole authority to mint).
 * - BURNER_ROLE: DeedRegistry only (sole authority to burn, on deed deactivation).
 * - PAUSER_ROLE: Multi-sig 3/5 (emergency circuit breaker — pauses ALL transfers).
 */
contract BCOToken is
    IBCOToken,
    ERC20,
    ERC20Pausable,
    ERC20Permit,
    AccessControlDefaultAdminRules
{
    // ──────────────────────────────────────────────
    //  Roles
    // ──────────────────────────────────────────────

    /// @notice Role required to mint new tokens. Granted only to DeedRegistry.
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    /// @notice Role required to burn tokens. Granted only to DeedRegistry.
    bytes32 public constant BURNER_ROLE = keccak256("BURNER_ROLE");

    /// @notice Role required to pause/unpause ALL transfers. Granted to multi-sig.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────

    /// @notice Legal name of the token issuer (on-chain backup).
    string public issuerName;

    /// @notice Official registration number of the issuer (e.g. CNPJ).
    string public issuerRegistration;

    /// @notice Country code of the issuer (ISO 3166-1 alpha-2, e.g. "BR").
    string public issuerCountry;

    /// @notice Contract metadata URI (ERC-7572). Points to JSON with issuer details.
    string private _contractURI;

    // ──────────────────────────────────────────────
    //  Events
    // ──────────────────────────────────────────────

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

    /// @notice Thrown when trying to mint zero tokens.
    error ZeroMintAmount();

    /// @notice Thrown when trying to mint to the zero address.
    error MintToZeroAddress();

    /// @notice Thrown when trying to burn zero tokens.
    error ZeroBurnAmount();

    /// @notice Thrown when address is zero.
    error ZeroAddress();

    /// @notice Thrown when attempting to renounce admin (transfer to address(0)).
    error AdminRenounceBlocked();

    /// @notice Thrown when there is no native currency to recover.
    error NoNativeToRecover();

    /// @notice Thrown when native currency transfer fails.
    error NativeTransferFailed();

    // ──────────────────────────────────────────────
    //  Constructor
    // ──────────────────────────────────────────────

    /**
     * @notice Deploy the BCO token (immutable, no proxy).
     * @param adminTransferDelay Delay for admin transfer (e.g. 48 hours).
     * @param defaultAdmin Address that receives DEFAULT_ADMIN_ROLE.
     * @param pauser Address that receives PAUSER_ROLE (multi-sig 3/5).
     */
    constructor(
        uint48 adminTransferDelay,
        address defaultAdmin,
        address pauser
    )
        ERC20("Biocoin", "BCO")
        ERC20Permit("Biocoin")
        AccessControlDefaultAdminRules(adminTransferDelay, defaultAdmin)
    {
        if (defaultAdmin == address(0)) revert ZeroAddress();
        if (pauser == address(0)) revert ZeroAddress();

        _grantRole(PAUSER_ROLE, pauser);
    }

    // ──────────────────────────────────────────────
    //  External Functions — Supply
    // ──────────────────────────────────────────────

    /**
     * @notice Mint new BCO tokens. Only callable by DeedRegistry.
     * @param to Recipient address.
     * @param amount Amount of tokens to mint (18 decimals).
     */
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        if (to == address(0)) revert MintToZeroAddress();
        if (amount == 0) revert ZeroMintAmount();
        _mint(to, amount);
    }

    /**
     * @notice Burn tokens from an account. Only callable by DeedRegistry
     * when a deed is deactivated.
     * @dev The account must have approved this contract (via ERC20.approve) for the amount.
     * @param account The account whose tokens will be burned.
     * @param amount Amount of tokens to burn.
     */
    function burnFrom(
        address account,
        uint256 amount
    ) external override onlyRole(BURNER_ROLE) {
        if (amount == 0) revert ZeroBurnAmount();
        _spendAllowance(account, _msgSender(), amount);
        _burn(account, amount);
    }

    // ──────────────────────────────────────────────
    //  External Functions — Emergency
    // ──────────────────────────────────────────────

    /// @notice Pause all token transfers. Emergency only.
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume token transfers after emergency pause.
    function unpause() external onlyRole(PAUSER_ROLE) {
        _unpause();
    }

    // ──────────────────────────────────────────────
    //  External Functions — Admin
    // ──────────────────────────────────────────────

    /**
     * @notice Recover ERC20 tokens accidentally sent to this contract.
     * @dev Only DEFAULT_ADMIN_ROLE can call. Works for any ERC20 token.
     * @param tokenAddress The ERC20 token to recover.
     * @param amount Amount to recover.
     */
    function recoverERC20(
        address tokenAddress,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        SafeERC20.safeTransfer(IERC20(tokenAddress), _msgSender(), amount);
        emit TokenRecovered(tokenAddress, _msgSender(), amount);
    }

    /**
     * @notice Recover native currency (TRX/ETH) force-deposited via selfdestruct.
     * @dev This contract has no receive/fallback, so native currency can only arrive
     *      via selfdestruct (deprecated but still functional on some chains).
     */
    function recoverNative() external onlyRole(DEFAULT_ADMIN_ROLE) {
        uint256 balance = address(this).balance;
        if (balance == 0) revert NoNativeToRecover();
        (bool success,) = payable(_msgSender()).call{value: balance}("");
        if (!success) revert NativeTransferFailed();
        emit NativeRecovered(_msgSender(), balance);
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

    /**
     * @notice Block admin renouncement (transfer to address(0)).
     * @dev Admin can transfer to any valid address but NEVER renounce.
     *      This prevents permanent governance loss.
     * @param newAdmin The new admin address (cannot be address(0)).
     */
    function beginDefaultAdminTransfer(
        address newAdmin
    ) public override {
        if (newAdmin == address(0)) revert AdminRenounceBlocked();
        super.beginDefaultAdminTransfer(newAdmin);
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

    // ──────────────────────────────────────────────
    //  Internal Functions
    // ──────────────────────────────────────────────

    /**
     * @dev Override required to resolve diamond inheritance (ERC20 + ERC20Pausable).
     *      ERC20Pausable adds the whenNotPaused check to all transfers.
     */
    function _update(
        address from,
        address to,
        uint256 value
    ) internal override(ERC20, ERC20Pausable) {
        super._update(from, to, value);
    }

    // ──────────────────────────────────────────────
    //  Required Overrides
    // ──────────────────────────────────────────────

    /// @inheritdoc AccessControlDefaultAdminRules
    function supportsInterface(
        bytes4 interfaceId
    ) public view override(AccessControlDefaultAdminRules) returns (bool) {
        return super.supportsInterface(interfaceId);
    }

    /// @notice Returns the total supply of BCO tokens.
    /// @return Total number of BCO tokens in existence (18 decimals).
    function totalSupply()
        public
        view
        override(ERC20, IBCOToken)
        returns (uint256)
    {
        return super.totalSupply();
    }
}
