// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/**
 * PerpsPadLocker — lock PERMANENTE delle posizioni LP Uniswap V3 (Robinhood Chain)
 *
 * Replica la garanzia "locked liquidity" di perpspad su Meteora: l'NFT della
 * posizione entra qui e NON ESCE MAI. Il contratto non ha owner, non ha withdraw,
 * non ha transfer, non puo' chiamare decreaseLiquidity: l'unica cosa che sa fare
 * e' girare le trading fee al fee-recipient registrato (il sub-wallet della coin).
 *
 * Flusso: il launcher fa NPM.safeTransferFrom(deployer, locker, tokenId,
 * abi.encode(subWallet)). onERC721Received registra il recipient (immutabile,
 * one-shot) e da quel momento chiunque puo' chiamare collect(tokenId): le fee
 * (entrambi i lati) vanno SEMPRE e SOLO al sub-wallet registrato.
 *
 * Un transfer "nudo" (transferFrom senza data) lascerebbe l'NFT qui senza
 * recipient e le fee sarebbero perse per sempre: usare SOLO safeTransferFrom
 * con il recipient nei data (launchCoin.js lo fa gia' cosi').
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

contract PerpsPadLocker {
    INonfungiblePositionManager public immutable npm;

    /// tokenId LP -> sub-wallet che incassa le fee (0 = non lockato qui)
    mapping(uint256 => address) public feeRecipient;

    event Locked(uint256 indexed tokenId, address indexed feeRecipient);
    event Collected(uint256 indexed tokenId, address indexed feeRecipient, uint256 amount0, uint256 amount1);

    constructor(address _npm) {
        npm = INonfungiblePositionManager(_npm);
    }

    /// Unico punto d'ingresso: safeTransferFrom dell'NFT con data = abi.encode(subWallet).
    function onERC721Received(address, address, uint256 tokenId, bytes calldata data) external returns (bytes4) {
        require(msg.sender == address(npm), "solo NPM");
        address recipient = abi.decode(data, (address));
        require(recipient != address(0), "recipient zero");
        require(feeRecipient[tokenId] == address(0), "gia' registrato");
        feeRecipient[tokenId] = recipient;
        emit Locked(tokenId, recipient);
        return this.onERC721Received.selector;
    }

    /// Chiunque puo' triggherare il claim: le fee vanno comunque al recipient registrato.
    function collect(uint256 tokenId) external returns (uint256 amount0, uint256 amount1) {
        address recipient = feeRecipient[tokenId];
        require(recipient != address(0), "tokenId non lockato");
        (amount0, amount1) = npm.collect(
            INonfungiblePositionManager.CollectParams({
                tokenId: tokenId,
                recipient: recipient,
                amount0Max: type(uint128).max,
                amount1Max: type(uint128).max
            })
        );
        emit Collected(tokenId, recipient, amount0, amount1);
    }
}
