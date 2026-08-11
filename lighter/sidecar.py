#!/usr/bin/env python3
"""
sidecar.py — ponte Python verso Lighter per il keeper perpspad (Node).

Perche' Python: il signing di Lighter (zk-rollup) e' fatto solo dal loro SDK
ufficiale (`lighter-sdk`, Python/Go). Il keeper Node chiama questo processo con
UN comando JSON e riceve UN risultato JSON su stdout — nessun stato persistente
qui, tutta la contabilita' resta nel keeper.

Deployment: profilo **ROBINHOOD** nativo del SDK (`api.rh.lighter.xyz`,
chain_id 466324). Il collaterale entra da **Robinhood Chain (4663)** via
intent-address (deposit_networks lo elenca come unica rete sorgente): si crea un
intent-address e il keeper ci manda gli USDG dal sub-wallet della coin. L'account
Lighter di ogni coin e' keyed dall'indirizzo del suo sub-wallet → isolamento
per-coin automatico, come le "one profile per coin" di perpspad.

Protocollo:  python3 sidecar.py <comando> '<json-params>'
Output    :  {"ok": true, ...}  |  {"ok": false, "error": "..."}

Segreti via ENV (mai in argv, per non finire nella process list):
  LIGHTER_API_PRIVKEY   chiave API Lighter della coin (per open/close/margin/leverage)
  LIGHTER_ETH_PRIVKEY   chiave del sub-wallet su 4663 (per register-key: firma change_api_key)

Comandi:
  selftest                              SDK+profilo+mercati, nessuna mutazione
  markets                               {symbol: {index,size_dec,price_dec,status}}
  resolve-account {address}             address 4663 → accountIndex Lighter (o null)
  account {accountIndex}                collaterale + posizioni
  intent-address {chainId,fromAddr,amount}   indirizzo dove mandare gli USDG (no auth)
  deposit-latest {address}              ultimo deposito visto da Lighter
  register-key {accountIndex,apiKeyIndex}    genera+registra una chiave API (ENV LIGHTER_ETH_PRIVKEY)
  set-leverage {accountIndex,marketIndex,leverage,isolated,apiKeyIndex}
  open  {accountIndex,marketIndex,baseAmount,isAsk,maxSlippage,clientOrderIndex,apiKeyIndex}
  close {accountIndex,marketIndex,baseAmount,isAsk,maxSlippage,clientOrderIndex,apiKeyIndex}  (reduce_only)
  add-margin {accountIndex,marketIndex,usdcAmount,apiKeyIndex}
"""
import sys, os, json, asyncio

def out(obj):
    print(json.dumps(obj, default=str))
    sys.exit(0 if obj.get("ok") else 1)

try:
    import lighter
except Exception as e:  # SDK non installato
    if len(sys.argv) > 1 and sys.argv[1] == "selftest":
        out({"ok": False, "error": f"lighter-sdk non installato: {e}. Vedi lighter/requirements.txt"})
    out({"ok": False, "error": f"import lighter fallito: {e}"})

PROFILE = lighter.get_endpoint_profile(os.environ.get("LIGHTER_PROFILE", "robinhood"))


def api_client():
    return lighter.ApiClient(lighter.Configuration(host=PROFILE.api_url))


def signer(account_index, api_key_index):
    priv = os.environ.get("LIGHTER_API_PRIVKEY")
    if not priv:
        raise RuntimeError("LIGHTER_API_PRIVKEY mancante nell'ambiente")
    return lighter.SignerClient(
        url=PROFILE.api_url,
        account_index=int(account_index),
        api_private_keys={int(api_key_index): priv},
        chain_id=PROFILE.chain_id,
    )


def d(o):
    return o.to_dict() if hasattr(o, "to_dict") else o


async def cmd_selftest(p):
    c = api_client()
    try:
        ob = await lighter.OrderApi(c).order_books()
        mkts = ob.order_books if hasattr(ob, "order_books") else ob
        nets = await lighter.BridgeApi(c).deposit_networks()
        return {"ok": True, "profile": PROFILE.name, "api_url": PROFILE.api_url,
                "chain_id": PROFILE.chain_id, "markets": len(mkts),
                "deposit_networks": [n.get("chain_id") for n in d(nets).get("networks", [])]}
    finally:
        await c.close()


