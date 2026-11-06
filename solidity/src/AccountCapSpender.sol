// SPDX-License-Identifier: Apache-2.0
pragma solidity ^0.8.28;

/// @notice The part of Coinbase's SpendPermissionManager this contract calls. The
/// struct matches SpendPermissionManager.SpendPermission field for field.
interface ISpendPermissionManager {
    struct SpendPermission {
        address account;
        address spender;
        address token;
        uint160 allowance;
        uint48 period;
        uint48 start;
        uint48 end;
        uint256 salt;
        bytes extraData;
    }

    function spend(SpendPermission calldata spendPermission, uint160 value) external;
}

/// @custom:security UNAUDITED. Testnet only until an independent audit; see solidity/README.md.
/// @title AccountCapSpender
/// @notice One rolling budget per account and token across every Spend Permission
/// that names this contract as its spender.
/// @dev Spend Permissions count each allowance per permission and per fixed period,
/// so a second permission, or two payments either side of a period boundary, pass
/// the owner's intended daily budget. Every payment through this contract counts
/// against one rolling window instead. Only `agent` may pay, only to an allowlisted
/// payee, at most `perPayment` at a time and `cap` in any `window` seconds. A revoke
/// that the owner lands later in the same block is not visible here, so a payment
/// ordered ahead of it in that block still settles.
contract AccountCapSpender {
    address internal constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    struct Payment {
        uint64 at;
        uint192 amount;
    }

    /// @dev payments[head:] are the ones still inside the window; total is their sum.
    struct Ledger {
        Payment[] payments;
        uint256 head;
        uint256 total;
    }

    ISpendPermissionManager public immutable manager;
    address public immutable agent;
    uint256 public immutable cap;
    uint256 public immutable window;
    uint256 public immutable perPayment;

    mapping(address payee => bool) public allowedPayee;
    mapping(bytes32 accountToken => Ledger) internal ledgers;

    event Paid(
        address indexed account,
        address indexed token,
        address indexed payee,
        uint256 amount,
        uint256 spentInWindow
    );

    error InvalidConfiguration();
    error NotAgent();
    error PayeeNotAllowed(address payee);
    error WrongSpender();
    error NativeTokenUnsupported();
    error OverPerPayment(uint256 amount, uint256 perPayment);
    error OverBudget(uint256 spentInWindow, uint256 amount, uint256 cap);
    error TransferFailed();

    constructor(
        ISpendPermissionManager manager_,
        address agent_,
        uint256 cap_,
        uint256 window_,
        uint256 perPayment_,
        address[] memory payees
    ) {
        if (
            address(manager_) == address(0) || agent_ == address(0) || window_ == 0
                || perPayment_ == 0 || perPayment_ > cap_ || cap_ > type(uint192).max
                || payees.length == 0
        ) revert InvalidConfiguration();
        manager = manager_;
        agent = agent_;
        cap = cap_;
        window = window_;
        perPayment = perPayment_;
        for (uint256 i; i < payees.length; ++i) {
            if (payees[i] == address(0)) revert InvalidConfiguration();
            allowedPayee[payees[i]] = true;
        }
    }

    /// @notice Draw `amount` through `permission` and pay it to `payee`.
    function pay(ISpendPermissionManager.SpendPermission calldata permission, uint160 amount, address payee)
        external
    {
        if (msg.sender != agent) revert NotAgent();
        if (!allowedPayee[payee]) revert PayeeNotAllowed(payee);
        if (permission.spender != address(this)) revert WrongSpender();
        if (permission.token == NATIVE_TOKEN) revert NativeTokenUnsupported();
        if (amount > perPayment) revert OverPerPayment(amount, perPayment);
        Ledger storage ledger = ledgers[_key(permission.account, permission.token)];
        uint256 total = _expire(ledger);
        if (total + amount > cap) revert OverBudget(total, amount, cap);
        ledger.payments.push(Payment({at: uint64(block.timestamp), amount: uint192(amount)}));
        ledger.total = total + amount;
        manager.spend(permission, amount);
        _transfer(permission.token, payee, amount);
        emit Paid(permission.account, permission.token, payee, amount, total + amount);
    }

    /// @notice What `account` has paid in `token` inside the current window.
    function spentInWindow(address account, address token) external view returns (uint256 total) {
        Ledger storage ledger = ledgers[_key(account, token)];
        total = ledger.total;
        for (uint256 i = ledger.head; i < ledger.payments.length; ++i) {
            Payment memory payment = ledger.payments[i];
            if (uint256(payment.at) + window >= block.timestamp) break;
            total -= payment.amount;
        }
    }

    /// @dev Drops payments that left the window (oldest first) and returns what still counts.
    function _expire(Ledger storage ledger) internal returns (uint256 total) {
        total = ledger.total;
        uint256 head = ledger.head;
        uint256 length = ledger.payments.length;
        while (head < length) {
            Payment memory payment = ledger.payments[head];
            if (uint256(payment.at) + window >= block.timestamp) break;
            total -= payment.amount;
            delete ledger.payments[head];
            ++head;
        }
        ledger.head = head;
    }

    function _key(address account, address token) internal pure returns (bytes32) {
        return keccak256(abi.encode(account, token));
    }

    function _transfer(address token, address to, uint256 amount) internal {
        if (token.code.length == 0) revert TransferFailed();
        (bool ok, bytes memory data) = token.call(abi.encodeWithSelector(0xa9059cbb, to, amount));
        if (!ok || (data.length != 0 && !abi.decode(data, (bool)))) revert TransferFailed();
    }
}
