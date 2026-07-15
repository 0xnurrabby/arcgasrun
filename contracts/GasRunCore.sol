// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface IERC20 {
    function transfer(address to, uint256 amount) external returns (bool);
    function transferFrom(address from, address to, uint256 amount) external returns (bool);
    function balanceOf(address account) external view returns (uint256);
}

/// @title GasRunCore — full on-chain economy for GasRun on Arc
/// @notice Every player movement is a real transaction:
///   - saveRun: bank run points on-chain
///   - depositScore: weekly leaderboard
///   - convert: points → permanent USDC credit (operator voucher)
///   - withdraw: credit → wallet USDC
contract GasRunCore {
    address public owner;
    address public operator;
    IERC20 public immutable usdc;

    uint256 private constant NATIVE_PER_ERC20_UNIT = 1e12; // 6dec → 18dec

    mapping(address => uint256) public usdcCredit; // permanent USDC (6 decimals)
    mapping(address => uint256) public nonces; // convert vouchers
    mapping(address => uint256) public totalScoreDeposited;
    mapping(address => uint256) public totalRunSaved;

    event OwnershipTransferred(address indexed previousOwner, address indexed newOwner);
    event OperatorUpdated(address indexed previousOperator, address indexed newOperator);
    event Funded(address indexed from, uint256 amount, bool isNative);

    event RunSaved(address indexed user, uint256 points, uint256 timestamp);
    event ScoreDeposited(address indexed user, uint256 points, uint256 weekStart, uint256 timestamp);
    event Converted(address indexed user, uint256 points, uint256 usdcMicros, uint256 timestamp);
    event Withdrawn(address indexed user, uint256 usdcMicros, uint256 timestamp);
    event Credited(address indexed user, uint256 usdcMicros, bytes32 indexed ref);
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
        require(usdcToken != address(0) && initialOwner != address(0) && initialOperator != address(0), "zero");
        usdc = IERC20(usdcToken);
        owner = initialOwner;
        operator = initialOperator;
        emit OwnershipTransferred(address(0), initialOwner);
        emit OperatorUpdated(address(0), initialOperator);
    }

    receive() external payable {
        require(msg.value > 0, "amount=0");
        emit Funded(msg.sender, msg.value, true);
    }

    fallback() external payable {
        require(msg.value > 0, "amount=0");
        emit Funded(msg.sender, msg.value, true);
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

    // ───────── Gameplay / movements ─────────

    /// @notice Save run points on-chain (gameplay bank step)
    function saveRun(uint256 points) external {
        require(points > 0, "points=0");
        totalRunSaved[msg.sender] += points;
        emit RunSaved(msg.sender, points, block.timestamp);
    }

    /// @notice Deposit saved points to weekly leaderboard
    function depositScore(uint256 points, uint256 weekStart) external {
        require(points > 0, "points=0");
        totalScoreDeposited[msg.sender] += points;
        emit ScoreDeposited(msg.sender, points, weekStart, block.timestamp);
    }

    /// @notice Convert points → permanent USDC credit (operator-signed voucher)
    /// @dev digest = eth_sign(keccak256(user, points, usdcMicros, nonce, deadline, chainId, this))
    function convert(
        uint256 points,
        uint256 usdcMicros,
        uint256 deadline,
        bytes calldata signature
    ) external {
        require(block.timestamp <= deadline, "expired");
        require(points > 0 && usdcMicros > 0, "zero");

        uint256 nonce = nonces[msg.sender];
        bytes32 payload = keccak256(
            abi.encode(msg.sender, points, usdcMicros, nonce, deadline, block.chainid, address(this))
        );
        bytes32 ethHash = keccak256(abi.encodePacked("\x19Ethereum Signed Message:\n32", payload));
        address signer = _recover(ethHash, signature);
        require(signer == operator || signer == owner, "bad sig");

        nonces[msg.sender] = nonce + 1;
        usdcCredit[msg.sender] += usdcMicros;
        emit Converted(msg.sender, points, usdcMicros, block.timestamp);
    }

    /// @notice Withdraw permanent USDC credit to wallet (instant on-chain)
    function withdraw(uint256 usdcMicros) external {
        require(usdcMicros > 0, "amount=0");
        uint256 bal = usdcCredit[msg.sender];
        require(bal >= usdcMicros, "insufficient credit");
        usdcCredit[msg.sender] = bal - usdcMicros;
        _sendUsdc(msg.sender, usdcMicros);
        emit Withdrawn(msg.sender, usdcMicros, block.timestamp);
    }

    // ───────── Admin / operator ─────────

    function depositErc20(uint256 amount) external {
        require(amount > 0, "amount=0");
        require(usdc.transferFrom(msg.sender, address(this), amount), "transferFrom failed");
        emit Funded(msg.sender, amount, false);
    }

    function credit(address to, uint256 usdcMicros, bytes32 ref) external onlyOperator {
        require(to != address(0) && usdcMicros > 0, "bad");
        usdcCredit[to] += usdcMicros;
        emit Credited(to, usdcMicros, ref);
    }

    function payout(address to, uint256 amount, bytes32 ref) external onlyOperator {
        require(to != address(0) && amount > 0, "bad");
        _sendUsdc(to, amount);
        emit Payout(to, amount, ref);
    }

    function adminWithdraw(address to, uint256 amount) external onlyOwner {
        require(to != address(0) && amount > 0, "bad");
        _sendUsdc(to, amount);
        emit AdminWithdraw(to, amount);
    }

    function balance() external view returns (uint256) {
        return usdc.balanceOf(address(this));
    }

    function nativeBalance() external view returns (uint256) {
        return address(this).balance;
    }

    function getNonce(address user) external view returns (uint256) {
        return nonces[user];
    }

    // ───────── internals ─────────

    function _sendUsdc(address to, uint256 amountErc20) internal {
        try usdc.transfer(to, amountErc20) returns (bool ok) {
            if (ok) return;
        } catch {}
        uint256 nativeAmt = amountErc20 * NATIVE_PER_ERC20_UNIT;
        require(address(this).balance >= nativeAmt, "insufficient vault");
        (bool sent, ) = payable(to).call{value: nativeAmt}("");
        require(sent, "native send failed");
    }

    function _recover(bytes32 hash, bytes calldata sig) internal pure returns (address) {
        require(sig.length == 65, "sig len");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := calldataload(sig.offset)
            s := calldataload(add(sig.offset, 32))
            v := byte(0, calldataload(add(sig.offset, 64)))
        }
        if (v < 27) v += 27;
        require(v == 27 || v == 28, "bad v");
        address signer = ecrecover(hash, v, r, s);
        require(signer != address(0), "bad recover");
        return signer;
    }
}
