#!/usr/bin/env bash
# Rebuild the Excalidraw static bundle into ./build from the pinned upstream source.
#
# Reproduces the official excalidraw/excalidraw Docker image build
# (`yarn build:app:docker`) but with excalidraw.com endpoints disabled at build
# time so the app never talks to excalidraw's servers (no sharing/collab/AI/
# Firebase/Plus). Library stencils URLs are kept at the upstream defaults,
# matching the official image.
#
# A small patch (patch/excalidraw-app-r2-storage.patch) is applied on top of the
# pinned source to add the "Save to R2… / Open from R2…" main-menu feature backed
# by the worker's R2 API. Keep the patch in sync with upstream updates.
set -euo pipefail

EXCALIDRAW_COMMIT="701b901a0f1ba3d0b390d9cdf63d112e25abac4b"
SRC_DIR="${EXCALIDRAW_SRC:-/workspace/excalidraw}"
OUT_DIR="$(cd "$(dirname "$0")" && pwd)/build"
PATCH_DIR="$(cd "$(dirname "$0")" && pwd)/patch"
R2_STORAGE_PATCH="$PATCH_DIR/excalidraw-app-r2-storage.patch"

if [ ! -d "$SRC_DIR/.git" ]; then
  echo "Cloning excalidraw at $EXCALIDRAW_COMMIT ..."
  git clone --depth 1 https://github.com/excalidraw/excalidraw.git "$SRC_DIR"
fi

cd "$SRC_DIR"
CURRENT="$(git rev-parse HEAD)"
if [ "$CURRENT" != "$EXCALIDRAW_COMMIT" ]; then
  echo "Updating excalidraw to pinned commit $EXCALIDRAW_COMMIT (was $CURRENT)..."
  git fetch --depth 1 origin "$EXCALIDRAW_COMMIT"
  git checkout "$EXCALIDRAW_COMMIT"
fi

echo "Applying R2 storage patch ..."
if ! git apply --check "$R2_STORAGE_PATCH"; then
  if git apply --reverse --check "$R2_STORAGE_PATCH"; then
    echo "Patch already applied; skipping."
  else
    echo "ERROR: R2 storage patch does not apply cleanly." >&2
    exit 1
  fi
else
  git apply "$R2_STORAGE_PATCH"
fi

echo "Installing dependencies ..."
yarn --frozen-lockfile --network-timeout 600000

echo "Building static bundle ..."
cd excalidraw-app
VITE_APP_BACKEND_V2_GET_URL="" \
VITE_APP_BACKEND_V2_POST_URL="" \
VITE_APP_WS_SERVER_URL="" \
VITE_APP_FIREBASE_CONFIG='{}' \
VITE_APP_AI_BACKEND="" \
VITE_APP_PLUS_LP="" \
VITE_APP_PLUS_APP="" \
VITE_APP_ENABLE_TRACKING=false \
VITE_APP_DISABLE_SENTRY=true \
  yarn build:app:docker

echo "Copying bundle to $OUT_DIR ..."
rm -rf "$OUT_DIR"
cp -r build "$OUT_DIR"
echo "Done. Bundle size: $(du -sh "$OUT_DIR" | cut -f1)"