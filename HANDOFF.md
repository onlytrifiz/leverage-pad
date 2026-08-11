# leverage-pad — Guida di handoff per agenti futuri

> Leggi questo file per intero PRIMA di toccare il codice. Poi `README.md` per il dettaglio
> tecnico. Questo documento e' scritto per un agente (o umano) che eredita il progetto senza
> contesto: cosa e', com'e' fatto, cosa e' gia' validato, cosa manca, e come non farsi male.

---

## 0. TL;DR

`leverage-pad` e' un clone del launchpad **[perpspad.fun](https://perpspad.fun/paper)** (Solana)
portato su **Robinhood Chain** (L2 Arbitrum Orbit, chainId **4663**). Ogni coin lanciata:

1. e' un ERC20 a supply fissa senza owner;
2. nasce con un pool Uniswap V3 **one-sided** (tutta la supply da un lato) la cui posizione LP
   e' **lockata per sempre** in un contratto senza owner/withdraw → nessun rug possibile;
3. le fee di trading vengono incassate da un **keeper** e splittate 42.5% perp / 15% creator /
   21.25% treasury / 21.25% buyback;
4. la quota perp finanzia una **posizione perpetua a leva su Lighter** (deployment nativo
   Robinhood) sul mercato scelto al lancio (BTC, NVDA, TSLA, ... , ANTHROPIC pre-IPO);
5. il buyback ricompra la coin e la **brucia**; il profitto del perp (take-profit a scaglioni)
   viene prelevato e reimmesso nel buyback/treasury.

**Stato al 2026-08-11:** logica core validata e2e su fork; gamba perp Lighter validata **live su
mainnet** (deposito→open→close→withdraw). Manca solo il primo lancio di PRODUZIONE (serve un
master secret e un deployer finanziati). Vedi §8 (go-live) e §9 (cosa manca).

---

## 1. Origine e differenze dal paper

Abbiamo il sorgente reale di perpspad (`github.com/tekPioneered/perpadfun`, Solana). Due cose
importanti emerse dal confronto:

- **Lo split del paper e' sbagliato.** Il whitepaper dichiara 50/15/20/15 (perp/creator/treasury/
  buyback), ma il loro CODICE divide la partner-fee **50/25/25** (perp/buyback/treasury) col
  creator su un canale Meteora separato. Noi abbiamo un solo flusso, quindi teniamo il creator 15%
  di testa e applichiamo il 50/25/25 al resto → **42.5 / 15 / 21.25 / 21.25** (default, override via env).
- **Il nostro audit ha ricostruito i loro meccanismi di sicurezza** (idempotency/intent-hash,
  accrual da balance-delta, burn-sweep, reconcile). Sono le stesse difese; noi le implementiamo in
  forma piu' semplice (checkpoint-before-send, burn del saldo intero, riconciliazione da saldo reale).

Rispetto a perpspad, il nostro **angolo distintivo** su Robinhood Chain: i 19 perp su **stock** +
**ANTHROPIC** pre-IPO su Lighter, che permettono una coin "backed da un perp long NVDA/Anthropic"
— prodotto che su Solana non esiste con questa coerenza.

---

## 2. Architettura e flusso

```
launchCoin.js ──deploya──▶ PerpsPadToken (ERC20 supply fissa, burn(), no owner)
      │
      ├─────crea──────────▶ pool Uniswap V3 one-sided (tutta la supply, quote USDG)
      │
      └─────locka─────────▶ PerpsPadLocker (NFT LP per SEMPRE, solo collect verso il sub-wallet)
                                  │  fee → sub-wallet della coin
keeper.js (loop ~15s, per coin)   ▼
  0. riconcilia profitto perp rientrato da Lighter → 75% buyback / 25% treasury
  1. collect(lpTokenId)         (sub-wallet = HMAC(masterSecret, tokenAddr), chiave solo in RAM)
  2. split lato quote (USDG):   42.5% perp / 15% creator / 21.25% treasury / 21.25% buyback
  3. burn lato coin
  4. payout creator + treasury (min $1)
  5. buyback&burn (floor $25, max $25/tick, minOut quotato dal pool)
  6. perp su Lighter (§6): deposito USDG via intent-address → open/topup → take-profit → withdraw
```

**Garanzie replicate dal paper:** token senza admin; LP irrecuperabile (il locker non ha owner né
withdraw); fee sempre e solo verso il sub-wallet registrato; creator = solo destinazione payout;
ogni movimento e' una tx on-chain verificabile.

---

## 3. Layout del repo

