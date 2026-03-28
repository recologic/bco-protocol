// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {AccessControlDefaultAdminRulesUpgradeable} from "@openzeppelin/contracts-upgradeable/access/extensions/AccessControlDefaultAdminRulesUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardTransient} from "@openzeppelin/contracts/utils/ReentrancyGuardTransient.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IBCOToken} from "../interfaces/IBCOToken.sol";
import {IDeedRegistry} from "../interfaces/IDeedRegistry.sol";

/**
 * @title DeedRegistry
 * @author REcologic
 * @notice On-chain registry of forest property deeds. Single source of truth for BCO supply.
 *
 * @dev UUPS upgradeable. Each registered deed mints BCO tokens at a 1:1 ratio with
 * the deed's area in square meters (1 m² = 1 BCO = 1e18 wei).
 *
 * Invariant: `bcoToken.totalSupply() == totalActiveArea() * 1e18`
 *
 * Validation model: Direct registration by REGISTRAR_ROLE.
 * Multi-sig is handled externally via Gnosis Safe (not in this contract).
 * Protected by: rate limiting, area caps, progressive timelock on role changes.
 *
 * Roles:
 * - DEFAULT_ADMIN_ROLE: Manages all roles. Protected by supply threshold.
 * - REGISTRAR_ROLE: Registers/deactivates deeds. Assign to Gnosis Safe for multi-sig.
 * - PAUSER_ROLE: Emergency pause (direct, no delay).
 * - UPGRADER_ROLE: Contract upgrades. Protected by supply threshold.
 */
