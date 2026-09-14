# multiply.cash — piano di test pre-lancio

Test su **mainnet Robinhood Chain (4663)** con fondi reali. Ogni scenario dichiara
il risultato atteso PRIMA dell'esecuzione; i risultati e i finding si aggiungono dopo.

Indirizzi di deployment e stato operativo: `LIVE.local.md` (gitignorato).

---

## Perche' questi scenari

Dopo TEST1 (BTC long 2x safe, ciclo completo) e TEST2 (NVDA long 3x degen, aperto)
restano **quattro buchi di copertura**, tutti su codice mai esercitato con denaro vero:

| Buco | Rischio se sbagliato |
|---|---|
| **SHORT** mai testato | direzione ordine invertita, target calcolato dalla parte sbagliata, PnL con segno errato → il motore comprerebbe invece di vendere |
| profilo **balanced** mai usato | trigger 0.50 mai verificato end-to-end |
| **leva alta** (max provato 3x) | dimensionamento sotto i minimi di mercato, liquidazione stretta |
| **topup** (2ª tranche su posizione viva) | la diluizione che le tranche esistono per evitare |

---

## Matrice

| ID | Mercato | Lato | Leva | Profilo | Collaterale | Notional | Copre | Esito |
|---|---|---|---|---|---|---|---|---|
| TEST1 | BTC | long | 2x | safe | $14.70 | $29.40 | ciclo completo | ✅ chiuso |
| TEST2 | NVDA | long | 3x | degen | $13.70 | $46.65 | retry-until-fill + topup | ✅ aperto |
| TEST3 | TSLA | **short** | 5x | **balanced** | $3.20 | $16.00 | short + balanced | ✅ aperto |
| TEST4 | ETH | long | **10x** | safe | $2.20 | $15.00 | leva alta, TP a +2% | ✅ aperto (dopo fix) |
| TEST5 | HYPE | **short** | **20x** | degen | $1.80 | $34.20 | leva estrema + short | ✅ aperto (dopo fix) |
| TEST6 | (topup su TEST2) | — | — | — | $2.20 | $12.15 | 2ª tranche, anti-diluizione | ✅ verificato |

**Stato tranche a fine sessione** (target = entry × (1 ± trigger/leva)):

| Coin | # | base | entry | target | movimento richiesto |
|---|---|---|---|---|---|
| TEST2 | 1 | 1532 | $225.23 | $300.31 | NVDA +33.3% |
| TEST2 | 2 | 539 | $225.53 | $300.71 | NVDA +33.3% |
| TEST3 | 1 | 468 | $341.61 | $307.45 | TSLA −10.0% |
| TEST4 | 1 | 79 | $1887.65 | $1925.40 | ETH +2.0% |
| TEST5 | 1 | 594 | $57.574 | $54.70 | HYPE −5.0% |

TEST1 e' senza tranche: ha gia' completato il ciclo (chiusura → prelievo → buyback&burn)
e riaccumula dalle fee.

Soglie abbassate per il test (`.env`): `OPEN_GATE_USD=1.5`, `TOPUP_STEP_USD=1.5`.
In produzione tornano a 20/20. Minimo d'ordine Lighter: **$10 di notional** su tutti
i mercati, piu' il `min_base` specifico — motivo per cui a leva alta serve meno collaterale.

---

## TEST3 — TSLA short 5x, profilo balanced

**Risultato atteso**
1. Lancio: mcap iniziale ~$4.009, LP NFT lockato, `burnToken` = il token della coin.
2. Deposito al gate → account Lighter creato → chiave API cifrata → leva **5x isolated**.
3. Apertura con `isAsk = true` (short): posizione con **`sign = -1`** su Lighter.
4. Tranche registrata con target **sotto** l'entry: `entry × (1 − 0.50/5)` = **entry −10%**.
5. Se TSLA scende del 10%, la tranche matura e il close usa `isAsk = false` (ricompra).

**Risultato: ✅ PASS — tutto come atteso, al primo colpo**

