#!/bin/bash
# Wrapper del keeper per launchd: percorsi assoluti (launchd non ha il PATH della
# shell) e modo live esplicito. Il resto della configurazione arriva dal .env,
# caricato da config.js — qui NON si scrivono segreti.
#
# Avvio/arresto:
#   launchctl load   ~/Library/LaunchAgents/cash.multiply.keeper.plist
#   launchctl unload ~/Library/LaunchAgents/cash.multiply.keeper.plist
# Log: logs/keeper.log nella repo (gitignorato).

cd /Users/guidofaux/Desktop/leverage-pad || exit 1
export PERPSPAD_LIGHTER_MODE=live
exec /Users/guidofaux/.nvm/versions/node/v23.3.0/bin/node keeper.js
