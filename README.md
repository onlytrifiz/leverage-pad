# perpspad su Robinhood Chain

Replica del meccanismo di [perpspad.fun](https://perpspad.fun/paper) (Solana) sui rail
di Robinhood Chain (4663): coin con liquidita' lockata per sempre, fee di trading che
alimentano un motore finanziario (perp a leva su **Lighter**), creator pagato a vita,
buyback&burn continuo. Rail: pool Uniswap V3 one-sided stile `launchDirect.js`.

## Architettura

```
launchCoin.js ──deploya──▶ PerpsPadToken (ERC20 fixed supply, burn(), no owner)
      │
      ├─────crea──────────▶ pool V3 one-sided (tutta la supply, quote USDG)
      │
      └─────locka─────────▶ PerpsPadLocker (NFT LP per SEMPRE, collect-only)
                                  │ fee → sub-wallet della coin
keeper.js (tick ~15s)             ▼
  1. collect(lpTokenId)     sub-wallet = HMAC(masterSecret, tokenAddr)
  2. split lato quote:      42.5% perp / 15% creator / 21.25% treasury / 21.25% buyback
  3. burn lato coin
  4. payout creator+treasury (min $1)
  5. buyback&burn (floor $25, max $25/tick)
  6. gate perp $20 → Lighter (deposito USDG via intent-address + open/topup/take-profit)
```

## Gamba perp: Lighter (profilo ROBINHOOD)

Lighter ha un deployment **nativo** per Robinhood Chain (`lighter.ROBINHOOD` nel SDK:
`api.rh.lighter.xyz`, chain 466324) con 65 order book: **39 PERP** (idx 0-38: crypto,
19 stock, ETF/commodity, ANTHROPIC pre-IPO) + **26 SPOT quotati USDG** (idx 2048+,
`ROUTE_SPOT` — NON perp: per il keeper usare i simboli perp, es. `BTC`, `NVDA`).
Il collaterale entra da Robinhood Chain (4663) via **intent-address**:
`deposit_networks()` elenca 4663 come unica rete sorgente.

Flusso automatico del keeper (per coin, quando la riserva perp ≥ $20):
1. **deposit** — `create_intent_address(4663, sub-wallet, importo)` → il keeper manda
   quegli USDG dal sub-wallet all'intent-address (tx reale su 4663). La riserva si
   decrementa SOLO quando gli USDG lasciano davvero il sub-wallet.
2. **account** — ogni sub-wallet della coin **e'** il suo account Lighter (keyed
   dall'indirizzo che deposita) → isolamento per-coin automatico, zero gestione manuale.
3. **chiave API** — registrata automaticamente firmando `change_api_key` con la chiave
   del sub-wallet. La chiave API puo' gestire la posizione ma **non** prelevare verso terzi.
4. **leva** isolata (`coin.leverage`), **open/topup** dimensionati dal collaterale libero,
   **take-profit** a scaglioni (+25% del collaterale → chiude 20%).
5. **withdraw** del profitto realizzato (`client.withdraw`, normale: no fee/limite, verso il
   sub-wallet su 4663). All'inizio del tick successivo la **riconciliazione** vede gli USDG
   rientrati (surplus oltre i bucket noti, cap al `perpWithdrawPendingUsd`) e li splitta
   **75% buyback / 25% treasury** — cosi' il profitto del perp torna nel burn on-chain.
   Il credito e' guidato dal saldo USDG reale del sub-wallet, non da un numero: niente
   riserve fantasma anche se il withdraw settla in ritardo.

Il ponte col SDK Python e' `lighter/sidecar.py` (il signing zk di Lighter esiste solo
nel loro SDK ufficiale); `lighter/client.js` lo chiama via JSON. Attivazione:

```
python3 -m venv lighter/.venv && lighter/.venv/bin/pip install -r lighter/requirements.txt
export PERPSPAD_LIGHTER_PYTHON=$(pwd)/lighter/.venv/bin/python
lighter/.venv/bin/python lighter/sidecar.py selftest    # verifica profilo+mercati (no mutazioni)
```

Tre modi (`PERPSPAD_LIGHTER_MODE`, come il off/simulate/live di perpspad):
- **off** (default) — stub: la riserva perp accumula in USDG nel sub-wallet, nessun perp.
- **simulate** — esegue le letture (mercato, intent-address, account) e LOGGA cosa
  farebbe (deposito, open, take-profit) ma **non invia nessuna tx ne' ordine**: dry-run
  di validazione da fare PRIMA del live. Il resto del keeper (claim/split/buyback) gira normale.
- **live** — deposito USDG reale + register-key + leva + open/topup + take-profit.

`PERPSPAD_LIGHTER_ENABLED=1` resta valido come alias di `live`.

**Validato live (letture):** profilo ROBINHOOD, 65 mercati con scaling, rete deposito
4663, creazione intent-address, e il deposito USDG→intent-address end-to-end su fork.
**Path mutanti VALIDATI LIVE su mainnet (2026-08-11, wallet test con ~$22):** deposito
via intent-address (accredito in ~10s, account creato automaticamente), register-key,
set-leverage (2x isolated), open market (long 0.00031 BTC, sizing dal mark), lettura
posizione (nomi campo reali = quelli normalizzati dal sidecar), close reduce-only
(round-trip ~$0.03 di spread), withdraw (accettato, collaterale scalato). Unica nota:
il **settlement L1 del withdraw normale non e' immediato** (batch zk: da minuti a ore) —
coerente col design del keeper, che accredita il profitto SOLO quando gli USDG sono
fisicamente nel sub-wallet (riconciliazione 75/25, validata su fork). Nessuna riserva fantasma.