contract DeedRegistry is
    IDeedRegistry,
    Initializable,
    AccessControlDefaultAdminRulesUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardTransient,
    UUPSUpgradeable
{
    // Types (DeedStatus, Deed) inherited from IDeedRegistry

    // ──────────────────────────────────────────────
    //  Roles
    // ──────────────────────────────────────────────

    /// @notice Role for registering and deactivating deeds. Assign to Gnosis Safe for multi-sig.
    bytes32 public constant REGISTRAR_ROLE = keccak256("REGISTRAR_ROLE");

    /// @notice Role for emergency pause/unpause.
    bytes32 public constant PAUSER_ROLE = keccak256("PAUSER_ROLE");

    /// @notice Role for UUPS contract upgrades (protected by progressive timelock).
    bytes32 public constant UPGRADER_ROLE = keccak256("UPGRADER_ROLE");

    // ──────────────────────────────────────────────
    //  Constants
    // ──────────────────────────────────────────────

    /// @dev Conversion factor: 1 m² = 1 BCO = 1e18 wei.
    uint256 private constant TOKENS_PER_M2 = 1e18;

    /// @dev Default maximum registrations per day.
    uint256 private constant DEFAULT_MAX_DAILY = 10;

    /// @dev Default maximum area per deed in m² (10M m² = 10 km²).
    uint256 private constant DEFAULT_MAX_AREA = 1e7;

    /// @dev Default supply threshold for progressive timelock (1M BCO).
    uint256 private constant DEFAULT_SUPPLY_THRESHOLD = 1e6 * 1e18;

    /// @dev Maximum length for string parameters (geolocation, documentHash).
    uint256 private constant MAX_STRING_LENGTH = 512;

    // ──────────────────────────────────────────────
    //  State
    // ──────────────────────────────────────────────

    /// @notice Reference to the BCO token contract.
    IBCOToken public bcoToken;

    /// @notice Treasury address that receives minted tokens.
    address public treasury;

    /// @notice Mapping of deed ID to Deed data.
    mapping(bytes32 => Deed) private _deeds;

    /// @notice Array of all deed IDs for enumeration.
    bytes32[] private _deedIds;

    /// @notice Total active area across all registered deeds (in m²).
    uint256 private _totalActiveArea;

    /// @notice Number of active (non-deactivated) deeds.
    uint256 public activeDeedCount;

    // ──── Rate Limiting ────

    /// @notice Maximum registrations per day.
    uint256 public maxDailyRegistrations;

    /// @notice Maximum area per single deed (in m²).
    uint256 public maxAreaPerDeed;

    /// @notice Daily registration counter: day => count.
    mapping(uint256 => uint256) private _dailyRegistrations;

    // ──── Progressive Timelock ────

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

    /// @notice Emitted when a forest deed is registered and tokens are minted.
    event DeedRegistered(
        bytes32 indexed id,
        uint256 areaM2,
        string geolocation,
        string documentHash,
        address indexed registeredBy,
        uint256 tokensMinted
    );

    /// @notice Emitted when a deed is deactivated and tokens are burned.
    event DeedDeactivated(
        bytes32 indexed id,
        uint256 areaM2,
        string reason,
        uint256 tokensBurned
    );

    /// @notice Emitted when a deed's IPFS documents are updated.
    event DocumentsUpdated(
        bytes32 indexed id,
        string oldDocumentHash,
        string newDocumentHash,
        string reason
    );

    /// @notice Emitted when rate limiting parameters are updated.
    event RateLimitsUpdated(
        uint256 maxDailyRegistrations,
        uint256 maxAreaPerDeed
    );

    /// @notice Emitted when the treasury address is updated.
    event TreasuryUpdated(address indexed oldTreasury, address indexed newTreasury);

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

    /// @notice Thrown when trying to register a deed with an existing ID.
    error DeedAlreadyExists(bytes32 id);

    /// @notice Thrown when the deed ID does not exist.
    error DeedNotFound(bytes32 id);

    /// @notice Thrown when the deed is not in ACTIVE status.
    error DeedNotActive(bytes32 id);

    /// @notice Thrown when area is zero.
    error ZeroArea();

    /// @notice Thrown when area exceeds the maximum allowed per deed.
    error AreaExceedsLimit(uint256 area, uint256 limit);

    /// @notice Thrown when daily registration rate limit is exceeded.
    error RateLimitExceeded(uint256 today, uint256 limit);

    /// @notice Thrown when a zero address is provided.
    error ZeroAddress();

    /// @notice Thrown when document hash is empty.
    error EmptyDocumentHash();

    /// @notice Thrown when geolocation is empty.
    error EmptyGeolocation();

    /// @notice Thrown when a string parameter exceeds the maximum length.
    error StringTooLong(uint256 length, uint256 maxLength);

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

    /// @notice Thrown when rate limit values are invalid (must be > 0).
    error InvalidRateLimits(uint256 maxDaily, uint256 maxArea);

    /// @notice Thrown when the timelock address is not a deployed contract.
    error NotAContract(address account);

    // ──────────────────────────────────────────────
    //  Initializer (replaces constructor for UUPS)
    // ──────────────────────────────────────────────

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    /**
     * @notice Initialize the registry.
     * @param bcoTokenAddress Address of the BCO token contract.
     * @param treasuryAddress Address to receive minted tokens.
     * @param adminTransferDelay Delay for DEFAULT_ADMIN_ROLE transfer (e.g. 48 hours).
     * @param defaultAdmin Address for DEFAULT_ADMIN_ROLE.
     * @param registrar Address for REGISTRAR_ROLE (use Gnosis Safe for multi-sig).
     * @param pauser Address for PAUSER_ROLE.
     * @param upgrader Address for UPGRADER_ROLE.
     */
    function initialize(
        address bcoTokenAddress,
        address treasuryAddress,
        uint48 adminTransferDelay,
        address defaultAdmin,
        address registrar,
        address pauser,
        address upgrader
    ) external initializer {
        if (bcoTokenAddress == address(0)) revert ZeroAddress();
        if (treasuryAddress == address(0)) revert ZeroAddress();
        if (defaultAdmin == address(0)) revert ZeroAddress();

        __AccessControlDefaultAdminRules_init(adminTransferDelay, defaultAdmin);
        __Pausable_init();

        bcoToken = IBCOToken(bcoTokenAddress);
        treasury = treasuryAddress;

        maxDailyRegistrations = DEFAULT_MAX_DAILY;
        maxAreaPerDeed = DEFAULT_MAX_AREA;

        directUpgradeSupplyLimit = DEFAULT_SUPPLY_THRESHOLD;

        if (registrar == address(0)) revert ZeroAddress();
        if (pauser == address(0)) revert ZeroAddress();
        if (upgrader == address(0)) revert ZeroAddress();

        _grantRole(REGISTRAR_ROLE, registrar);
        _grantRole(PAUSER_ROLE, pauser);
        _grantRole(UPGRADER_ROLE, upgrader);
    }

    // ──────────────────────────────────────────────
    //  External Functions — Registration
    // ──────────────────────────────────────────────

    /**
     * @notice Register a forest deed and mint BCO tokens (1 m² = 1 BCO).
     * @dev Checks-Effects-Interactions pattern. Rate limited.
     *      Multi-sig is enforced externally if REGISTRAR_ROLE is a Gnosis Safe.
     * @param id Unique deed identifier (keccak256 of documents).
     * @param areaM2 Area in square meters.
     * @param geolocation GPS coordinates or geohash.
     * @param documentHash IPFS CID of supporting documents.
     */
    function registerDeed(
        bytes32 id,
        uint256 areaM2,
        string calldata geolocation,
        string calldata documentHash
    ) external nonReentrant onlyRole(REGISTRAR_ROLE) whenNotPaused {
        // ── CHECKS ──
        if (_deeds[id].registeredAt != 0) revert DeedAlreadyExists(id);
        if (areaM2 == 0) revert ZeroArea();
        if (areaM2 > maxAreaPerDeed) revert AreaExceedsLimit(areaM2, maxAreaPerDeed);
        if (bytes(geolocation).length == 0) revert EmptyGeolocation();
        if (bytes(documentHash).length == 0) revert EmptyDocumentHash();
        if (bytes(geolocation).length > MAX_STRING_LENGTH) revert StringTooLong(bytes(geolocation).length, MAX_STRING_LENGTH);
        if (bytes(documentHash).length > MAX_STRING_LENGTH) revert StringTooLong(bytes(documentHash).length, MAX_STRING_LENGTH);

        _checkRateLimit();

        // ── EFFECTS ──
        uint48 now_ = uint48(block.timestamp);
        _deeds[id] = Deed({
            id: id,
            areaM2: areaM2,
            geolocation: geolocation,
            documentHash: documentHash,
            registeredBy: msg.sender,
            registeredAt: now_,
            deactivatedAt: 0,
            status: DeedStatus.ACTIVE
        });

        _deedIds.push(id);
        _totalActiveArea += areaM2;
        activeDeedCount += 1;

        uint256 today = block.timestamp / 1 days;
        _dailyRegistrations[today] += 1;

        uint256 tokensToMint = areaM2 * TOKENS_PER_M2;

        // ── INTERACTIONS ──
        bcoToken.mint(treasury, tokensToMint);

        emit DeedRegistered(id, areaM2, geolocation, documentHash, msg.sender, tokensToMint);
    }

    /**
     * @notice Deactivate a deed and burn corresponding BCO tokens.
     * @dev The treasury must have approved this contract to burn its tokens.
     * @param deedId The deed identifier.
     * @param reason Human-readable reason for deactivation.
     */
    function deactivateDeed(
        bytes32 deedId,
        string calldata reason
    ) external nonReentrant onlyRole(REGISTRAR_ROLE) whenNotPaused {
        // ── CHECKS ──
        Deed storage e = _deeds[deedId];
        if (e.registeredAt == 0) revert DeedNotFound(deedId);
        if (e.status != DeedStatus.ACTIVE) revert DeedNotActive(deedId);

        // ── EFFECTS ──
        e.status = DeedStatus.DEACTIVATED;
        e.deactivatedAt = uint48(block.timestamp);
        _totalActiveArea -= e.areaM2;
        activeDeedCount -= 1;

        uint256 tokensToBurn = e.areaM2 * TOKENS_PER_M2;

        // ── INTERACTIONS ──
        bcoToken.burnFrom(treasury, tokensToBurn);

        emit DeedDeactivated(deedId, e.areaM2, reason, tokensToBurn);
    }

    /**
     * @notice Update IPFS documents of an existing active deed.
     * @param deedId The deed identifier.
     * @param newDocumentHash New IPFS CID.
     * @param reason Human-readable reason for update.
     */
    function updateDocuments(
        bytes32 deedId,
        string calldata newDocumentHash,
        string calldata reason
    ) external onlyRole(REGISTRAR_ROLE) whenNotPaused {
        Deed storage e = _deeds[deedId];
        if (e.registeredAt == 0) revert DeedNotFound(deedId);
        if (e.status != DeedStatus.ACTIVE) revert DeedNotActive(deedId);
        if (bytes(newDocumentHash).length == 0) revert EmptyDocumentHash();
        if (bytes(newDocumentHash).length > MAX_STRING_LENGTH) revert StringTooLong(bytes(newDocumentHash).length, MAX_STRING_LENGTH);

        string memory oldHash = e.documentHash;
        e.documentHash = newDocumentHash;

        emit DocumentsUpdated(deedId, oldHash, newDocumentHash, reason);
    }

    // ──────────────────────────────────────────────
    //  External Functions — Admin
    // ──────────────────────────────────────────────

    /**
     * @notice Update rate limiting parameters.
     * @dev Both values must be > 0 to prevent bricking registration.
     * @param newMaxDaily Maximum registrations per day (must be >= 1).
     * @param newMaxArea Maximum area per deed in m² (must be >= 1).
     */
    function setRateLimits(
        uint256 newMaxDaily,
        uint256 newMaxArea
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newMaxDaily == 0 || newMaxArea == 0) revert InvalidRateLimits(newMaxDaily, newMaxArea);
        maxDailyRegistrations = newMaxDaily;
        maxAreaPerDeed = newMaxArea;
        emit RateLimitsUpdated(newMaxDaily, newMaxArea);
    }

    /**
     * @notice Update the treasury address.
     * @param newTreasury New treasury address.
     */
    function setTreasury(address newTreasury) external onlyRole(DEFAULT_ADMIN_ROLE) {
        if (newTreasury == address(0)) revert ZeroAddress();
        address old = treasury;
        treasury = newTreasury;
        emit TreasuryUpdated(old, newTreasury);
    }

    /**
     * @notice Set the supply threshold for direct upgrades (without timelock).
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
     * @param tokenAddress The ERC20 token to recover.
     * @param amount Amount to recover.
     */
    function recoverERC20(
        address tokenAddress,
        uint256 amount
    ) external onlyRole(DEFAULT_ADMIN_ROLE) {
        SafeERC20.safeTransfer(IERC20(tokenAddress), msg.sender, amount);
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

    /// @notice Pause registration and deactivation (emergency).
    function pause() external onlyRole(PAUSER_ROLE) {
        _pause();
    }

    /// @notice Resume operations after pause.
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
     * @notice Total active area across all registered deeds (in m²).
     * @return The total active area in square meters.
     */
    function totalActiveArea() external view returns (uint256) {
        return _totalActiveArea;
    }

    /**
     * @notice Verify the supply invariant: totalSupply == totalActiveArea * 1e18.
     * @return True if the invariant holds.
     */
    function verifyInvariant() external view returns (bool) {
        return bcoToken.totalSupply() == _totalActiveArea * TOKENS_PER_M2;
    }

    /**
     * @notice Retrieve a deed by its identifier.
     * @param id The deed identifier.
     * @return The Deed struct for the given identifier.
     */
    function getDeed(bytes32 id) external view returns (Deed memory) {
        if (_deeds[id].registeredAt == 0) revert DeedNotFound(id);
        return _deeds[id];
    }

    /**
     * @notice Total number of deeds ever registered (including deactivated).
     * @return The total deed count.
     */
    function totalDeedCount() external view returns (uint256) {
        return _deedIds.length;
    }

    /**
     * @notice Get today's registration count for rate limit visibility.
     * @return The number of registrations performed today.
     */
    function todayRegistrations() external view returns (uint256) {
        return _dailyRegistrations[block.timestamp / 1 days];
    }

    /**
     * @notice Get a deed ID by its index in the registry.
     * @dev Use with totalDeedCount() to iterate all deeds.
     * @param index Zero-based index.
     * @return The deed ID at that index.
     */
    function getDeedIdByIndex(uint256 index) external view returns (bytes32) {
        if (index >= _deedIds.length) revert DeedNotFound(bytes32(index));
        return _deedIds[index];
    }

    /**
     * @notice Get a paginated list of deed IDs.
     * @dev Allows frontends and block explorers to browse all registered deeds.
     *      Example: getDeedIds(0, 10) returns first 10 IDs.
     * @param offset Start index (0-based).
     * @param limit Maximum number of IDs to return.
     * @return ids Array of deed IDs.
     */
    function getDeedIds(
        uint256 offset,
        uint256 limit
    ) external view returns (bytes32[] memory ids) {
        uint256 total = _deedIds.length;
        if (offset >= total) return new bytes32[](0);

        uint256 end = offset + limit;
        if (end > total) end = total;
        uint256 count = end - offset;

        ids = new bytes32[](count);
        for (uint256 i = 0; i < count;) {
            ids[i] = _deedIds[offset + i];
            unchecked { ++i; }
        }
    }

    /**
     * @notice Verify a document by comparing its IPFS CID with the on-chain record.
     * @dev Public verification: anyone can check if a document matches what's registered.
     *      Returns the full deed data if the document hash matches.
     * @param deedId The deed identifier.
     * @param documentHash The IPFS CID to verify against the on-chain record.
     * @return isValid True if the hash matches the registered document.
     * @return deed The full deed data.
     */
    function verifyDocument(
        bytes32 deedId,
        string calldata documentHash
    ) external view returns (bool isValid, Deed memory deed) {
        if (_deeds[deedId].registeredAt == 0) revert DeedNotFound(deedId);
        deed = _deeds[deedId];
        isValid = keccak256(bytes(deed.documentHash)) == keccak256(bytes(documentHash));
    }

    // ──────────────────────────────────────────────
    //  Internal Functions
    // ──────────────────────────────────────────────

    /// @dev Check that daily rate limit has not been exceeded.
    function _checkRateLimit() internal view {
        uint256 today = block.timestamp / 1 days;
        if (_dailyRegistrations[today] >= maxDailyRegistrations) {
            revert RateLimitExceeded(today, maxDailyRegistrations);
        }
    }

    /**
     * @dev UUPS upgrade authorization with progressive timelock.
     * Below directUpgradeSupplyLimit: any UPGRADER_ROLE can upgrade directly.
     * Above directUpgradeSupplyLimit: upgrade must come from the timelock address.
     */
    function _authorizeUpgrade(
        address /* newImplementation */
    ) internal view override onlyRole(UPGRADER_ROLE) {
        if (bcoToken.totalSupply() > directUpgradeSupplyLimit) {
            if (msg.sender != timelock) revert TimelockRequired();
        }
    }
}
