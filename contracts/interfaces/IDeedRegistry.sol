// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IDeedRegistry
 * @author REcologic
 * @notice Interface for the Deed Registry — on-chain registry of forest property deeds.
 * @dev Single source of truth for BCO token supply. Each registered deed backs tokens 1:1 with m².
 */
interface IDeedRegistry {
    /// @notice Status of a registered deed.
    enum DeedStatus {
        ACTIVE,
        DEACTIVATED
    }

    /// @notice On-chain representation of a forest property deed.
    struct Deed {
        bytes32 id;
        uint256 areaM2;
        string geolocation;
        string documentHash;
        address registeredBy;
        uint48 registeredAt;
        uint48 deactivatedAt;
        DeedStatus status;
    }

    /// @notice Register a new forest deed and mint corresponding BCO tokens.
    /// @param id Unique identifier (keccak256 hash of documents).
    /// @param areaM2 Area in square meters.
    /// @param geolocation GPS coordinates or geohash.
    /// @param documentHash IPFS CID of supporting documents.
    function registerDeed(
        bytes32 id,
        uint256 areaM2,
        string calldata geolocation,
        string calldata documentHash
    ) external;

    /// @notice Deactivate a deed and burn corresponding BCO tokens.
    /// @param deedId The deed identifier.
    /// @param reason Human-readable reason for deactivation.
    function deactivateDeed(bytes32 deedId, string calldata reason) external;

    /// @notice Update the IPFS documents of an existing deed.
    /// @param deedId The deed identifier.
    /// @param newDocumentHash New IPFS CID.
    /// @param reason Human-readable reason for update.
    function updateDocuments(
        bytes32 deedId,
        string calldata newDocumentHash,
        string calldata reason
    ) external;

    /// @notice Total active area across all registered deeds.
    /// @return Total area in square meters.
    function totalActiveArea() external view returns (uint256);

    /// @notice Verify the supply invariant: totalSupply == totalActiveArea * 1e18.
    /// @return True if the invariant holds.
    function verifyInvariant() external view returns (bool);

    /// @notice Retrieve a deed by its identifier.
    /// @param id The deed identifier.
    /// @return The Deed struct.
    function getDeed(bytes32 id) external view returns (Deed memory);

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
