// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;

import {IERC20} from '@openzeppelin/contracts/token/ERC20/IERC20.sol';
import {IERC20Metadata} from '@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol';
import {SafeERC20} from '@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol';
import {ReentrancyGuard} from '@openzeppelin/contracts/utils/ReentrancyGuard.sol';
import {Ownable2Step} from '@openzeppelin/contracts/access/Ownable2Step.sol';
import {Ownable} from '@openzeppelin/contracts/access/Ownable.sol';

/// @notice Independent USDC escrow. Pulse results are replayed off-chain and settled by the disclosed authority.
/// @dev No Soroban dependencies; fixed 90/5/5 economics. Terminal games can never be reused.
contract ChainDuelArc is ReentrancyGuard, Ownable2Step {
    using SafeERC20 for IERC20;
    enum Status { None, Waiting, Joined, Active, Settled, Refunded }
    struct Game {
        address creator; address opponent; address winner;
        uint256 stake; uint64 joinDeadline; uint64 refundDeadline; uint64 startedAt;
        Status status; bool bot; bytes32 resultHash;
    }
    IERC20 public immutable usdc;
    address public immutable protocolRecipient;
    address public immutable ecosystemRecipient;
    address public immutable botRecipient;
    uint256 public immutable minStake;
    uint256 public immutable maxStake;
    uint64 public constant JOIN_WINDOW = 15 minutes;
    uint64 public constant RECOVERY_WINDOW = 2 hours;
    uint64 public constant MATCH_DURATION = 60 seconds;
    address public settlementAuthority;
    bool public paused;
    uint256 public lockedEscrow;
    uint256 public botLiquidity;
    mapping(bytes32 => Game) private _games;

    event GameCreated(bytes32 indexed id, address indexed creator, uint256 stake, bool bot);
    event GameJoined(bytes32 indexed id, address indexed opponent);
    event GameStarted(bytes32 indexed id, uint64 startedAt);
    event GameSettled(bytes32 indexed id, address indexed winner, uint256 payout, uint256 protocolFee, uint256 ecosystemFee, bytes32 resultHash);
    event GameRefunded(bytes32 indexed id);
    event BotFunded(address indexed funder, uint256 amount);
    event BotWithdrawn(uint256 amount);
    event AuthorityChanged(address indexed authority);
    event PauseChanged(bool paused);

    error InvalidConfiguration(); error InvalidState(); error Unauthorized();
    error InvalidStake(); error Expired(); error TooEarly(); error UnsupportedToken();

    constructor(address token, address initialOwner, address authority, address protocol, address ecosystem,
        address botTreasury, uint256 minimum, uint256 maximum) Ownable(initialOwner) {
        if (token == address(0) || token.code.length == 0 || authority == address(0) || protocol == address(0)
            || ecosystem == address(0) || botTreasury == address(0) || minimum == 0 || maximum < minimum
            || maximum > type(uint128).max || IERC20Metadata(token).decimals() != 6) revert InvalidConfiguration();
        usdc = IERC20(token); settlementAuthority = authority;
        protocolRecipient = protocol; ecosystemRecipient = ecosystem; botRecipient = botTreasury;
        minStake = minimum; maxStake = maximum;
    }
    modifier onlyAuthority() { if (msg.sender != settlementAuthority) revert Unauthorized(); _; }
    modifier whenOpen() { if (paused) revert InvalidState(); _; }

    function getGame(bytes32 id) external view returns (Game memory) { return _games[id]; }
    function createGame(bytes32 id, uint256 stake, bool bot) external nonReentrant whenOpen {
        if (id == bytes32(0) || _games[id].status != Status.None) revert InvalidState();
        if (stake < minStake || stake > maxStake) revert InvalidStake();
        if (bot && (botLiquidity < stake || msg.sender == botRecipient)) revert InvalidState();
        _takeExact(msg.sender, stake);
        Game storage g = _games[id];
        g.creator = msg.sender; g.stake = stake; g.bot = bot;
        g.joinDeadline = uint64(block.timestamp + JOIN_WINDOW);
        g.refundDeadline = uint64(block.timestamp + RECOVERY_WINDOW);
        g.status = bot ? Status.Joined : Status.Waiting;
        lockedEscrow += stake;
        if (bot) { botLiquidity -= stake; lockedEscrow += stake; g.opponent = botRecipient; }
        emit GameCreated(id, msg.sender, stake, bot);
    }
    function joinGame(bytes32 id) external nonReentrant whenOpen {
        Game storage g = _games[id];
        if (g.status != Status.Waiting || msg.sender == g.creator) revert InvalidState();
        if (block.timestamp >= g.joinDeadline) revert Expired();
        _takeExact(msg.sender, g.stake);
        g.opponent = msg.sender; g.status = Status.Joined; lockedEscrow += g.stake;
        emit GameJoined(id, msg.sender);
    }
    function startGame(bytes32 id) external onlyAuthority {
        Game storage g = _games[id];
        if (g.status != Status.Joined) revert InvalidState();
        if (block.timestamp >= g.refundDeadline) revert Expired();
        g.startedAt = uint64(block.timestamp); g.status = Status.Active;
        emit GameStarted(id, g.startedAt);
    }
    function settleGame(bytes32 id, address winner, bytes32 resultHash) external nonReentrant onlyAuthority {
        Game storage g = _games[id];
        if (g.status != Status.Active || resultHash == bytes32(0)) revert InvalidState();
        if (block.timestamp < uint256(g.startedAt) + MATCH_DURATION) revert TooEarly();
        if (block.timestamp >= g.refundDeadline) revert Expired();
        if (winner != g.creator && winner != g.opponent) revert Unauthorized();
        uint256 pool = g.stake * 2;
        uint256 protocolFee = pool * 500 / 10_000;
        uint256 ecosystemFee = pool * 500 / 10_000;
        uint256 payout = pool - protocolFee - ecosystemFee;
        g.status = Status.Settled; g.winner = winner; g.resultHash = resultHash; lockedEscrow -= pool;
        if (g.bot && winner == botRecipient) botLiquidity += payout;
        else usdc.safeTransfer(winner, payout);
        usdc.safeTransfer(protocolRecipient, protocolFee);
        usdc.safeTransfer(ecosystemRecipient, ecosystemFee);
        emit GameSettled(id, winner, payout, protocolFee, ecosystemFee, resultHash);
    }
    function cancelGame(bytes32 id) external nonReentrant {
        Game storage g = _games[id];
        if (msg.sender != g.creator) revert Unauthorized();
        if (g.status != Status.Waiting && !(g.bot && g.status == Status.Joined)) revert InvalidState();
        _refund(id, g);
    }
    /// @notice Anyone may trigger recovery; funds go only to the original paying wallets.
    function claimRefund(bytes32 id) external nonReentrant {
        Game storage g = _games[id];
        if (g.status == Status.None || g.status == Status.Settled || g.status == Status.Refunded) revert InvalidState();
        uint64 deadline = g.status == Status.Waiting ? g.joinDeadline : g.refundDeadline;
        if (block.timestamp < deadline) revert TooEarly();
        _refund(id, g);
    }
    function fundBotPool(uint256 amount) external nonReentrant {
        if (amount == 0) revert InvalidStake(); _takeExact(msg.sender, amount);
        botLiquidity += amount; emit BotFunded(msg.sender, amount);
    }
    function withdrawBotPool(uint256 amount) external nonReentrant {
        if (msg.sender != botRecipient) revert Unauthorized();
        if (amount == 0 || amount > botLiquidity) revert InvalidStake();
        botLiquidity -= amount; usdc.safeTransfer(botRecipient, amount); emit BotWithdrawn(amount);
    }
    function setPaused(bool value) external onlyOwner { paused = value; emit PauseChanged(value); }
    function setSettlementAuthority(address authority) external onlyOwner {
        if (authority == address(0)) revert InvalidConfiguration();
        settlementAuthority = authority; emit AuthorityChanged(authority);
    }
    // No rescue/withdraw function can spend player escrow or alter fee destinations.
    function _takeExact(address from, uint256 amount) private {
        uint256 beforeBalance = usdc.balanceOf(address(this));
        usdc.safeTransferFrom(from, address(this), amount);
        if (usdc.balanceOf(address(this)) - beforeBalance != amount) revert UnsupportedToken();
    }
    function _refund(bytes32 id, Game storage g) private {
        uint256 pool = g.opponent == address(0) ? g.stake : g.stake * 2;
        g.status = Status.Refunded; lockedEscrow -= pool;
        if (g.bot) botLiquidity += g.stake;
        usdc.safeTransfer(g.creator, g.stake);
        if (g.opponent != address(0) && !g.bot) usdc.safeTransfer(g.opponent, g.stake);
        emit GameRefunded(id);
    }
}
