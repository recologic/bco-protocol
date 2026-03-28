// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/**
 * @title SelfDestructAttacker
 * @dev Test helper to simulate force-depositing ETH/TRX via selfdestruct.
 *      Only used in tests — never deployed on mainnet.
 */
contract SelfDestructAttacker {
    receive() external payable {}

    function attack(address target) external {
        selfdestruct(payable(target));
    }
}
