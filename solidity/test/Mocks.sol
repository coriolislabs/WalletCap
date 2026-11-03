// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {ISpendPermissionManager} from "../src/AccountCapSpender.sol";

/// @dev A minimal ERC-20 for tests.
contract MockToken {
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amount) external {
        balanceOf[to] += amount;
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        return true;
    }
}

/// @dev Counts each allowance per permission and per fixed period, and honours revokes, as
/// Coinbase's SpendPermissionManager does; it pulls the tokens with a plain ERC-20 approval.
contract MockSpendPermissionManager is ISpendPermissionManager {
    mapping(bytes32 => mapping(uint256 => uint256)) public spentInPeriod;
    mapping(bytes32 => bool) public revoked;

    function revoke(SpendPermission calldata spendPermission) external {
        require(msg.sender == spendPermission.account, "not the account");
        revoked[keccak256(abi.encode(spendPermission))] = true;
    }

    function spend(SpendPermission calldata spendPermission, uint160 value) external {
        require(msg.sender == spendPermission.spender, "not the spender");
        bytes32 id = keccak256(abi.encode(spendPermission));
        require(!revoked[id], "revoked");
        require(block.timestamp >= spendPermission.start && block.timestamp < spendPermission.end, "inactive");
        uint256 period = (block.timestamp - spendPermission.start) / spendPermission.period;
        require(spentInPeriod[id][period] + value <= spendPermission.allowance, "allowance");
        spentInPeriod[id][period] += value;
        require(MockToken(spendPermission.token).transferFrom(spendPermission.account, msg.sender, value));
    }
}
