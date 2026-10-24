// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";

/**
 * @title MockERC20
 * @notice A free-to-mint ERC-20 token used ONLY for local tests and testnets.
 * @dev `mint` has no access control on purpose so anyone can get test tokens.
 *      Never use this contract (or its pattern) for real value.
 */
contract MockERC20 is ERC20 {
    uint8 private immutable _decimals;

    constructor(string memory name_, string memory symbol_, uint8 decimals_) ERC20(name_, symbol_) {
        _decimals = decimals_;
    }

    function decimals() public view override returns (uint8) {
        return _decimals;
    }

    /// @notice Mint `amount` (in the token's smallest unit) to `to`. Open to everyone (test only).
    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }
}
