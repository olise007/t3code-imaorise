#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."
output=${1:?output directory required}
expected=${2:?expected revision required}
[[ $(git rev-parse HEAD) == "$expected" && -z $(git status --porcelain) ]] || { echo 'Android requires the clean recorded revision.' >&2; exit 1; }
output=$(realpath -m "$output")
mkdir -p "$output"
[[ ! -f "$HOME/.config/vite-plus/env" ]] || source "$HOME/.config/vite-plus/env"
export JAVA_HOME=${JAVA_HOME:-/usr/lib/jvm/java-21-openjdk-amd64}
export ANDROID_HOME=${ANDROID_HOME:-$HOME/.local/share/t3code-imaorise/android-sdk}
export ANDROID_SDK_ROOT="$ANDROID_HOME"
export GRADLE_USER_HOME="$HOME/.cache/t3code-imaorise/gradle"
export PATH="$JAVA_HOME/bin:$ANDROID_HOME/platform-tools:$PATH"
export APP_VARIANT=production EXPO_NO_TELEMETRY=1 EXPO_NO_GIT_STATUS=1
export T3CODE_IMAORISE_MOBILE_CONNECT_ENABLED=0 T3CODE_MOBILE_UPDATES_ENABLED=0
export T3CODE_IMAORISE_ANDROID_VERSION_CODE=${T3CODE_IMAORISE_ANDROID_VERSION_CODE:?reserve a monotonic Android version code first}
export T3CODE_IMAORISE_VERSION=${T3CODE_IMAORISE_VERSION:?personal release version required}
[[ "$T3CODE_IMAORISE_ANDROID_VERSION_CODE" -gt 5215 ]]
[[ -x "$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" ]] || { echo 'Install the isolated Android command-line SDK first.' >&2; exit 1; }
vp install --frozen-lockfile
vp test run apps/mobile/imaoriseConfig.test.ts apps/mobile/src/lib/appLinking.test.ts apps/mobile/src/widgets/AgentActivity.test.ts apps/mobile/src/features/connection/pairing.test.ts
vp lint apps/mobile/app.config.ts apps/mobile/imaoriseConfig.test.ts apps/mobile/src/App.tsx apps/mobile/src/lib/appLinking.ts apps/mobile/src/lib/appLinking.test.ts apps/mobile/src/widgets/AgentActivity.tsx apps/mobile/src/widgets/AgentActivity.test.ts
vp run --filter @t3tools/mobile typecheck
cd apps/mobile
vp exec expo prebuild --platform android --clean --no-install
read -r ndk sdk buildTools < <(node -e 'const s=require("fs").readFileSync("node_modules/react-native/gradle/libs.versions.toml","utf8"); const value=k=>s.match(new RegExp(k+"\\s*=\\s*\"([^\"]+)\""))?.[1]; console.log(value("ndkVersion"),value("compileSdk"),value("buildTools"))')
[[ -n "$ndk" ]] || { echo 'Could not resolve generated Android NDK version.' >&2; exit 1; }
catalog=$("$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" --list)
platformPackage="platforms;android-$sdk"
if [[ "$catalog" != *"$platformPackage "* ]]; then
  platformPackage="platforms;android-$sdk.0"
fi
"$ANDROID_HOME/cmdline-tools/latest/bin/sdkmanager" "ndk;$ndk" 'cmake;3.22.1' "$platformPackage" "build-tools;$buildTools"
export ANDROID_NDK_HOME="$ANDROID_HOME/ndk/$ndk"
# Use the native library pinned in this revision. Rebuilding it in place would
# overwrite tracked upstream binaries and invalidate the clean-build guarantee.
[[ -s modules/t3-terminal/android/src/main/jniLibs/arm64-v8a/libghostty-vt.so ]] || { echo 'The committed ARM64 terminal library is missing.' >&2; exit 1; }
cd android
if ! ./gradlew --no-daemon --max-workers=2 assembleRelease -PreactNativeArchitectures=arm64-v8a > "$output/gradle.log" 2>&1; then
  tail -n 160 "$output/gradle.log" >&2
  exit 1
fi
cd ../../..
signing=${T3CODE_IMAORISE_SIGNING_DIRECTORY:-$HOME/.local/share/t3code-imaorise/signing}
mkdir -p "$signing"
chmod 700 "$signing"
[[ -f "$signing/android.keystore" && -f "$signing/password" ]] || { echo 'Existing personal signing key is required; never generate a replacement.' >&2; exit 1; }
apk="$output/T3-Code-Imaorise-${T3CODE_IMAORISE_VERSION}-${expected:0:12}-arm64-v8a.apk"
"$ANDROID_HOME/build-tools/$buildTools/zipalign" -f -p 4 apps/mobile/android/app/build/outputs/apk/release/app-release.apk "$output/aligned.apk"
"$ANDROID_HOME/build-tools/$buildTools/apksigner" sign --ks "$signing/android.keystore" --ks-key-alias imaorise --ks-pass "file:$signing/password" --out "$apk" "$output/aligned.apk"
rm "$output/aligned.apk"
"$ANDROID_HOME/build-tools/$buildTools/apksigner" verify --verbose --print-certs "$apk" > "$output/signature.txt"
"$ANDROID_HOME/build-tools/$buildTools/aapt" dump badging "$apk" > "$output/package.txt"
"$ANDROID_HOME/build-tools/$buildTools/aapt" dump xmltree "$apk" AndroidManifest.xml > "$output/native-manifest.txt"
rg -q "package: name='com.imaorise.t3code'" "$output/package.txt"
rg -q 't3code-imaorise' "$output/native-manifest.txt"
[[ -z $(git status --porcelain) ]] || { echo 'Android build modified tracked source.' >&2; exit 1; }
python3 - "$output/android-manifest.json" "$expected" "$T3CODE_IMAORISE_ANDROID_VERSION_CODE" "$ndk" "$sdk" "$buildTools" <<'PY'
import json, subprocess, sys
json.dump({"revision":sys.argv[2], "applicationId":"com.imaorise.t3code", "versionCode":int(sys.argv[3]), "architecture":"arm64-v8a", "nativeTerminalLibrary":"committed upstream library from the recorded revision", "tools":{"java":subprocess.check_output(['java','--version'],text=True).splitlines()[0],"ndk":sys.argv[4],"sdk":sys.argv[5],"buildTools":sys.argv[6]}, "checks":"focused tests, lint, mobile typecheck, APK signature and package inspection passed", "interactiveAcceptance":"device installation and update acceptance pending"},open(sys.argv[1],'w'),indent=2)
PY
