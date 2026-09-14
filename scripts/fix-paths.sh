#!/bin/bash
# fix-paths.sh — riscrive i percorsi assoluti dopo aver spostato la repo.
#
# Perche' serve: launchd non puo' eseguire nulla dentro ~/Desktop (protezione TCC
# di macOS, finding #9 in TESTPLAN.md). Spostando la repo altrove il keeper puo'
# diventare un servizio vero — ma quattro file contengono percorsi assoluti e
# dimenticarne uno rompe il keeper in modo silenzioso.
#
# Uso:
#   1. ferma il keeper:      pkill -f "node keeper.js"
#   2. sposta la cartella:   mv ~/Desktop/leverage-pad ~/apps/multiply
#   3. da dentro la nuova:   bash scripts/fix-paths.sh /Users/<tu>/Desktop/leverage-pad
#      (l'argomento e' il percorso VECCHIO, quello da sostituire)
#
# Fa un backup .bak di ogni file toccato e stampa le righe cambiate.

set -euo pipefail

OLD="${1:-}"
NEW="$(cd "$(dirname "$0")/.." && pwd)"

if [ -z "$OLD" ]; then
  echo "uso: bash scripts/fix-paths.sh <percorso-vecchio>"
  echo "esempio: bash scripts/fix-paths.sh /Users/guidofaux/Desktop/leverage-pad"
  exit 1
fi
if [ "$OLD" = "$NEW" ]; then
  echo "il percorso vecchio e quello nuovo coincidono ($NEW): niente da fare"
  exit 0
fi

echo "vecchio: $OLD"
echo "nuovo  : $NEW"
echo ""

PLIST="$HOME/Library/LaunchAgents/cash.multiply.keeper.plist"
FILES=("$NEW/.env" "$NEW/web/.env.local" "$NEW/keeper-service.sh" "$PLIST")

for f in "${FILES[@]}"; do
  if [ ! -f "$f" ]; then
    echo "· $f — assente, salto"
    continue
  fi
  if ! grep -q "$OLD" "$f" 2>/dev/null; then
    echo "· $f — nessun riferimento, ok"
    continue
  fi
  cp "$f" "$f.bak"
  # | come separatore: i percorsi contengono /
  sed -i '' "s|$OLD|$NEW|g" "$f"
  echo "✓ $f (backup in $(basename "$f").bak)"
  grep -n "$NEW" "$f" | sed 's/^/    /'
done

echo ""
echo "Fatto. Ora il keeper puo' girare come servizio launchd:"
echo "  launchctl unload $PLIST 2>/dev/null"
echo "  launchctl load   $PLIST"
echo "  launchctl list | grep multiply     # la colonna PID deve essere un numero"
echo "  tail -f $NEW/logs/keeper.log"
echo ""
echo "Verifica che il keeper riparta da solo:  pkill -f 'node keeper.js'  (launchd lo rialza)"
