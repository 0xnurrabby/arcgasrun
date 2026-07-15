// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title GasRunVault — Arc Testnet USDC payout vault for GasRun
/// @notice Operator pays users instantly; owner (admin) funds/withdraws vault USDC.
contract GasRunVault {
    address public owner;
    address public operator;
    IERC20 public immutable usdc;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event Deposited(address indexed from, uint256 amount);
    event Payout(address indexed to, uint256 amount, bytes32 indexed ref);
    event AdminWithdraw(address indexed to, uint256 amount);

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

    /// @notice Fund vault with USDC (ERC-20, 6 decimals on Arc)
    function deposit(uint256 amount) external {
        require(amount > 0, "amount=0");
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        emit Deposited(msg.sender, amount);
    }

    /// @notice Instant user payout (backend operator)
    function payout(address to, uint256 amount, bytes32 ref) external onlyOperator {
        require(to != address(0), "to=0");
        require(amount > 0, "amount=0");
        require(usdc.transfer(to, amount), "transfer failed");
        emit Payout(to, amount, ref);
    }

    /// @notice Owner pulls USDC out of vault
    function adminWithdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0), "to=0");
        require(amount > 0, "amount=0");
        require(usdc.transfer(to, amount), "transfer failed");
        emit AdminWithdraw(to, amount);
    }

    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }
}
