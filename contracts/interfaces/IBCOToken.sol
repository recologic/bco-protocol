// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title IBCOToken
 * @author REcologic
 * @notice Interface for BCO Token custom functions (mint, burn, pause).
 * @dev Only declares functions NOT already in ERC20 to avoid
 * diamond inheritance conflicts when BCOToken inherits both ERC20 and this interface.
 * Note: BCOToken does NOT inherit ERC20Burnable — holders cannot burn tokens.
 */
interface IBCOToken {
    /// @notice Mint new BCO tokens. Restricted to MINTER_ROLE.
    /// @param to Recipient address.
    /// @param amount Amount of tokens to mint (18 decimals).
    function mint(address to, uint256 amount) external;

    /// @notice Burn tokens from an account using allowance. Restricted to BURNER_ROLE.
    /// @param account The account whose tokens will be burned.
    /// @param amount Amount of tokens to burn.
    function burnFrom(address account, uint256 amount) external;

    /// @notice Returns the total supply of BCO tokens.
    /// @return Total number of BCO tokens in existence (18 decimals).
    function totalSupply() external view returns (uint256);

    /// @notice Pause all token transfers (emergency).
    function pause() external;

    /// @notice Resume token transfers after pause.
    function unpause() external;

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