async def cmd_markets(p):
    c = api_client()
    try:
        ob = await lighter.OrderApi(c).order_books()
        mkts = ob.order_books if hasattr(ob, "order_books") else ob
        res = {}
        for m in mkts:
            md = d(m)
            sym = md.get("symbol")
            res[sym] = {"index": md.get("market_id", md.get("market_index")),
                        "size_dec": md.get("supported_size_decimals", md.get("size_decimals")),
                        "price_dec": md.get("supported_price_decimals", md.get("price_decimals")),
                        "status": md.get("status")}
        return {"ok": True, "markets": res}
    finally:
        await c.close()


async def cmd_resolve_account(p):
    c = api_client()
    try:
        try:
            r = await lighter.AccountApi(c).accounts_by_l1_address(l1_address=p["address"])
        except lighter.ApiException as e:
            if getattr(e, "data", None) and getattr(e.data, "message", "") == "account not found":
                return {"ok": True, "accountIndex": None}
            raise
        subs = d(r).get("sub_accounts", [])
        idx = min((int(s["index"]) for s in subs), default=None)
        return {"ok": True, "accountIndex": idx, "subAccounts": [int(s["index"]) for s in subs]}
    finally:
        await c.close()


async def cmd_account(p):
    c = api_client()
    try:
        r = await lighter.AccountApi(c).account(by="index", value=str(p["accountIndex"]))
        acc = d(r)
        # normalizzo i campi che servono al keeper (nomi difensivi)
        accounts = acc.get("accounts", [acc])
        a0 = accounts[0] if accounts else acc
        positions = a0.get("positions", []) or []
        norm = []
        for pos in positions:
            norm.append({
                "market_id": pos.get("market_id", pos.get("market_index")),
                "sign": pos.get("sign"),
                "size": pos.get("position", pos.get("size")),
                "avg_entry_price": pos.get("avg_entry_price", pos.get("entry_price")),
                "unrealized_pnl": pos.get("unrealized_pnl", pos.get("unrealized_pnl_usd")),
                "allocated_margin": pos.get("allocated_margin", pos.get("position_margin")),
                "liquidation_price": pos.get("liquidation_price"),
            })
        return {"ok": True,
                "collateral": a0.get("collateral", a0.get("available_balance")),
                "positions": norm, "raw": a0}
    finally:
        await c.close()


async def cmd_intent_address(p):
    c = api_client()
    try:
        r = await lighter.BridgeApi(c).create_intent_address(
            chain_id=str(p["chainId"]), from_addr=p["fromAddr"],
            amount=str(p["amount"]), is_external_deposit=bool(p.get("isExternal", True)))
        return {"ok": True, "intentAddress": d(r).get("intent_address")}
    finally:
        await c.close()


async def cmd_deposit_latest(p):
    c = api_client()
    try:
        r = await lighter.BridgeApi(c).deposit_latest(l1_address=p["address"])
        return {"ok": True, "deposit": d(r)}
    finally:
        await c.close()


async def cmd_register_key(p):
    eth = os.environ.get("LIGHTER_ETH_PRIVKEY")
    if not eth:
        return {"ok": False, "error": "LIGHTER_ETH_PRIVKEY mancante (chiave sub-wallet per firmare change_api_key)"}
    api_key_index = int(p["apiKeyIndex"])
    priv, pub, err = lighter.create_api_key()
    if err:
        return {"ok": False, "error": f"create_api_key: {err}"}
    client = lighter.SignerClient(url=PROFILE.api_url, account_index=int(p["accountIndex"]),
                                  api_private_keys={api_key_index: priv}, chain_id=PROFILE.chain_id)
    try:
        _, err = await client.change_api_key(eth_private_key=eth, new_pubkey=pub, api_key_index=api_key_index)
        if err:
            return {"ok": False, "error": f"change_api_key: {err}"}
        return {"ok": True, "apiPrivKey": priv, "apiPubKey": pub, "apiKeyIndex": api_key_index}
    finally:
        await client.close()


async def cmd_set_leverage(p):
    client = signer(p["accountIndex"], p.get("apiKeyIndex", 4))
    try:
        mode = client.ISOLATED_MARGIN_MODE if p.get("isolated", True) else client.CROSS_MARGIN_MODE
        res = await client.update_leverage(market_index=int(p["marketIndex"]), margin_mode=mode, leverage=int(p["leverage"]))
        err = res[-1]  # (tx, resp, err) — l'err e' sempre l'ultimo elemento
        return {"ok": err is None, "error": err}
    finally:
        await client.close()


