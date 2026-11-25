# The multiply.cash keeper: Node loop + the Python sidecar that signs Lighter orders.
#
# Runs on Railway (see railway.json). State lives on a volume mounted at /data
# (PERPSPAD_STATE_DIR); secrets come from the platform's variables, never from this image.

FROM node:22-bookworm-slim

# Python for lighter/sidecar.py: Lighter's signing ships only in its Python/Go SDKs.
# The SDK bundles the native signer (lighter-signer-linux-amd64.so). Versions are pinned.
# 1.1.3 is the first signer that accepts market ids from 4095 up (ANT, SNDK, UNI, …): 1.1.2
# rejects them with "MarketIndex is not valid", and a token there would never open.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/lighter \
 && /opt/lighter/bin/pip install --no-cache-dir lighter-sdk==1.1.3 eth-account==0.13.7

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY config.js keeper.js ./
COPY lib ./lib
COPY lighter/client.js lighter/rest.js lighter/sidecar.py lighter/requirements.txt ./lighter/

ENV NODE_ENV=production \
    PERPSPAD_LIGHTER_PYTHON=/opt/lighter/bin/python \
    PERPSPAD_STATE_DIR=/data

# fails the build if the SDK or its native signer cannot be loaded on this platform
RUN /opt/lighter/bin/python -c "import lighter; print('lighter-sdk ok')"

CMD ["node", "keeper.js"]
