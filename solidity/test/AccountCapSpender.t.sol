// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

import {AccountCapSpender, ISpendPermissionManager} from "../src/AccountCapSpender.sol";
import {MockSpendPermissionManager, MockToken} from "./Mocks.sol";

/// @dev The Foundry cheatcodes these tests use, without a forge-std dependency.
interface Vm {
    function warp(uint256 timestamp) external;
    function prank(address sender) external;
    function expectRevert(bytes4 selector) external;
    function expectRevert(bytes calldata data) external;
}

contract AccountCapSpenderTest {
    Vm internal constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    uint256 internal constant CAP = 150e6; // $150 of a 6-decimal stablecoin
    uint256 internal constant PER_PAYMENT = 50e6;
    uint256 internal constant WINDOW = 1 days;
    uint48 internal constant START = 1_000_000;

    address internal account = address(0xA11CE);
    address internal agent = address(0xA9E47);
    address internal payee = address(0xBEEF);

    MockToken internal token;
    MockSpendPermissionManager internal manager;
    AccountCapSpender internal spender;

    function setUp() public {
        vm.warp(START);
        token = new MockToken();
        manager = new MockSpendPermissionManager();
        address[] memory payees = new address[](1);
        payees[0] = payee;
        spender = new AccountCapSpender(manager, agent, CAP, WINDOW, PER_PAYMENT, payees);
        token.mint(account, 1_000e6);
        vm.prank(account);
        token.approve(address(manager), type(uint256).max);
    }

    function _permission(uint256 salt) internal view returns (ISpendPermissionManager.SpendPermission memory) {
        return ISpendPermissionManager.SpendPermission({
            account: account,
            spender: address(spender),
            token: address(token),
            allowance: uint160(CAP),
            period: uint48(WINDOW),
            start: START,
            end: START + 30 days,
            salt: salt,
            extraData: ""
        });
    }

    function _pay(ISpendPermissionManager.SpendPermission memory permission, uint256 amount) internal {
        vm.prank(agent);
        spender.pay(permission, uint160(amount), payee);
    }

    function test_two_permissions_share_one_budget() public {
        // Each permission alone allows $150 a day; together the manager would allow $300.
        for (uint256 i; i < 3; ++i) _pay(_permission(1), PER_PAYMENT);
        vm.expectRevert(abi.encodeWithSelector(AccountCapSpender.OverBudget.selector, CAP, PER_PAYMENT, CAP));
        _pay(_permission(2), PER_PAYMENT);
        require(spender.spentInWindow(account, address(token)) == CAP, "window total");
        require(token.balanceOf(payee) == CAP, "payee paid the cap");
    }

    function test_a_period_boundary_does_not_double_the_budget() public {
        vm.warp(START + WINDOW - 1); // the permission's first period ends in a second
        for (uint256 i; i < 3; ++i) _pay(_permission(1), PER_PAYMENT);
        vm.warp(START + WINDOW); // a fresh period: the manager would allow $150 more
        vm.expectRevert(abi.encodeWithSelector(AccountCapSpender.OverBudget.selector, CAP, PER_PAYMENT, CAP));
        _pay(_permission(1), PER_PAYMENT);
    }

    function test_spend_counts_for_the_whole_window_then_ages_out() public {
        for (uint256 i; i < 3; ++i) _pay(_permission(1), PER_PAYMENT);
        vm.warp(START + WINDOW); // a payment counts while at + window >= now
        vm.expectRevert(abi.encodeWithSelector(AccountCapSpender.OverBudget.selector, CAP, PER_PAYMENT, CAP));
        _pay(_permission(2), PER_PAYMENT);
        vm.warp(START + WINDOW + 1);
        require(spender.spentInWindow(account, address(token)) == 0, "aged out");
        _pay(_permission(2), PER_PAYMENT);
        require(spender.spentInWindow(account, address(token)) == PER_PAYMENT, "one payment counts");
    }

    function test_only_the_agent_can_pay() public {
        vm.expectRevert(AccountCapSpender.NotAgent.selector);
        spender.pay(_permission(1), uint160(PER_PAYMENT), payee);
    }

    function test_only_allowlisted_payees_are_paid() public {
        address stranger = address(0xBAD);
        vm.prank(agent);
        vm.expectRevert(abi.encodeWithSelector(AccountCapSpender.PayeeNotAllowed.selector, stranger));
        spender.pay(_permission(1), uint160(PER_PAYMENT), stranger);
    }

    function test_a_payment_over_the_per_payment_max_is_refused() public {
        vm.expectRevert(
            abi.encodeWithSelector(AccountCapSpender.OverPerPayment.selector, PER_PAYMENT + 1, PER_PAYMENT)
        );
        _pay(_permission(1), PER_PAYMENT + 1);
    }

    function test_a_permission_for_another_spender_is_refused() public {
        ISpendPermissionManager.SpendPermission memory permission = _permission(1);
        permission.spender = agent;
        vm.expectRevert(AccountCapSpender.WrongSpender.selector);
        _pay(permission, PER_PAYMENT);
    }

    function test_a_revoked_permission_cannot_be_drawn() public {
        ISpendPermissionManager.SpendPermission memory permission = _permission(1);
        vm.prank(account);
        manager.revoke(permission);
        vm.expectRevert(bytes("revoked"));
        _pay(permission, PER_PAYMENT);
        require(spender.spentInWindow(account, address(token)) == 0, "nothing counted");
    }

    function test_the_constructor_refuses_a_bad_configuration() public {
        address[] memory payees = new address[](1);
        payees[0] = payee;
        vm.expectRevert(AccountCapSpender.InvalidConfiguration.selector);
        new AccountCapSpender(manager, agent, CAP, WINDOW, CAP + 1, payees);
        vm.expectRevert(AccountCapSpender.InvalidConfiguration.selector);
        new AccountCapSpender(manager, agent, CAP, 0, PER_PAYMENT, payees);
        vm.expectRevert(AccountCapSpender.InvalidConfiguration.selector);
        new AccountCapSpender(manager, agent, CAP, WINDOW, PER_PAYMENT, new address[](0));
    }
}