async def _mark_and_sizedec(market_index):
    """prezzo mark + size_decimals del mercato (per dimensionare da notional)."""
    c = api_client()
    try:
        det = d(await lighter.OrderApi(c).order_book_details(market_id=int(market_index)))
        ob = det.get("order_book_details", det)
        if isinstance(ob, list):
            ob = ob[0]
        mark = ob.get("mark_price") or ob.get("index_price") or ob.get("last_trade_price")
        size_dec = ob.get("supported_size_decimals", ob.get("size_decimals"))
        return float(mark), int(size_dec)
    finally:
        await c.close()


async def _market_order(p, reduce_only):
    # base_amount esplicito (per il close: 20% della size corrente, nota al keeper)
    # oppure dimensionato da notionalUsd al prezzo mark (per open/topup)
    base_amount = p.get("baseAmount")
    if base_amount is None:
        mark, size_dec = await _mark_and_sizedec(p["marketIndex"])
        if not mark or mark <= 0:
            return {"ok": False, "error": "prezzo mark non disponibile per dimensionare l'ordine"}
        size = float(p["notionalUsd"]) / mark
        base_amount = int(round(size * (10 ** size_dec)))
    if int(base_amount) <= 0:
        return {"ok": False, "error": "base_amount 0 (notional troppo piccolo per il size step)"}
    client = signer(p["accountIndex"], p.get("apiKeyIndex", 4))
    try:
        _, tx_hash, err = await client.create_market_order_if_slippage(
            market_index=int(p["marketIndex"]),
            client_order_index=int(p.get("clientOrderIndex", 0)),
            base_amount=int(base_amount),
            max_slippage=float(p.get("maxSlippage", 0.02)),
            is_ask=bool(p["isAsk"]),
            reduce_only=reduce_only,
        )
        return {"ok": err is None, "txHash": tx_hash, "baseAmount": int(base_amount), "error": err}
    finally:
        await client.close()


async def cmd_open(p):
    return await _market_order(p, reduce_only=False)


async def cmd_close(p):
    return await _market_order(p, reduce_only=True)


async def cmd_add_margin(p):
    client = signer(p["accountIndex"], p.get("apiKeyIndex", 4))
    try:
        _, tx_hash, err = await client.update_margin(
            market_index=int(p["marketIndex"]), usdc_amount=float(p["usdcAmount"]),
            direction=client.ISOLATED_MARGIN_ADD_COLLATERAL)
        return {"ok": err is None, "txHash": tx_hash, "error": err}
    finally:
        await client.close()


async def cmd_withdraw(p):
    # withdraw "normale": nessuna fee/limite, verso l'indirizzo L1 originante
    # (= il sub-wallet su 4663). Riporta il profitto realizzato per bruciarlo on-chain.
    client = signer(p["accountIndex"], p.get("apiKeyIndex", 4))
    try:
        _, resp, err = await client.withdraw(
            asset_id=client.ASSET_ID_USDC, route_type=client.ROUTE_PERP, amount=float(p["amount"]))
        return {"ok": err is None, "resp": d(resp) if resp else None, "error": err}
    finally:
        await client.close()


COMMANDS = {
    "selftest": cmd_selftest, "markets": cmd_markets, "resolve-account": cmd_resolve_account,
    "account": cmd_account, "intent-address": cmd_intent_address, "deposit-latest": cmd_deposit_latest,
    "register-key": cmd_register_key, "set-leverage": cmd_set_leverage,
    "open": cmd_open, "close": cmd_close, "add-margin": cmd_add_margin, "withdraw": cmd_withdraw,
}


async def main():
    if len(sys.argv) < 2 or sys.argv[1] not in COMMANDS:
        out({"ok": False, "error": f"comando ignoto. Validi: {', '.join(COMMANDS)}"})
    params = json.loads(sys.argv[2]) if len(sys.argv) > 2 and sys.argv[2] else {}
    try:
        out(await COMMANDS[sys.argv[1]](params))
    except Exception as e:
        out({"ok": False, "error": f"{type(e).__name__}: {e}"})


if __name__ == "__main__":
    asyncio.run(main())