```
contracts/
  PerpsPadToken.sol / .json     ERC20 supply fissa + burn() (riduce totalSupply). No owner.
  PerpsPadLocker.sol / .json    Lock permanente NFT V3: safeTransferFrom con data=abi.encode(subWallet);
                                collect(tokenId) pubblica → fee SOLO al recipient registrato. Niente withdraw/owner.
config.js                       tutte le costanti + parametri da env (indirizzi V3, USDG, split, gate, Lighter).
deployLocker.js                 deploy one-shot del locker → state/locker.deployed.json + PERPSPAD_LOCKER.
launchCoin.js                   lancio completo: deploy token → pool one-sided → lock → registry.
keeper.js                       il loop. tickCoin() = fee engine; perpTick() = gamba Lighter.
lib/
  subwallet.js                  deriveSubWallet(coinId) = HMAC-SHA256(masterSecret, token); checkFingerprint().
  v3.js                         TickMath (port esatto), buildLaunchPlan (one-sided), buildSwapCalldata.
  chain.js                      provider, ERC20 helpers, priceUsd/usdOf/rawFromUsd, gasPrice.
  registry.js                   state/registry.json: anagrafica coin + contabilita' bucket per coin.
lighter/
  sidecar.py                    ponte Python → lighter-sdk (il signing zk esiste solo lì). Comandi JSON.
  client.js                     RPC Node → sidecar (execFile). enabled/simulate + metodi per il keeper.
  requirements.txt              lighter-sdk, eth-account.
state/                          runtime (gitignored): registry.json, locker.deployed.json, fingerprint.json, keeper.lock.
.env.example                    tutte le variabili. Copia in .env e riempi.
README.md                       dettaglio tecnico (contratti, sicurezza, Lighter).
HANDOFF.md                      questo file.
```

---

## 4. Indirizzi e costanti (Robinhood Chain, chainId 4663)

Uniswap V3 (fork):
- V3Factory `0x1f7d7550B1b028f7571E69A784071F0205FD2EfA`
- NonfungiblePositionManager `0x73991a25C818Bf1f1128dEAaB1492D45638DE0D3`
- SwapRouter02 `0xCaf681a66D020601342297493863E78C959E5cb2`

Token:
- USDG (Global Dollar, 6 dec) `0x5fc5360D0400a0Fd4f2af552ADD042D716F1d168` — quote/collaterale di default
- WETH `0x0Bd7D308f8E1639FAb988df18A8011f41EAcAD73`

Lighter (profilo **ROBINHOOD** nativo del SDK):
- API `https://api.rh.lighter.xyz`, WS `wss://api.rh.lighter.xyz/stream`, chain_id **466324**
- deposito da Robinhood Chain (4663) via intent-address (unica rete sorgente elencata)
- **39 mercati PERP** (idx 0-38). Riferimento: BTC=1, ETH=0, SOL=3, NVDA=15, TSLA=16, AAPL=10,
  META=13, MSFT=14, GOOGL=12, AMZN=11, COIN=23, AMD=29, PLTR=34, SPY=26, QQQ=25, ANTHROPIC=38...
  (26 order book idx>=2048 sono **SPOT** quotati USDG, ROUTE_SPOT — NON usarli come mercato perp).
  La mappa vera si ottiene sempre a runtime: `python lighter/sidecar.py markets`.

---

## 5. Setup da zero

```bash
# 1. Node
npm install                         # ethers@5 + dotenv

# 2. Python per Lighter (la gamba perp)
python3 -m venv lighter/.venv
lighter/.venv/bin/pip install -r lighter/requirements.txt
lighter/.venv/bin/python lighter/sidecar.py selftest   # deve stampare profilo robinhood + 65 markets

# 3. Config
cp .env.example .env                # poi riempi DEPLOYER_PRIVATE_KEY, PERPSPAD_MASTER_SECRET,
                                    # PERPSPAD_TREASURY, ROBINHOOD_RPC_URL, PERPSPAD_LIGHTER_PYTHON
```

I contratti sono gia' compilati (`contracts/*.json`). Per ricompilare serve Foundry:
`forge build` con solc 0.8.24 (vedi header dei .sol). Gli artifact sono `{contractName, abi, bytecode}`.

---

## 6. La gamba perp Lighter — come funziona (leggi bene)

Il pezzo piu' sottile. Punti chiave:

- **Deposito.** Il keeper accumula la quota perp (42.5%) in USDG nel sub-wallet. Quando supera $20:
  crea un **intent-address** (`create_intent_address(chainId=4663, fromAddr=subWallet, amount)`) e ci
  manda quegli USDG con un transfer su 4663. Lighter accredita il collaterale in ~10 secondi.
- **Account isolato per coin, gratis.** L'account Lighter e' keyed dall'**indirizzo che deposita**
  (il sub-wallet). Quindi ogni coin ha automaticamente il suo account Lighter isolato, senza gestire
  sub-account manualmente.
