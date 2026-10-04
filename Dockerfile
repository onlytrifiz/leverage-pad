# The multiply.cash keeper: Node loop + the Python sidecar that signs Lighter orders.
#
# Runs on Railway (see railway.json). State lives on a volume mounted at /data
# (PERPSPAD_STATE_DIR); secrets come from the platform's variables, never from this image.

FROM node:22-bookworm-slim

# Python for lighter/sidecar.py: Lighter's signing ships only in its Python/Go SDKs.
# The SDK bundles the native signer (lighter-signer-linux-amd64.so). Versions pinned to the
# ones the keeper has run with since August 2026.
RUN apt-get update \
 && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates \
 && rm -rf /var/lib/apt/lists/* \
 && python3 -m venv /opt/lighter \
 && /opt/lighter/bin/pip install --no-cache-dir lighter-sdk==1.1.2 eth-account==0.13.7

WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY config.js keeper.js ./
COPY lib ./lib
COPY lighter/client.js lighter/sidecar.py lighter/requirements.txt ./lighter/

ENV NODE_ENV=production \
    PERPSPAD_LIGHTER_PYTHON=/opt/lighter/bin/python \
    PERPSPAD_STATE_DIR=/data

# fails the build if the SDK or its native signer cannot be loaded on this platform
RUN /opt/lighter/bin/python -c "import lighter; print('lighter-sdk ok')"

CMD ["node", "keeper.js"]