- Lancio OK, LP NFT `#681879` lockato, sub-wallet `0xD5C1…455e`, account Lighter `2168`.
- Apertura: `perp open: notional $16.00 short 5x (fill 468/468 @ 341.61)` — **fill 100%**.
- Tranche: `base 468 | entry $341.61 → target $307.45` = **entry −10%**, sotto l'entry ✓
- Profilo `balanced` (trigger 0.50) applicato correttamente: 0.50 / 5x = 10% di TSLA.

**Finding**: nessuno. Lo short — il buco di copertura piu' grosso — funziona in ogni
sua parte: direzione dell'ordine, segno della posizione, target calcolato al ribasso.
Da notare che TSLA e' il mercato **meno liquido** della matrice ($137k di volume 24h,
66 trade) e ha riempito comunque istantaneamente.

---

## TEST4 — ETH long 10x, profilo safe

**Risultato atteso**
1. Con $2 di collaterale il notional e' $20 > minimo $10 → ordine valido nonostante
   il collaterale minuscolo (verifica dell'efficienza di capitale a leva alta).
2. Tranche target: `entry × (1 + 0.20/10)` = **entry +2%** → ETH deve muoversi solo
   il 2% perche' il take-profit scatti: **il ciclo completo dovrebbe ripetersi da solo**
   in tempi brevi.
3. Liquidazione attesa intorno a **−9%** di ETH (isolated).

**Risultato: ⚠️ FALLITO al primo tentativo → bug trovato → PASS dopo il fix**

- Lancio OK, LP `#681884`, account Lighter `2169`, leva 10x isolated impostata.
- Apertura con $2.20 di collaterale (notional $22): **ordine accettato ma MAI riempito**,
  ripetutamente. Nessuna posizione, collaterale intatto, nessun errore dall'API.
- Dopo il fix (buffer sul collaterale): posizione aperta, margine $1.49, tranche
  `base 79 | entry $1887.65 → target $1925.40` = **entry +2%** come previsto ✓

**Finding: BUG #6 — impiegare il 100% del collaterale fa scartare l'ordine in silenzio.**

Diagnosi: il book era profondo (ask 0.15 ETH contro i nostri 0.0117), le size sopra i
minimi, l'ordine restituiva `code=200` con tx_hash. Prova decisiva, stesso conto e
stesso mercato a distanza di secondi:

| Notional richiesto | % del collaterale | Esito |
|---|---|---|
| $22.00 | 100% | **nessun fill** |
| $15.00 | 68% | **fill regolare**, margine $1.49 |

Causa: Lighter calcola il margine richiesto sul prezzo di **esecuzione**, mentre il
keeper dimensionava sul **mark** impiegando tutto il saldo. Basta un tick di prezzo
sfavorevole tra le due letture perche' il requisito superi il disponibile — e l'ordine
viene scartato senza errore. Non e' un problema di leva: e' un **testa-o-croce** che a
100% di impiego perdi ogni volta che il prezzo si muove nella direzione sbagliata.
TEST1/2/3 avevano semplicemente avuto fortuna.

Fix: `COLLATERAL_HEADROOM` (default **0.95**) — si impiega il 95% del libero. Piu' il
controllo preventivo sul minimo d'ordine (sotto).

---

## TEST5 — HYPE short 20x, profilo degen

**Risultato atteso**
1. Leva estrema: $1.5 di collaterale → $30 di notional. Verifica che il dimensionamento
   regga ai limiti (`min_base` HYPE = 0.100 ≈ $5.75).
2. Tranche target: `entry × (1 − 1.00/20)` = **entry −5%**.
3. **Liquidazione a ~+4.5%**: e' lo scenario piu' fragile della matrice ed e' voluto —
   se HYPE sale, ci aspettiamo la liquidazione e vogliamo vedere il keeper reagire
   correttamente (`posizione sparita → tranche azzerate`, motore che riparte dalle
   fee successive senza stato sporco). Perdita massima: il collaterale ($1.5).

**Risultato: ✅ PASS (dopo il fix del BUG #6)**

- Lancio OK, LP `#681887`, account Lighter `2170`, leva **20x isolated** accettata.
- Apertura: `perp open: notional $34.20 short 20x (fill 594/594 @ 57.574)` — **fill 100%**
  con appena $1.71 di collaterale impiegato. Efficienza di capitale a leva alta: confermata.
- Tranche: `base 594 | entry $57.574 → target $54.70` = **entry −5%** ✓

**Finding**: la leva estrema non introduce problemi di suo — falliva per lo stesso
BUG #6 di TEST4, non per il 20x. La posizione resta il candidato piu' probabile a una
liquidazione (basta +4.5% di HYPE): resta aperta apposta, come test del ramo
"posizione sparita" con denaro vero.

---

## TEST6 — Topup su TEST2 (seconda tranche)

**Risultato atteso**
1. $2 inviati al sub-wallet di TEST2 → sweep → deposito → **topup** della posizione esistente.
2. Nel registry compaiono **due tranche**: la prima conserva il suo target originale
   ($300.31), la seconda ne riceve uno nuovo calcolato dal mark del momento.
3. **La prima tranche NON viene riscalata** (e' il fix anti-diluizione): la sua `base`
   resta identica a prima del topup.
4. Il pannello TRANCHES del sito mostra due righe con barre di avanzamento diverse.

**Risultato: ✅ PASS — l'anti-diluizione regge con denaro vero**

Primo tentativo con $2.00: notional $5.88 < $10 → il keeper **rifiuta di inviare
l'ordine** e logga `collaterale insufficiente per il minimo d'ordine … accumulo`
(comportamento corretto, vedi finding). Con $2.20 aggiuntivi:

`perp topup: notional $12.15 long 3x (fill 539/539 @ 225.53)`

Stato delle tranche di TEST2 dopo il topup:

| # | base | entry | target |
|---|---|---|---|
| 1 | **1532** (invariata) | $225.23 | $300.31 (invariato) |
| 2 | 539 | $225.53 | $300.71 |

La tranche vecchia conserva `base` ed entry: il topup **non ha diluito** il suo
progresso, che era esattamente lo scopo del design a tranche. Le due corrono verso
target distinti.

**Finding: i topup devono rispettare il minimo d'ordine come le aperture.** Un topup
sotto `min_quote_amount` verrebbe scartato in silenzio (stesso meccanismo del BUG #6).
Aggiunto il controllo preventivo: se `deployable × leva < min_quote` il keeper non
invia nulla, logga una volta sola e accumula fino a superare la soglia.

---

## TEST7 — Chiusura di uno SHORT (forzata, 2026-08-14)

Ultimo path di chiusura mai esercitato: TEST1 chiudeva un **long**, l'inversione della
direzione sul close di uno short era coperta solo dai test a secco.

**Atteso**: trigger abbassato su TEST3 (TSLA short 5x) → la tranche matura → close con
`isAsk = false` (ricompra) → posizione a zero, tranche azzerate, profitto realizzato.

**Risultato: ✅ PASS**

```
[TEST3] TAKE-PROFIT (balanced): chiusa base 468/468 (fill 100%), realizzato ~$0.01
```

Verifica su Lighter: **0 posizioni**, collaterale tornato libero ($3.21), tranche
azzerate nel registry, `perpOpen: false`, realized $0.0094. TSLA era scesa da $341.61
a $341.33 → lo short ha chiuso in (minimo) profitto.

**Finding**: nessuno. Il trigger e' stato calcolato dal mark corrente con un margine
dell'1% invece di usare un valore fisso — un trigger a occhio avrebbe potuto non
scattare, o scattare su altre coin dello stesso profilo.

## TEST8 — Maturazione SELETTIVA multi-tranche (forzata, 2026-08-14)

Il caso che il design a tranche esiste per gestire: **una tranche matura, l'altra no**.
Mai visto live.

**Atteso**: su TEST2 (NVDA long 3x, tranche `1532@225.230` e `539@225.530`) un trigger
che collochi il mark **tra i due target** → chiude solo la #1, la #2 resta in corsa.

**Risultato: ✅ PASS**

Le due tranche distano solo lo **0.13%**, quindi il trigger e' stato calcolato per
centrare il mark nel corridoio (margine 0.067% per lato):

```
mark 227.693 | target#1 227.542 (matura) | target#2 227.845 (resta)
[TEST2] TAKE-PROFIT (degen): chiusa base 1532/1532 (fill 100%), realizzato ~$0.38
```

| Verifica | Atteso | Trovato |
|---|---|---|
| size su Lighter | 0.0539 (solo la #2) | **0.0539** ✓ |
| tranche nel registry | 1 → `539@225.530` | **1 → `539@225.530`** ✓ |
| realizzato | positivo (NVDA salita a 227.69) | **$0.3774** ✓ |

**Finding**: nessuno. La chiusura parziale ha colpito esattamente la tranche giusta e
ha lasciato l'altra intatta con il suo entry e il suo target originali.

Nota su entrambi: dopo le chiusure il keeper ha **ridispiegato da solo** il collaterale
liberato come tranche nuove ai prezzi correnti (`TEST2 topup 1469@227.58`,
`TEST3 open 445@341.6`) — il motore riparte senza intervento, come da design.

## Finding cumulativi dei test live

Bug trovati con denaro vero che fork e test a secco non avevano intercettato — tutti
al confine tra il nostro codice e i sistemi esterni:

| # | Dove | Sintomo | Causa | Stato |
|---|---|---|---|---|
| 1 | `keeper.js` `send()` | prima `collect()` fallita | il `gasLimit` di fallback veniva passato a `estimateGas`, che lo usa come **tetto**: la stima falliva proprio quando serviva di piu' (323k richiesti vs 300k) | ✅ corretto |
| 2 | `keeper.js` step 8 | intent di withdraw appeso per sempre | il write-ahead trattava un **rifiuto definitivo** dell'API come esito ambiguo; il profitto usciva dalla contabilita' | ✅ corretto |
| 3 | `lib/chain.js` ABI | tick fallito dopo il settlement | l'ABI ERC20 dichiarava le funzioni ma **non l'evento `Transfer`**, usato dalla riconciliazione per il matching del mittente | ✅ corretto |
| 4 | `keeper.js` step 6 | tranche fantasma su NVDA | l'ordine IOC in pre-market era **accettato ma non riempito**: la tranche veniva registrata dall'ordine, non dal fill | ✅ corretto |
| 5 | `web/lib/chain.ts` | prezzi assenti sul sito | il trasporto HTTP di ethers v5 **non funziona nel runtime server di Next** ("missing response"); il fetch nativo si | ✅ corretto |
| 6 | `keeper.js` step 6 | ordine accettato ma **mai riempito**, in silenzio | si impiegava il **100% del collaterale**: Lighter valuta il margine al prezzo di **esecuzione**, quindi un tick sfavorevole tra il mark e il fill manda il requisito sopra il disponibile. Prova: $22 notional su $2.20 → niente; $15 → fill | ✅ corretto (`COLLATERAL_HEADROOM` 0.95) |
| 7 | `keeper.js` step 6 | topup piccoli scartati in silenzio | nessun controllo del `min_quote_amount` prima di inviare: sotto $10 di notional l'ordine muore senza errore | ✅ corretto (skip + log, accumula) |
| 8 | `keeper.js` step 6 | **tranche-spazzatura** su TEST5: 7 tranche di cui 6 da 1-17 unita' | col PnL non realizzato che gonfia `available_balance`, il keeper tentava di impiegarlo: l'exchange concede margine sul **realizzato**, non sul potenziale, quindi riempiva solo una scheggia a ogni tick | ✅ corretto (fusione + `MIN_DEPLOY_USD`) |
| 9 | operativo (macOS) | il keeper **muore a ogni chiusura di sessione**: il soak test non accumulava mai giorni | launchd non puo' eseguire nulla in `~/Desktop` senza Full Disk Access (exit 126, TCC di macOS) | ✅ risolto: repo spostata in `~/apps/leverage-pad`, keeper sotto launchd |

### Nota operativa — come gira il keeper adesso

Avviato con sessione propria (`start_new_session`), quindi sopravvive alla chiusura del
terminale: `PPID 1`, log persistente in `logs/keeper.log` (gitignorato).

```
ps -o pid,ppid,sess,command -p <pid>    # verifica che sia staccato
tail -f logs/keeper.log                 # segui i tick
pkill -f "node keeper.js"               # fermalo
```

Restano pronti `keeper-service.sh` e `~/Library/LaunchAgents/cash.multiply.keeper.plist`
(caricabile con `launchctl load`): funzioneranno appena la repo sta fuori da `~/Desktop`,
e allora il keeper riparte anche dopo un reboot con riavvio automatico se muore.

### Dettaglio finding #8 — tranche inchiudibili da fill-scheggia

Osservato in produzione su **TEST5** (HYPE short 20x) dopo che il mercato era sceso e
lo short era andato in profitto:

```
594 @ 57.574   ← l'apertura vera
 17 @ 55.755   ┐
  1 @ 55.687   │  27 unita' (4% della posizione)
  1 @ 55.728   ├─ sparse su SEI tranche, tutte
  1 @ 55.890   │  sotto il minimo d'ordine HYPE (100)
  1 @ 55.910   │
  6 @ 55.905   ┘
```

Nessuna perdita di fondi: la somma (621) combaciava con la size on-chain e l'entry
medio pesato ($57.497) con quello di Lighter ($57.488). Ma **una tranche piu' piccola
del minimo di mercato non puo' mai essere chiusa da sola**: non deve esistere come
entita' separata. Piu' il rumore: tentativi d'ordine sprecati a ogni tick.

Fix in due parti:
1. `addTranche()` — un fill sotto `min_base` si **fonde** nella tranche precedente con
   entry medio pesato (contabilmente il valore corretto), invece di crearne una nuova.
2. `MIN_DEPLOY_USD` (default **$2**) — sotto questa cifra il collaterale libero non si
   impiega affatto: meglio accumulare che tentare aperture destinate a riempirsi male.

Pulizia dello stato esistente: le 7 tranche di TEST5 sono state ricondotte a **una da
621 unita' @ $57.497** usando la stessa funzione del keeper, con invariante verificata
(somma identica alla size on-chain). Coperto da 5 nuovi test a secco (28 in totale).

Limiti esterni scoperti (non bug, ma vincoli da rispettare):

- **Minimo di prelievo Lighter**: $0.07 rifiutato (`code=21116`). Il floor di produzione
  ($25) sta ben sopra — documentato in `config.js`.
- **Intent-address**: `amount` accettato solo in **raw a 6 decimali**; con `"0"` restituisce
  lo stesso indirizzo → il matching del bridge e' per **mittente**, non per importo.
- **Ordini IOC**: "accettato" non implica "riempito" — vale sia in apertura sia in chiusura.
- **Mercati stock chiusi**: fuori orario il book e' vuoto e gli ordini non si riempiono;
  il keeper deve ritentare (e lo fa).

---

## TEST9 — LIQUIDAZIONE (accaduta davvero, 2026-08-14)

Lo scenario che non si poteva forzare: TEST5 (HYPE short 20x degen) e' stato
**liquidato dal mercato**. HYPE e' salito da $57.497 a $59.166 (**+2.9%**) e a leva 20x
quel movimento ha consumato il collaterale.

**Risultato: ✅ PASS — il keeper ha reagito esattamente come progettato**

```
[TEST5] tranches: posizione sparita (liquidata o chiusa fuori dal keeper): tranche azzerate
```

| Verifica | Atteso | Trovato |
|---|---|---|
| posizioni su Lighter | 0 | **0** ✓ |
| tranche nel registry | azzerate | **azzerate** ✓ |
| `perpOpen` | false | **false** ✓ |
| stato residuo | nessuna tranche fantasma, nessun realized fantasma | **pulito** ✓ |
| perdita | confinata al collaterale isolato | **$1.08 su $1.80** (residui $0.72) ✓ |

Il ramo di riconciliazione `posBase 0 → azzera` — quello reso raggiungibile dal fix #2,
prima coperto solo dai test a secco — ha funzionato con denaro vero. La perdita e'
rimasta **confinata al margine isolato** di quella coin: gli altri quattro motori non
sono stati toccati, e TEST5 riprende ad accumulare dalle fee successive senza stato
sporco. E' esattamente il comportamento che rende accettabile la leva alta: il caso
peggiore e' limitato e recuperabile.

## TEST10 — Take-profit ORGANICI + soak test di 12 giorni (17–29 agosto)

L'ultima voce aperta si e' chiusa da sola. Col keeper sotto launchd in `~/apps` per
12 giorni, senza alcun intervento:

- **TEST4 (ETH long 10x safe): 12 take-profit organici**, tutti fill 100%, trigger di
  produzione (+2% di ETH per tranche), realizzato cumulativo **$5.72**. Il motore ha
  ripetuto il ciclo maturazione → chiusura → ridispiegamento in autonomia per due
  settimane. Il realizzato resta sotto il floor di prelievo ($25): corretto, si
  accumula (la catena a valle e' gia' validata su TEST1).
- **Stabilita'**: sopravvissuto a **1.000 outage dell'RPC pubblico** ("could not detect
  network") e 28 errori di lettura — ogni volta il tick e' fallito soft e il successivo
  ha ripreso. Nessun crash, nessuna corruzione di stato, nessun double-spend.
- TEST2/TEST3 lontani dai target (degen/balanced: per design), nessuna nuova
  liquidazione.

**I test sono CONCLUSI.** Ogni voce della "definizione di concluso" e' verificata.

## Finding #10 — MAI spostare la repo col keeper acceso

Il 29/08 la repo e' stata rispostata da `~/apps` a `~/Desktop` col keeper in funzione.
Il processo e' sopravvissuto (cwd e file descriptor seguono l'inode della cartella),
ma i percorsi interni di Node (`__dirname`) sono **stringhe congelate all'avvio**: il
keeper ha continuato a cercare il registry nel vecchio percorso, inesistente → loop
sterile "nessuna coin nel registry", motori scoperti (~10 minuti), e uno scheletro
`apps/leverage-pad/state/` ricreato dalle scritture dello snapshot. In piu' il
KeepAlive di launchd avrebbe fatto ripartire il servizio dal percorso morto.

Rimedio applicato: zombie terminato, percorsi riportati su Desktop (fix-paths.sh),
plist disabilitato (`.disabled` — a Desktop launchd non puo' girare, finding #9),
scheletro rimosso, keeper riavviato staccato (setsid) da Desktop: 5/5 coin con tick
freschi.

**Regola operativa**: prima di spostare la cartella → `pkill -f "node keeper.js"`,
spostare, `fix-paths.sh`, riavviare. Il danno e' solo una pausa (fee e burn si
recuperano al tick dopo), ma la pausa e' silenziosa: il processo sembra vivo.

## Definizione di "concluso" — RAGGIUNTA ✅

| Cosa | Esito |
|---|---|
| Take-profit su movimento reale coi trigger di produzione | ✅ TEST10: 12 volte |
| Liquidazione gestita | ✅ TEST9 |
| Chiusure long/short, selettiva multi-tranche, topup, prelievo, bridge, buyback&burn | ✅ TEST1–8 |
| Stabilita' del keeper per giorni | ✅ 12 giorni, 1.000 outage RPC assorbiti |

Restano solo le voci della **checklist di go-live** (sezione sopra).

Piu' due voci di sola osservazione, che non richiedono nuovi test ma tempo:

- **Uptime del keeper** per giorni (stabilita', non correttezza) — ora possibile: il
  processo e' staccato dalla sessione, vedi finding #9.
- Piu' coin che competono per lo stesso tick con RPC lento.

Ogni altro path e' stato verificato con denaro vero: apertura long e short, chiusura
long e short, chiusura **selettiva** multi-tranche, topup senza diluizione, prelievo con
write-ahead (inclusi i rami di rifiuto), settlement del bridge, riconciliazione 75/25,
buyback&burn, riconciliazione da posizione aperta fuori dal keeper, rifiuto preventivo
sotto i minimi d'ordine, fusione dei fill-scheggia, liquidazione.

**Precisazione onesta su cosa dimostrera' TEST4**: il take-profit scattera' su un
movimento reale col trigger di produzione (safe = +20% del collaterale = +2% di ETH), ma
il profitto sara' di circa **$0.30** — sotto il floor di prelievo ($25) e sotto il minimo
di Lighter. Quindi TEST4 valida **l'innesco organico**, non l'intera catena a valle:
prelievo → bridge → 75/25 → buyback&burn e' gia' stata validata su TEST1 con importi
sufficienti. Nessuno dei due test copre l'altro pezzo, insieme coprono tutto.

## Checklist di go-live

Da fare **dopo** la chiusura di TEST4, prima di aprire al pubblico:

| # | Cosa | Perche' |
|---|---|---|
| 1 | Riportare `PERPSPAD_OPEN_GATE_USD` e `PERPSPAD_TOPUP_STEP_USD` a **20** nel `.env` | ora sono a 1.5 per far girare motori da pochi dollari; il keeper stampa gia' un avviso all'avvio |
| 2 | ~~Spostare la repo fuori da `~/Desktop`~~ **fatto**: ora in `~/apps/leverage-pad`, keeper sotto launchd con riavvio automatico verificato | vedi finding #9 |
| 3 | Nuovo `PERPSPAD_MASTER_SECRET` + backup offline | quello attuale e' di test; perderlo = perdere le fee accumulate nei sub-wallet |
| 4 | Deploy del locker **definitivo** e `PERPSPAD_LOCKER` aggiornato | i lock sono irreversibili: il locker di produzione va deployato una volta e non piu' toccato |
| 5 | Treasury su un indirizzo dedicato (ora e' il deployer) | separare chi incassa da chi firma |
| 6 | ~~Registry su storage condiviso~~ **fatto** — resta solo da servire `state/public.json` su un URL raggiungibile e impostare `PERPSPAD_REGISTRY_URL` | vedi sotto |
| 7 | Ricontrollare i cinque test con le soglie di produzione | le soglie basse hanno mascherato i minimi d'ordine: con gate $20 il comportamento e' diverso (e piu' semplice) |

### Snapshot pubblico per il deploy remoto (fatto)

Il registry contiene la chiave API Lighter di ogni coin: non puo' essere servito
com'e'. Il keeper ora pubblica a ogni tick un estratto sanitizzato in
`state/public.json` (`lib/publish.js`), costruito su **whitelist** — un campo nuovo,
magari un segreto aggiunto domani, non finisce pubblico per dimenticanza.

Il sito legge da `PERPSPAD_REGISTRY_URL` se impostata, altrimenti dal file locale
(sviluppo). Verificato end-to-end con il path locale **deliberatamente rotto**: le
quattro posizioni reali sono arrivate solo dall'URL, zero errori di lettura.

```
state/public.json → 5 coin, 15 campi, 4.9 KB, nessun segreto
```

Per il deploy: servire quel file (bucket, static host, o un endpoint del keeper) e
puntarci `PERPSPAD_REGISTRY_URL`.

### Spostamento della repo (preparato)

`scripts/fix-paths.sh` riscrive i percorsi assoluti nei quattro file che li
contengono (`.env`, `web/.env.local`, `keeper-service.sh`, il plist), con backup
`.bak` e stampa delle righe cambiate. Sposti la cartella, lanci lo script col
percorso vecchio, e launchd diventa utilizzabile.