- **Chiave API.** Per firmare gli ordini serve una chiave API registrata sull'account, firmando
  `change_api_key` con la chiave del sub-wallet (che il keeper ha). Il keeper lo fa da solo. La chiave
  API puo' gestire la posizione ma **non** prelevare verso terzi (i withdraw vanno all'indirizzo L1
  originante). Viene persistita nel registry (`lighterApiPrivKey`) — e' un segreto a raggio ristretto.
- **Modi** (`PERPSPAD_LIGHTER_MODE`): `off` (stub, la riserva accumula in USDG), `simulate` (legge e
  LOGGA cosa farebbe, non invia nulla — usalo PRIMA del live), `live` (opera davvero).
- **Take-profit.** +25% del collaterale sopra l'HWM → chiude 20% (reduce-only). Il profitto realizzato
  viene **prelevato** verso il sub-wallet; la riconciliazione a inizio tick lo splitta 75% buyback /
  25% treasury. Il credito e' guidato dal **saldo USDG reale** del sub-wallet, non da un numero →
  niente riserve fantasma anche se il withdraw settla in ritardo.
- **Latenza withdraw.** Il withdraw "normale" zk NON e' immediato (batch di proof su L1: minuti-ore).
  Il design ne tiene conto: si accredita solo quando gli USDG sono fisicamente arrivati.

### Sidecar — comandi (tutti JSON in argv[2], JSON su stdout)
`selftest, markets, resolve-account, account, intent-address, deposit-latest, register-key,
set-leverage, open, close, add-margin, withdraw`. Segreti via ENV: `LIGHTER_API_PRIVKEY` (ordini),
`LIGHTER_ETH_PRIVKEY` (register-key). Vedi l'header di `lighter/sidecar.py`.

---

## 7. Cosa e' VALIDATO (e come), cosa NO

**Validato e2e su fork anvil** (chain reale forkata, whale USDG impersonato):
- lancio completo, lock, claim, split 42.5/15/21.25/21.25, burn, payout, buyback&burn con minOut quotato;
- checkpoint per-step, lockfile single-instance, fingerprint master-secret, `--dry` sicuro, validazione `--lp`;
- riconciliazione del profitto perp rientrato (iniettato pending + USDG → treasury +25 on-chain, buyback +75);
- modo `simulate` (nessuna tx) vs `live` (deposito reale $ sul fork).

**Validato LIVE su mainnet** (2026-08-11, wallet di test con ~$22 — dettagli in HANDOFF.secrets.local.md):
- deposito via intent-address → account Lighter creato in ~10s → collateral accreditato;
- register-key, set-leverage 2x isolated, open market (long 0.00031 BTC), read posizione, close reduce-only,
  withdraw (accettato, collaterale scalato). Round-trip ~$0.03 di spread.

