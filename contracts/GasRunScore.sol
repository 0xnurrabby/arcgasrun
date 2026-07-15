// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/// @title GasRunScore — weekly leaderboard score commits on Arc
contract GasRunScore {
    event ActionLogged(
        address indexed user,
        bytes32 indexed action,
        uint256 timestamp,
        bytes data
    );

    function logAction(bytes32 action, bytes calldata data) external {
        emit ActionLogged(msg.sender, action, block.timestamp, data);
    }
}
