// SPDX-License-Identifier: MIT
pragma solidity 0.8.24;

/// @title PerpsPadToken — ERC20 per i lanci perpspad (stile LaunchToken + burn)
/// @notice Supply fissa mintata al deployer nel constructor. Nessun owner, nessuna
///         funzione admin, nessuna tassa, nessun mint successivo. Unica aggiunta
///         rispetto a LaunchToken: burn() pubblica che DIMINUISCE la totalSupply,
///         cosi' il buyback&burn del keeper e' un burn vero (supply visibile che
///         scende su explorer), non un parcheggio su 0xdEaD.
contract PerpsPadToken {
    string public name;
    string public symbol;
    uint8 public constant decimals = 18;
    uint256 public totalSupply;

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
        balanceOf[msg.sender] -= value;
        totalSupply -= value;
        emit Transfer(msg.sender, address(0), value);
    }

    function _transfer(address from, address to, uint256 value) internal {
        // vietato il transfer verso 0x0: brucerebbe token SENZA ridurre totalSupply
        // (gonfiando la supply contabile). Per bruciare c'e' burn(), che la decrementa.
        require(to != address(0), "to zero");
        balanceOf[from] -= value;
        balanceOf[to] += value;
        emit Transfer(from, to, value);
    }
}