**NON ancora fatto / da validare:**
- il **settlement L1 del withdraw** (in coda al momento della scrittura — c'era un monitor bg);
- un ciclo perp che tiene una posizione APERTA nel tempo col keeper live (take-profit reale su un mosso);
- un lancio di **produzione** end-to-end (serve master secret + deployer reali).

---

## 8. Go-live checklist (primo lancio di produzione)

1. **Genera e backuppa** `PERPSPAD_MASTER_SECRET` (`openssl rand -hex 32`). Offline. Perderlo = perdere i sub-wallet.
2. Metti nel `.env`: `DEPLOYER_PRIVATE_KEY` (EOA con ETH per gas), `PERPSPAD_TREASURY`, `ROBINHOOD_RPC_URL`,
   `PERPSPAD_LIGHTER_PYTHON` (path del venv).
3. `node deployLocker.js` → copia l'address in `PERPSPAD_LOCKER`.
4. `node launchCoin.js --dry --name "Nome" --symbol SYM --market NVDA --side long --lev 3` → controlla il piano.
5. `node launchCoin.js --name "Nome" --symbol SYM --market NVDA --side long --lev 3` → lancio reale (IRREVERSIBILE: il lock e' permanente).
6. `PERPSPAD_LIGHTER_MODE=simulate node keeper.js` → guarda che deposito/open loggati siano sensati.
7. `PERPSPAD_LIGHTER_MODE=live node keeper.js` → produzione. Tienilo come servizio (un solo processo: c'e' il lockfile).

Consiglio: prima coin con leva bassa (2-3x) e un mercato liquido (BTC/ETH) finche' non hai osservato un ciclo completo.

---

## 9. Known issues / TODO (in ordine di importanza)

1. **Buyback minOut degenere su pool mai scambiato.** Su una coin appena lanciata (prezzo al bordo del
   range, nessuno scambio) la quote in forma chiusa del `minOut` degenera a ~0 → protezione slippage
   inefficace. Nessuna perdita, e sano appena c'e' trading. Fix opzionale: `buybackMinOut` restituisce ~0
   → skip del buyback quel tick. Vedi `keeper.js` `buybackMinOut()`.
2. **Riconciliazione dagli eventi al boot non implementata.** Se si perde `state/registry.json`, i fondi
   sono salvi nei sub-wallet (riderivabili dal master secret) ma la ripartizione nei bucket va ricostruita
   a mano dagli eventi `Collected`. Perpspad lo fa con un DB. TODO: ricostruzione da log on-chain.
3. **Quote non-USDG.** Se una coin usa un pair ≠ USDG serve il prezzo USD (`PERPSPAD_PRICE_<SYM>`, manuale).
   TODO: integrare Rialto `/quote` (c'e' gia' esperienza nel monorepo, memoria `rialto-router-api`).
4. **Take-profit sizing.** `pos.size` viene assunto float scalato per `sizeDec`; validato solo la lettura,
   non un vero take-profit su un mosso. Ricontrolla quando lo eserciti live.
5. **Withdraw → burn loop live.** La riconciliazione e' validata su fork; il withdraw reale settla con
   latenza. Verifica il ciclo completo la prima volta con importi piccoli.
6. **Cap sub-account tier.** Ogni coin = account Lighter separato (via deposito), quindi il cap 8/64
   sub-account per tier NON ci limita — ma verifica se Lighter mette limiti sul numero di account per master.

---

## 10. Sicurezza / audit

5 subagent hanno auditato contratti, contabilita', key-management. Fix applicati e testati:
- **Contratti:** `require(to != address(0))` nel token; locker senza owner/withdraw, `feeRecipient` one-shot.
- **Lancio:** `--dry` esce prima di ogni tx irreversibile; `--lp` validato via `positions()`; **fingerprint**
  del master secret (secret diverso → ABORT); `eth_call` pre-fire; pool a tick sbagliato → serve `--force`.
- **Keeper:** contabilita' da **delta reale** (non static); **checkpoint per-step** (crash → under-pay, mai
  double-pay); buyback con `amountOutMinimum` reale; **lockfile** single-instance; **cap gasPrice** sui
  top-up; **timeout** su `wait()`; validazione `SPLIT_BPS == 10000`.

Rischi residui (responsabilita' operatore): il **master secret** e' single point of failure; il locker e'
**irreversibile** (un lock sbagliato non si annulla — per questo ci sono fingerprint + validazione `--lp` +
`--dry`); keeper/RPC/Lighter sono dipendenze live (un outage pausa, non perde).

**Segreti:** MAI committare `.env`, `state/*.json` (contiene le API key Lighter delle coin), o
`*.local.md`. Sono tutti in `.gitignore`. I valori reali di questo progetto stanno in
`HANDOFF.secrets.local.md` (locale, non nel repo).

---

## 11. Testare su fork (ricetta)

```bash
# fork della chain reale
anvil --fork-url <RPC_ALCHEMY> --port 8545 --chain-id 4663

# env di test (chiavi anvil di default, registry isolato)
export ROBINHOOD_RPC_URL=http://127.0.0.1:8545
export DEPLOYER_PRIVATE_KEY=0xac0974bec39a17e36ba4a6b4d238ff944bacb478cbed5efcae784d7bf4f2ff80
export PERPSPAD_MASTER_SECRET=test-secret
export PERPSPAD_TREASURY=0x70997970C51812dc3A010C7d01b50e0d17dc79C8
node deployLocker.js && node launchCoin.js --name Test --symbol TST --market BTC --side long --lev 3

# generare fee: impersona una whale USDG e fai buy/sell sul pool via SwapRouter02 (vedi la history).
# poi: node keeper.js --once
```
Nota: su fork le chiamate READ a Lighter (api.rh.lighter.xyz) funzionano, ma i depositi fatti sul fork
NON vengono accreditati (l'API reale non vede la chain forkata) → il keeper aspetta con grazia. Per
testare la gamba perp mutante serve mainnet con un account finanziato (vedi §7).

---

## 12. Note sparse utili

- Il keeper e' **un solo processo** (lockfile in `state/keeper.lock`). Non lanciarne due.
- Gas: i sub-wallet pagano il loro gas; il keeper li rifornisce (`ensureGas`, cap da `MAX_GAS_PRICE_WEI`).
- `--once` su `keeper.js` fa un solo giro (comodo per debug).
- Explorer Robinhood Chain: `robinhoodchain.blockscout.com` (API v2 richiede User-Agent browser).
- Il monorepo originale (`robinhood-chain`) ha script correlati (launchDirect, Rialto, bridge) non inclusi qui:
  se ti serve la matematica V3 o il router Rialto, la logica di riferimento e' li'.
