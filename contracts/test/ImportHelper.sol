// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

// This file exists only to force Hardhat to compile OpenZeppelin contracts
// that are used in tests but not directly imported by our contracts.

import {TimelockController} from "@openzeppelin/contracts/governance/TimelockController.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
