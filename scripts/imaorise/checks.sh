#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
source "$HOME/.config/vite-plus/env"
export PATH="$HOME/.cargo/bin:$PATH"
vp install --frozen-lockfile
vp test run \
  apps/web/src/browser/previewRuntime.test.ts \
  apps/web/src/browser/HostedBrowserWebview.test.tsx \
  apps/desktop/src/app/DesktopEnvironment.test.ts \
  apps/desktop/src/app/DesktopEarlyElectronStartup.test.ts \
  apps/desktop/src/app/DesktopUserData.test.ts \
  apps/desktop/src/app/DesktopClerk.test.ts \
  apps/desktop/src/wsl/DesktopWslEnvironment.test.ts \
  apps/desktop/src/electron/ElectronProtocol.test.ts \
  apps/server/src/cloud/imaoriseUpdates.test.ts \
  packages/ssh/src/imaoriseRuntime.test.ts \
  packages/shared/src/codexAuthHandoff.test.ts \
  packages/shared/src/providerAuthReturnUrl.test.ts
vp test run scripts/build-desktop-artifact.test.ts -t 'product name|desktop build|platform build|build config|omits official update feeds'
mapfile -t changed < <(git diff --name-only upstream/main HEAD -- '*.ts' '*.tsx')
vp lint "${changed[@]}"
for package in @t3tools/web @t3tools/desktop t3 @t3tools/shared @t3tools/scripts @t3tools/ssh; do
  vp run --filter "$package" typecheck
done
