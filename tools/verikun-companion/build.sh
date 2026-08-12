#!/usr/bin/env bash
# Build the on-device companion into ./prebuilt/verikun-companion.jar.
#
# Deliberately javac + d8 rather than Gradle: the whole app is one source file
# with no dependencies beyond the platform, and a Gradle wrapper would add a build
# system (and a multi-hundred-megabyte cache) to a repo whose entire build is `tsc`.
#
# The output is COMMITTED, because `npm install verikun` must not require an Android
# SDK. Rebuild and commit it whenever the Java changes — nothing else will tell you,
# because a reviewer cannot see drift in a binary.
#
# Requires: an Android SDK (platform android-30+ for android.jar, build-tools for d8)
# and a JDK. Point ANDROID_HOME at the SDK if it is not in the usual place.
set -euo pipefail

here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
out_jar="$here/prebuilt/verikun-companion.jar"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT

sdk="${ANDROID_HOME:-${ANDROID_SDK_ROOT:-$HOME/Library/Android/sdk}}"
[ -d "$sdk" ] || { echo "Android SDK not found at $sdk — set ANDROID_HOME" >&2; exit 1; }

# Newest available platform + build-tools. The app only touches long-stable APIs,
# so the exact versions do not matter; taking the newest avoids pinning to something the
# developer has not installed.
android_jar="$(ls -d "$sdk"/platforms/android-*/android.jar 2>/dev/null | sort -V | tail -1)"
d8="$(ls -d "$sdk"/build-tools/*/d8 2>/dev/null | sort -V | tail -1)"
[ -n "$android_jar" ] || { echo "no android.jar under $sdk/platforms" >&2; exit 1; }
[ -n "$d8" ] || { echo "no d8 under $sdk/build-tools" >&2; exit 1; }

echo "android.jar: $android_jar"
echo "d8:          $d8"

# android.jar on the CLASSPATH (for android.*) with --release 11 pinning java.* to a
# language level Android certainly has. A current JDK no longer accepts -bootclasspath,
# so android.jar cannot be the boot classpath any more; the safety net is that d8 below
# re-resolves everything against android.jar and fails on anything Android lacks.
javac --release 11 -nowarn -classpath "$android_jar" \
  -d "$work/classes" "$here/src/dev/verikun/companion/CompanionApp.java"

# minSdkVersion 24: FLAG-era UiAutomation behaviour and LocalServerSocket are far older,
# but 24 matches what verikun supports elsewhere and keeps d8's desugaring honest.
"$d8" --min-api 24 --lib "$android_jar" --output "$work" "$work"/classes/dev/verikun/companion/*.class

# app_process wants a jar containing classes.dex (an APK works too — same container).
mkdir -p "$(dirname "$out_jar")"
(cd "$work" && zip -q -X "$out_jar.tmp" classes.dex)
mv "$out_jar.tmp" "$out_jar"

echo "built $out_jar ($(wc -c < "$out_jar" | tr -d ' ') bytes)"
