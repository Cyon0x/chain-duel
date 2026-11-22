// SPDX-License-Identifier: MIT
pragma solidity 0.8.30;
import {ChainDuelArc} from '../src/ChainDuelArc.sol';
import {ERC20} from '@openzeppelin/contracts/token/ERC20/ERC20.sol';

interface Vm {
    function prank(address) external;
    function startPrank(address) external;
    function stopPrank() external;
    function warp(uint256) external;
    function expectRevert() external;
    function expectRevert(bytes4) external;
}
contract TestUSDC is ERC20 {
    bool public badTransfers;
    bool public taxTransfers;
    address public reentryTarget;
    bytes32 public reentryGame;
    bool public reentrySucceeded;
    constructor() ERC20('Test USDC', 'USDC') {}
    function decimals() public pure override returns(uint8) { return 6; }
    function mint(address to, uint256 value) external { _mint(to, value); }
    function setBad(bool value) external { badTransfers = value; }
    function setTax(bool value) external { taxTransfers = value; }
    function setReentry(address target, bytes32 gameId) external { reentryTarget = target; reentryGame = gameId; }
    function transferFrom(address from, address to, uint256 value) public override returns(bool) {
        if (reentryTarget != address(0)) { (reentrySucceeded,) = reentryTarget.call(abi.encodeWithSignature('claimRefund(bytes32)',reentryGame)); }
        if (badTransfers) return false;
        if (taxTransfers) { super.transferFrom(from,to,value - 1); return true; }
        return super.transferFrom(from,to,value);
    }
}
contract WrongDecimals is ERC20 { constructor() ERC20('Wrong decimals', 'BAD') {} }
contract ChainDuelArcTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256('hevm cheat code')))));
    TestUSDC token; ChainDuelArc duel;
    address constant ALICE = address(0x1001);
    address constant BOB = address(0x1002);
    address constant AUTH = address(0x1003);
    address constant PROTOCOL = address(0x1004);
    address constant ECOSYSTEM = address(0x1005);
    address constant BOT = address(0x1006);
    bytes32 constant ID = keccak256('test-game');
    bytes32 constant RESULT = keccak256('verified-result');
    uint256 constant STAKE = 50e6;

    function setUp() public {
        token = new TestUSDC();
        duel = new ChainDuelArc(address(token), address(this), AUTH, PROTOCOL, ECOSYSTEM, BOT, 1, 10_000e6);
        token.mint(ALICE, 1_000_000e6); token.mint(BOB, 1_000_000e6); token.mint(BOT, 1_000_000e6);
        vm.prank(ALICE); token.approve(address(duel), type(uint256).max);
        vm.prank(BOB); token.approve(address(duel), type(uint256).max);
        vm.prank(BOT); token.approve(address(duel), type(uint256).max);
    }
    function _create(bool bot) internal { vm.prank(ALICE); duel.createGame(ID, STAKE, bot); }
    function _join() internal { vm.prank(BOB); duel.joinGame(ID); }
    function _start() internal { vm.prank(AUTH); duel.startGame(ID); vm.warp(block.timestamp + 60); }
    function _settle(address winner) internal { vm.prank(AUTH); duel.settleGame(ID, winner, RESULT); }
    function _invariant() internal view {
        require(token.balanceOf(address(duel)) == duel.lockedEscrow() + duel.botLiquidity(), 'balance invariant');
    }
    function testPvpPays9055AndConservesFunds() public {
        uint256 beforeAlice = token.balanceOf(ALICE);
        _create(false); _invariant(); _join(); _invariant(); _start(); _settle(ALICE);
        require(token.balanceOf(ALICE) == beforeAlice + 40e6, 'winner net');
        require(token.balanceOf(PROTOCOL) == 5e6 && token.balanceOf(ECOSYSTEM) == 5e6, '5/5 fees');
        require(duel.getGame(ID).status == ChainDuelArc.Status.Settled, 'settled'); _invariant();
    }
    function testFuzzIntegerRoundingConservesPool(uint64 input) public {
        uint256 stake = uint256(input) % (10_000e6) + 1;
        vm.prank(ALICE); duel.createGame(ID, stake, false); _join(); _start();
        uint256 beforeAlice = token.balanceOf(ALICE); _settle(ALICE);
        uint256 fee = (stake * 2) * 500 / 10_000;
        require(token.balanceOf(ALICE) - beforeAlice == stake * 2 - fee * 2, 'payout rounding');
        require(token.balanceOf(PROTOCOL) == fee && token.balanceOf(ECOSYSTEM) == fee, 'fees'); _invariant();
    }
    function testRejectsWrongTokenDecimalsAndZeroRecipients() public {
        ERC20 wrong = new WrongDecimals();
        vm.expectRevert(ChainDuelArc.InvalidConfiguration.selector);
        new ChainDuelArc(address(wrong),address(this),AUTH,PROTOCOL,ECOSYSTEM,BOT,1,100);
        vm.expectRevert(ChainDuelArc.InvalidConfiguration.selector);
        new ChainDuelArc(address(token),address(this),AUTH,address(0),ECOSYSTEM,BOT,1,100);
    }
    function testStakeBoundsAndUnknownGame() public {
        vm.expectRevert(ChainDuelArc.InvalidStake.selector); vm.prank(ALICE); duel.createGame(ID,0,false);
        vm.expectRevert(ChainDuelArc.InvalidStake.selector); vm.prank(ALICE); duel.createGame(ID,10_000e6+1,false);
        vm.expectRevert(ChainDuelArc.InvalidState.selector); _join();
    }
    function testUnauthorizedAndPrematureSettlement() public {
        _create(false); _join();
        vm.expectRevert(ChainDuelArc.Unauthorized.selector); vm.prank(ALICE); duel.startGame(ID);
        vm.prank(AUTH); duel.startGame(ID);
        vm.expectRevert(ChainDuelArc.TooEarly.selector); _settle(ALICE);
        vm.warp(block.timestamp+60);
        vm.expectRevert(ChainDuelArc.Unauthorized.selector); vm.prank(BOB); duel.settleGame(ID,BOB,RESULT);
        vm.expectRevert(ChainDuelArc.Unauthorized.selector); _settle(PROTOCOL);
        vm.expectRevert(ChainDuelArc.InvalidState.selector); vm.prank(AUTH); duel.settleGame(ID,ALICE,bytes32(0));
    }
    function testDuplicateJoinAndTerminalReplay() public {
        _create(false);
        vm.expectRevert(ChainDuelArc.InvalidState.selector); vm.prank(ALICE); duel.joinGame(ID);
        _join(); vm.expectRevert(ChainDuelArc.InvalidState.selector); _join(); _start(); _settle(ALICE);
        vm.expectRevert(ChainDuelArc.InvalidState.selector); _settle(ALICE);
        vm.expectRevert(ChainDuelArc.InvalidState.selector); _create(false);
        vm.expectRevert(ChainDuelArc.InvalidState.selector); duel.claimRefund(ID); _invariant();
    }
    function testCancellationRefundsOnlyCreator() public {
        uint256 beforeAlice=token.balanceOf(ALICE); _create(false);
        vm.expectRevert(ChainDuelArc.Unauthorized.selector); vm.prank(BOB); duel.cancelGame(ID);
        vm.prank(ALICE); duel.cancelGame(ID);
        require(token.balanceOf(ALICE)==beforeAlice,'full refund'); _invariant();
        vm.expectRevert(ChainDuelArc.InvalidState.selector); vm.prank(ALICE); duel.cancelGame(ID);
    }
    function testExpiredJoinAndPermissionlessRefund() public {
        uint256 beforeAlice=token.balanceOf(ALICE); _create(false); vm.warp(block.timestamp+15 minutes);
        vm.expectRevert(ChainDuelArc.Expired.selector); _join();
        vm.prank(BOB); duel.claimRefund(ID);
        require(token.balanceOf(ALICE)==beforeAlice,'refund creator'); _invariant();
    }
    function testStalledActiveGameRefundsBothPlayersDuringPause() public {
        uint256 a=token.balanceOf(ALICE); uint256 b=token.balanceOf(BOB);
        _create(false); _join(); _start(); duel.setPaused(true);
        vm.expectRevert(ChainDuelArc.TooEarly.selector); duel.claimRefund(ID);
        vm.warp(block.timestamp+2 hours); duel.claimRefund(ID);
        require(token.balanceOf(ALICE)==a && token.balanceOf(BOB)==b,'both refunds'); _invariant();
        vm.expectRevert(ChainDuelArc.InvalidState.selector); _settle(ALICE);
    }
    function testPauseDoesNotTrapSettlementOrRefund() public {
        _create(false); _join(); _start(); duel.setPaused(true); _settle(BOB); _invariant();
        vm.expectRevert(ChainDuelArc.InvalidState.selector); vm.prank(ALICE); duel.createGame(keccak256('new'),STAKE,false);
    }
    function testBotLiquidityAndWinnerAccounting() public {
        vm.expectRevert(ChainDuelArc.InvalidState.selector); _create(true);
        vm.prank(BOT); duel.fundBotPool(100e6); _create(true); _invariant(); _start(); _settle(BOT);
        require(duel.botLiquidity()==140e6,'bot reward'); _invariant();
        vm.expectRevert(ChainDuelArc.Unauthorized.selector); vm.prank(ALICE); duel.withdrawBotPool(1);
        vm.prank(BOT); duel.withdrawBotPool(140e6); _invariant();
    }
    function testBotPlayerWinAndCancellationAccounting() public {
        vm.prank(BOT); duel.fundBotPool(100e6); _create(true);
        vm.expectRevert(ChainDuelArc.InvalidStake.selector); vm.prank(BOT); duel.withdrawBotPool(51e6);
        _start(); _settle(ALICE); require(duel.botLiquidity()==50e6,'bot loss'); _invariant();
        vm.prank(ALICE); duel.createGame(keccak256('cancel-bot'),STAKE,true);
        vm.prank(ALICE); duel.cancelGame(keccak256('cancel-bot'));
        require(duel.botLiquidity()==50e6,'returned reserve'); _invariant();
    }
    function testTokenFalseReturnAndTransferTaxRejected() public {
        token.setBad(true); vm.expectRevert(); _create(false); _invariant();
        token.setBad(false); token.setTax(true);
        vm.expectRevert(ChainDuelArc.UnsupportedToken.selector); _create(false); _invariant();
    }
    function testOwnerAndAuthorityRotation() public {
        vm.expectRevert(); vm.prank(ALICE); duel.setPaused(true);
        vm.expectRevert(); vm.prank(ALICE); duel.setSettlementAuthority(ALICE);
        duel.setSettlementAuthority(BOB); _create(false); _join();
        vm.expectRevert(ChainDuelArc.Unauthorized.selector); vm.prank(AUTH); duel.startGame(ID);
        vm.prank(BOB); duel.startGame(ID);
        duel.transferOwnership(ALICE); require(duel.owner()==address(this),'two step');
        vm.prank(ALICE); duel.acceptOwnership(); require(duel.owner()==ALICE,'accepted');
    }
    function testReentrancyCannotInterleaveRefundWithDeposit() public {
        _create(false); vm.warp(block.timestamp+15 minutes);
        token.setReentry(address(duel),ID);
        vm.prank(BOB); duel.createGame(keccak256('new-deposit'),STAKE,false);
        require(!token.reentrySucceeded(),'refund reentry blocked');
        require(duel.getGame(ID).status==ChainDuelArc.Status.Waiting,'original game unchanged');
        _invariant();
    }
}