**Nota (edge-case buyback):** su un pool appena lanciato e mai scambiato (prezzo al bordo
del range) la quote in forma chiusa del `minOut` degenera a ~0: li' la protezione slippage
del buyback e' inefficace (nessuna perdita, ma nessun bound). In un pool con scambi normali
il minOut e' corretto. TODO opzionale: skip del buyback quando la quote e' degenere.

Le garanzie replicate dal paper: token senza admin, LP irrecuperabile (il locker non
ha withdraw ne' owner), fee sempre e solo verso il sub-wallet registrato, creator =
solo destinazione payout, ogni movimento e' una tx verificabile del sub-wallet.

## Setup

```
# .env (in robinhood-chain/)
DEPLOYER_PRIVATE_KEY=0x…          # deploya token/locker, paga il gas dei collect
PERPSPAD_MASTER_SECRET=…          # deriva i sub-wallet: PERDERLO = perdere i fondi dei sub-wallet
PERPSPAD_TREASURY=0x…             # incassa il 20%
PERPSPAD_LOCKER=0x…               # dopo deployLocker.js
# opzionali: PERPSPAD_KEEPER_KEY, PERPSPAD_TICK_MS, PERPSPAD_PRICE_<SYM>
```

## Flusso operativo

```
node deployLocker.js                                   # una volta sola
node launchCoin.js --name "Nome" --symbol SYM          # lancio completo (quote USDG)
node launchCoin.js … --market NVDA --side long --lev 5 # sottostante perp (fase 2)
node keeper.js                                         # loop; --once per un giro solo
```

Ripresa lanci a meta': `node launchCoin.js --token 0x… [--lp <tokenId>]`.

## Scelte/differenze rispetto al paper (MVP)

- **Split fee**: il whitepaper dichiara 50/15/20/15 (perp/creator/treasury/buyback), ma il
  CODICE reale di perpspad divide la partner-fee 50/25/25 (perp/buyback/treasury) col creator
  su un canale Meteora separato. Noi abbiamo un solo flusso, quindi teniamo il creator 15% di
  testa e applichiamo il loro 50/25/25 al resto → **42.5 / 15 / 21.25 / 21.25**. Ogni bucket e'
  override via env (`PERPSPAD_SPLIT_PERP/_CREATOR/_TREASURY/_BUYBACK`, somma = 10000).
- Quote di default USDG (=$1) invece di SOL: i gate in dollari sono esatti senza oracle.
  Pair con stock token supportato ma serve `PERPSPAD_PRICE_<SYM>` (TODO: Rialto /quote).
- Fee lato coin: bruciate subito (il paper stock-paired ne rimette il 15% in liquidita' — non nel MVP).
- Gamba perp: **integrata su Lighter** (deposito reale via intent-address, open/topup/
  take-profit cablati) — vedi sezione dedicata. Tre modi off/simulate/live; i path mutanti
  richiedono un conto Lighter finanziato per la validazione live.
- Niente frontend: tutto verificabile da explorer (locker, sub-wallet, burn).

## Sicurezza (post-audit)

Cinque agent hanno auditato contratti, contabilita' e key-management; fix applicati:

- **Lancio (`launchCoin.js`)**: `--dry` esce SEMPRE prima di ogni tx irreversibile (anche
  con `--token`); `--lp` in ripresa validato via `positions()` (token0/token1/fee giusti,
  liquidita' > 0) → non si puo' lockare l'NFT del pool sbagliato; **fingerprint** del master
  secret in `state/fingerprint.json`, verificato a ogni lancio e all'avvio keeper (secret
  diverso → ABORT); `eth_call` pre-fire; pool preesistente al tick sbagliato segnalato come
  possibile front-run (serve `--force`).
- **Keeper (`keeper.js`)**: contabilita' dal **delta reale** di balance attorno alla collect
  (non dalla static); **checkpoint per-step** con decremento-prima-dell'invio su payout/buyback
  → un crash lascia un under-pay riconciliabile, mai doppio pagamento; **buyback con
  `amountOutMinimum` reale** quotato dallo stato del pool (anti-sandwich); **lockfile**
  single-instance; **cap sul gasPrice** dei top-up (anti-drain da RPC ostile); **timeout su
  `wait()`**; validazione `SPLIT_BPS == 10000` all'avvio.
- **Token**: `require(to != address(0))` in `_transfer` (per bruciare c'e' `burn()`).

## Stato

- `state/registry.json` — anagrafica coin + contabilita' bucket per coin (scrittura atomica).
  Se perso: fondi salvi nei sub-wallet (riderivabili), ripartizione ricostruibile dagli eventi `Collected`.
- `state/locker.deployed.json` — esito deploy locker.
- `state/fingerprint.json` — fingerprint del master secret (non cancellare).
- `state/keeper.lock` — lock del keeper attivo (rimosso all'uscita pulita).

## Rischi residui

- Il master secret e' il single point of failure: chi lo ha muove tutti i sub-wallet
  (un secret SBAGLIATO e' ora bloccato dal fingerprint, non usato per lockare).
- Keeper/RPC/venue sono dipendenze live: un outage pausa claim e burn, non li perde.
- Il locker e' senza owner: un errore nel lock e' irreversibile (mitigato da fingerprint +
  validazione `--lp` + `--dry` sicuro, ma la responsabilita' finale resta dell'operatore).
- Il checkpoint riduce la finestra di crash a una singola tx orientata all'under-pay; la
  riconciliazione completa dagli eventi on-chain all'avvio non e' ancora implementata.
