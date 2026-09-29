// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";
import "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/**
 * @title Cavo
 * @notice Arc-native USDC/EURC payment link router
 * @dev Routes payments directly to creator, deducts platform fee
 */
contract Cavo is Ownable, ReentrancyGuard, Pausable {
    // ─── Events ────────────────────────────────────────────────────────
    event PaymentMade(
        bytes32 indexed linkId,
        address indexed payer,
        address indexed recipient,
        address token,
        uint256 amount,
        uint256 fee,
        string note
    );

    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeWalletUpdated(address oldWallet, address newWallet);
    event AllowedTokenUpdated(address indexed token, bool allowed);

    // ─── State ─────────────────────────────────────────────────────────
    /// @notice Fee in basis points (100 bps = 1%). Default: 50 bps = 0.5%
    uint256 public feeBps;

    /// @notice Wallet that receives platform fees
    address public feeWallet;

    /// @notice Allowed tokens (USDC + EURC on Arc testnet)
    mapping(address => bool) public allowedTokens;

    // ─── Constructor ───────────────────────────────────────────────────
    // Token addresses are constructor params (not constants) so testnet and
    // mainnet deployments each allowlist the correct USDC/EURC contracts.
    // Defaults for Arc Testnet:
    //   USDC 0x3600000000000000000000000000000000000000
    //   EURC 0x89B50855Aa3bE2F677cD6303Cec089B5F319D72a
    constructor(
        address _feeWallet,
        uint256 _feeBps,
        address _usdc,
        address _eurc
    ) Ownable(msg.sender) {
        require(_feeWallet != address(0), "Invalid fee wallet");
        require(_feeBps <= 1000, "Fee too high (max 10%)");
        require(_usdc != address(0) && _eurc != address(0), "Invalid token");
        require(_usdc != _eurc, "Duplicate token");

        feeWallet = _feeWallet;
        feeBps = _feeBps;

        allowedTokens[_usdc] = true;
        allowedTokens[_eurc] = true;
    }

    // ─── Core Function ─────────────────────────────────────────────────

    /**
     * @notice Execute a payment for a given link
     * @param linkId    Unique identifier of the payment link (bytes32 of UUID)
     * @param recipient Creator's wallet address
     * @param token     ERC-20 token address (USDC or EURC)
     * @param amount    Amount in token's smallest unit (6 decimals)
     * @param note      Optional note stored on-chain in event log
     */
    function pay(
        bytes32 linkId,
        address recipient,
        address token,
        uint256 amount,
        string calldata note
    ) external nonReentrant whenNotPaused {
        require(allowedTokens[token], "Token not allowed");
        require(recipient != address(0), "Invalid recipient");
        require(amount > 0, "Amount must be > 0");

        uint256 feeAmount = (amount * feeBps) / 10_000;
        uint256 recipientAmount = amount - feeAmount;

        // Transfer from payer → this contract
        require(
            IERC20(token).transferFrom(msg.sender, address(this), amount),
            "Transfer failed"
        );

        // Send to recipient
        require(
            IERC20(token).transfer(recipient, recipientAmount),
            "Recipient transfer failed"
        );

        // Send fee to platform wallet
        if (feeAmount > 0) {
            require(
                IERC20(token).transfer(feeWallet, feeAmount),
                "Fee transfer failed"
            );
        }

        emit PaymentMade(linkId, msg.sender, recipient, token, recipientAmount, feeAmount, note);
    }

    // ─── Admin Functions ───────────────────────────────────────────────

    function setFeeBps(uint256 _feeBps) external onlyOwner {
        require(_feeBps <= 1000, "Fee too high (max 10%)");
        emit FeeUpdated(feeBps, _feeBps);
        feeBps = _feeBps;
    }

    function setFeeWallet(address _feeWallet) external onlyOwner {
        require(_feeWallet != address(0), "Invalid address");
        emit FeeWalletUpdated(feeWallet, _feeWallet);
        feeWallet = _feeWallet;
    }

    function setAllowedToken(address token, bool allowed) external onlyOwner {
        require(token != address(0), "Invalid address");
        allowedTokens[token] = allowed;
        emit AllowedTokenUpdated(token, allowed);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // ─── View Helpers ──────────────────────────────────────────────────

    function computeFee(uint256 amount) external view returns (uint256 fee, uint256 net) {
        fee = (amount * feeBps) / 10_000;
        net = amount - fee;
    }
}
