// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @notice Test-only token that tries to re-enter a target contract in the middle of a transfer
 *         (like a malicious ERC-777-style hook). Used to prove the protocol's reentrancy guard works.
 */
contract ReentrantToken is ERC20 {
    address public target;
    bytes public payload;
    bool public armed;
    bool public attempted;
    bool public reentrySucceeded;
    bytes public lastRevertData;

    constructor() ERC20("Reentrant Token", "RE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    /// @notice The next transfer will try to call `target_` with `payload_`.
    function arm(address target_, bytes calldata payload_) external {
        target = target_;
        payload = payload_;
        armed = true;
        attempted = false;
        reentrySucceeded = false;
        delete lastRevertData;
    }

    function _update(address from, address to, uint256 value) internal override {
        super._update(from, to, value);
        if (armed && from != address(0) && to != address(0)) {
            armed = false; // only try once
            attempted = true;
            (bool ok, bytes memory data) = target.call(payload);
            reentrySucceeded = ok;
            lastRevertData = data;
        }
    }
}
