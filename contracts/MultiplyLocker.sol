// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * MultiplyLocker — lock PERMANENTE delle posizioni LP Uniswap V3 (multiply.cash)
 *
 * Due garanzie, entrambe scolpite nel contratto:
 *  1. "liquidity locked forever": l'NFT della posizione entra qui e NON ESCE MAI.
 *     Niente owner, niente withdraw, niente transfer, niente decreaseLiquidity.
 *  2. "il burn lo impone il contratto, non il bot": a ogni collect() il lato fee
 *     della COIN va dritto a 0xdEaD (che per MultiplyToken e' un burn vero, con
 *     totalSupply che scende), mentre il lato quote va SEMPRE e SOLO al
 *     sub-wallet registrato. Chiunque puo' chiamare collect(): il burn funziona
 *     anche se il keeper e' spento.
 *
 * Flusso: il launcher fa NPM.safeTransferFrom(deployer, locker, tokenId,
 * abi.encode(subWallet, coinToken)). onERC721Received registra recipient e lato
 * burn (immutabili, one-shot). collectSide(tokenId, side) incassa un lato solo:
 * rete di salvataggio se l'altro token e' bloccato (es. quote con freeze) — le
 * destinazioni restano comunque fisse.
 *
 * Un transfer "nudo" (transferFrom senza data) o con data malformati REVERTA:
 * usare SOLO safeTransferFrom con (recipient, coinToken) nei data.
 */

interface INonfungiblePositionManager {
    struct CollectParams {
        uint256 tokenId;
        address recipient;
        uint128 amount0Max;
        uint128 amount1Max;
    }

    function collect(CollectParams calldata params) external payable returns (uint256 amount0, uint256 amount1);

    function positions(uint256 tokenId)
        external
        view
        returns (
            uint96 nonce,
            address operator,
            address token0,
            address token1,
            uint24 fee,
            int24 tickLower,
            int24 tickUpper,
            uint128 liquidity,
            uint256 feeGrowthInside0LastX128,
            uint256 feeGrowthInside1LastX128,
            uint128 tokensOwed0,
            uint128 tokensOwed1
        );
}

contract MultiplyLocker {
    INonfungiblePositionManager public immutable npm;
    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    /// tokenId LP -> sub-wallet che incassa il lato quote delle fee (0 = non lockato qui)
    mapping(uint256 => address) public feeRecipient;
    /// tokenId LP -> token il cui lato fee viene BRUCIATO a ogni collect (0 = nessun lato burn)
    mapping(uint256 => address) public burnToken;
    /// tokenId LP -> true se burnToken e' il token0 della posizione
    mapping(uint256 => bool) public burnIsToken0;

    event Locked(uint256 indexed tokenId, address indexed feeRecipient, address burnToken);
    event Collected(uint256 indexed tokenId, address indexed feeRecipient, uint256 amount0, uint256 amount1);

    constructor(address _npm) {
        require(_npm != address(0), "npm zero");
        npm = INonfungiblePositionManager(_npm);
    }

    /// Unico punto d'ingresso: safeTransferFrom dell'NFT con
    /// data = abi.encode(subWallet, coinToken). coinToken deve essere token0 o
    /// token1 della posizione; address(0) = nessun burn (entrambi i lati al recipient).
    function onERC721Received(address, address, uint256 tokenId, bytes calldata data) external returns (bytes4) {
        require(msg.sender == address(npm), "solo NPM");
        (address recipient, address burn) = abi.decode(data, (address, address));
        require(recipient != address(0), "recipient zero");
        require(feeRecipient[tokenId] == address(0), "gia' registrato");
        if (burn != address(0)) {
            (, , address t0, address t1, , , , , , , , ) = npm.positions(tokenId);
            require(burn == t0 || burn == t1, "burnToken estraneo alla posizione");
            burnToken[tokenId] = burn;
            burnIsToken0[tokenId] = (burn == t0);
        }
        feeRecipient[tokenId] = recipient;
        emit Locked(tokenId, recipient, burn);
        return this.onERC721Received.selector;
    }

    /// Chiunque puo' triggherare il claim: lato coin → 0xdEaD (burn), lato quote
    /// → sub-wallet registrato. Nessun altro esito possibile.
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        amount0 = _collectSide(tokenId, true);
        amount1 = _collectSide(tokenId, false);
        emit Collected(tokenId, feeRecipient[tokenId], amount0, amount1);
    }

    /// Incassa UN lato solo: se l'altro token e' bloccato (freeze/pausa del quote),
    /// il lato sano resta claimabile. Le destinazioni sono le stesse di collect().
    function collectSide(uint256 tokenId, bool side0) external returns (uint256 amount) {
        amount = _collectSide(tokenId, side0);
        emit Collected(tokenId, feeRecipient[tokenId], side0 ? amount : 0, side0 ? 0 : amount);
    }

    function _collectSide(uint256 tokenId, bool side0) internal returns (uint256) {
        address recipient = feeRecipient[tokenId];
        require(recipient != address(0), "tokenId non lockato");
        address dest = (burnToken[tokenId] != address(0) && burnIsToken0[tokenId] == side0) ? DEAD : recipient;
        (uint256 a0, uint256 a1) = npm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: dest,
                amount0Max: side0 ? type(uint128).max : 0,
                amount1Max: side0 ? 0 : type(uint128).max
            })
        );
        return side0 ? a0 : a1;
    }
}
