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
///
/// The window is counted in `BUCKETS` equal buckets of `bucketWidth` seconds, kept in
/// a fixed ring of `BUCKETS + 1` storage slots per account and token. Every `pay` reads
/// the same number of slots however many payments came before it, so a burst of tiny
/// payments cannot make a later payment too expensive to run. A payment counts as if it
/// were made at the last second of its bucket: from when it is made until its bucket's
/// end plus `window`. That is up to one bucket longer than an exact log, never shorter,
/// so no `window`-long span of time ever holds more than `cap`.
contract AccountCapSpender {
    address internal constant NATIVE_TOKEN = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    /// @notice How many buckets the window is counted in.
    uint256 public constant BUCKETS = 24;

    /// @dev One bucket: its index (timestamp / bucketWidth) and what was paid in it. One slot.
    struct Bucket {
        uint64 index;
        uint192 amount;
    }

    ISpendPermissionManager public immutable manager;
    address public immutable agent;
    uint256 public immutable cap;
    uint256 public immutable window;
    /// @notice `window / BUCKETS` seconds.
    uint256 public immutable bucketWidth;
    uint256 public immutable perPayment;

    mapping(address payee => bool) public allowedPayee;
    /// @dev Bucket i lives in slot i % (BUCKETS + 1): the BUCKETS + 1 buckets that can
    /// still count always occupy distinct slots.
    mapping(bytes32 accountToken => Bucket[BUCKETS + 1]) internal ledgers;

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

    /// @param window_ The rolling window in seconds: a positive multiple of BUCKETS.
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
                || window_ % BUCKETS != 0 || perPayment_ == 0 || perPayment_ > cap_
                || cap_ > type(uint192).max || payees.length == 0
        ) revert InvalidConfiguration();
        manager = manager_;
        agent = agent_;
        cap = cap_;
        window = window_;
        bucketWidth = window_ / BUCKETS;
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
        Bucket[BUCKETS + 1] storage ledger = ledgers[_key(permission.account, permission.token)];
        uint256 current = block.timestamp / bucketWidth;
        uint256 total = _counted(ledger, current);
        if (total + amount > cap) revert OverBudget(total, amount, cap);
        Bucket storage bucket = ledger[current % (BUCKETS + 1)];
        if (bucket.index == current) {
            bucket.amount += uint192(amount); // total + amount <= cap <= type(uint192).max
        } else {
            bucket.index = uint64(current);
            bucket.amount = uint192(amount);
        }
        manager.spend(permission, amount);
        _transfer(permission.token, payee, amount);
        emit Paid(permission.account, permission.token, payee, amount, total + amount);
    }

    /// @notice What `account` has paid in `token` that still counts against the cap.
    function spentInWindow(address account, address token) external view returns (uint256) {
        return _counted(ledgers[_key(account, token)], block.timestamp / bucketWidth);
    }

    /// @dev Bucket i counts while (i + 1) * bucketWidth - 1 + window >= now, which is
    /// exactly i + BUCKETS >= current. A stale slot holds an older index and is skipped.
    function _counted(Bucket[BUCKETS + 1] storage ledger, uint256 current) internal view returns (uint256 total) {
        for (uint256 slot; slot <= BUCKETS; ++slot) {
            Bucket storage bucket = ledger[slot];
            if (uint256(bucket.index) + BUCKETS >= current) total += bucket.amount;
        }
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
