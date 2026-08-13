// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title MultiplyToken — ERC20 dei lanci multiply.cash
/// @notice Supply fissa mintata al deployer nel constructor. Nessun owner, nessuna
///         funzione admin, nessuna tassa, nessun mint successivo. Si brucia in due
///         modi equivalenti: burn() oppure un semplice transfer verso 0xdEaD (il
///         modo in cui la gente brucia di fatto) — in entrambi i casi la
///         totalSupply DIMINUISCE davvero, niente supply fantasma parcheggiata
///         sul dead address.
/// @dev    Il transfer verso address(0) REVERTA come in qualunque ERC20 standard:
///         li' una destinazione zero e' quasi sempre un bug del chiamante (campo
///         non inizializzato), e bruciare in silenzio i suoi token sarebbe peggio
///         che fermarlo. Per bruciare ci sono burn() e 0xdEaD, entrambi espliciti.
contract MultiplyToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

    address private constant DEAD = 0x000000000000000000000000000000000000dEaD;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    constructor(string memory _name, string memory _symbol, uint256 _supply) {
        name = _name;
        symbol = _symbol;
        totalSupply = _supply;
        balanceOf[msg.sender] = _supply;
        emit Transfer(address(0), msg.sender, _supply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        _transfer(msg.sender, to, value);
        return true;
    }

    function transferFrom(address from, address to, uint256 value) external returns (bool) {
        uint256 allowed = allowance[from][msg.sender];
        if (allowed != type(uint256).max) allowance[from][msg.sender] = allowed - value;
        _transfer(from, to, value);
        return true;
    }

    function approve(address spender, uint256 value) external returns (bool) {
        allowance[msg.sender][spender] = value;
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function burn(uint256 value) external {
        _burn(msg.sender, value);
    }

    function _burn(address from, uint256 value) internal {
        balanceOf[from] -= value;
        totalSupply -= value;
        emit Transfer(from, address(0), value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        // destinazione zero = errore del chiamante, non un burn: reverta.
        require(to != address(0), "to zero");
        // transfer verso 0xdEaD = burn VERO: la gente brucia cosi', e la supply
        // contabile deve scendere insieme ai token.
        if (to == DEAD) {
            _burn(from, value);
            return;
        }
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
