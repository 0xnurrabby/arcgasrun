// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title GasRunVault — Arc Testnet USDC payout vault for GasRun
/// @notice Accepts native USDC (msg.value) and ERC-20 USDC. On Arc they share one balance.
/// @dev Native USDC = 18 decimals; ERC-20 USDC = 6 decimals. App payouts use 6 decimals.
contract GasRunVault {
    address public owner;
    address public operator;
    IERC20 public immutable usdc;

    // 1 USDC (6 dec) = 1e12 native wei (18 dec)
    uint256 private constant NATIVE_PER_ERC20_UNIT = 1e12;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event Deposited(address indexed from, uint256 amountNativeOrErc20, bool isNative);
    event Payout(address indexed to, uint256 amountErc20, bytes32 indexed ref);
    event AdminWithdraw(address indexed to, uint256 amountErc20);

    modifier onlyOwner() {
        require(msg.sender == owner, "not owner");
        _;
    }

    modifier onlyOperator() {
        require(msg.sender == operator || msg.sender == owner, "not operator");
        _;
    }

    constructor(address usdcToken, address initialOwner, address initialOperator) {
        require(usdcToken != address(0), "usdc=0");
        require(initialOwner != address(0), "owner=0");
        require(initialOperator != address(0), "operator=0");
        usdc = IERC20(usdcToken);
        owner = initialOwner;
        operator = initialOperator;
        emit OwnershipTransferred(address(0), initialOwner);
        emit OperatorUpdated(address(0), initialOperator);
    }

    /// @notice Accept native USDC (MetaMask "Send" / value transfer)
    receive() external payable {
        require(msg.value > 0, "amount=0");
        emit Deposited(msg.sender, msg.value, true);
    }

    fallback() external payable {
        require(msg.value > 0, "amount=0");
        emit Deposited(msg.sender, msg.value, true);
    }

    function transferOwnership(address newOwner) external onlyOwner {
        require(newOwner != address(0), "owner=0");
        emit OwnershipTransferred(owner, newOwner);
        owner = newOwner;
    }

    function setOperator(address newOperator) external onlyOwner {
        require(newOperator != address(0), "operator=0");
        emit OperatorUpdated(operator, newOperator);
        operator = newOperator;
    }

    /// @notice Fund vault with ERC-20 USDC (6 decimals)
    function deposit(uint256 amount) external {
        require(amount > 0, "amount=0");
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        emit Deposited(msg.sender, amount, false);
    }

    /// @notice Instant user payout — amount in ERC-20 units (6 decimals)
    function payout(address to, uint256 amount, bytes32 ref) external onlyOperator {
        require(to != address(0), "to=0");
        require(amount > 0, "amount=0");
        _sendUsdc(to, amount);
        emit Payout(to, amount, ref);
    }

    /// @notice Owner pulls USDC — amount in ERC-20 units (6 decimals)
    function adminWithdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "to=0");
        require(amount > 0, "amount=0");
        _sendUsdc(to, amount);
        emit AdminWithdraw(to, amount);
    }

    /// @notice ERC-20 balance view (6 decimals). Reflects native + ERC-20 deposits on Arc.
    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function nativeBalance() external view returns (uint256) {
        return address(this).balance;
    }

    /// @dev Prefer ERC-20 transfer; fallback to native send (Arc dual interface).
    function _sendUsdc(address to, uint256 amountErc20) internal {
        // Try ERC-20 first (6 decimals)
        try usdc.transfer(to, amountErc20) returns (bool ok) {
            if (ok) return;
        } catch {}

        // Native fallback: 6-dec -> 18-dec
        uint256 nativeAmt = amountErc20 * NATIVE_PER_ERC20_UNIT;
        require(address(this).balance >= nativeAmt, "insufficient vault");
        (bool sent, ) = payable(to).call{value: nativeAmt}("");
        require(sent, "native send failed");
    }
}
