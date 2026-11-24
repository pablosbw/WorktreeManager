#!/bin/sh
# Builds the embedded editor's code-server for Windows x64, which coder does not publish, from
# its npm package: the package ships the prebuilt editor and compiles its native modules on
# install, so this needs Visual Studio Build Tools with MSVC v143, a Windows 11 SDK and the
# Spectre-mitigated libraries (Microsoft.VisualStudio.Component.VC.Runtimes.x86.x64.Spectre),
# Python and Git Bash. The result has the
# layout of coder's macOS and Linux releases, with the official Node.js as lib/node.exe.
#
# Usage: build-code-server-windows.sh <code-server version> <Node.js version> <output dir>
set -eu

version="${1:?Pass the code-server version, e.g. 4.136.2}"
node_version="${2:?Pass the Node.js version code-server requires, e.g. 24.22.3}"
output="${3:?Pass the output directory}"
name="code-server-$version-win32-x64"
node_name="node-v$node_version-win-x64"
# Windows' bsdtar reads zip archives and writes the tar.gz the app extracts with the same tool.
bsdtar="${BSDTAR:-$SYSTEMROOT/System32/tar.exe}"

work="${CODE_SERVER_BUILD_DIR:-$(mktemp -d)}"
[ -n "${CODE_SERVER_BUILD_DIR:-}" ] || trap 'rm -rf "$work"' EXIT

echo "Downloading Node.js $node_version…" >&2
curl -fsSL -o "$work/$node_name.zip" "https://nodejs.org/dist/v$node_version/$node_name.zip"
curl -fsSL -o "$work/SHASUMS256.txt" "https://nodejs.org/dist/v$node_version/SHASUMS256.txt"
expected="$(grep " $node_name.zip\$" "$work/SHASUMS256.txt" | cut -d ' ' -f 1)"
actual="$(sha256sum "$work/$node_name.zip" | cut -d ' ' -f 1)"
if [ -z "$expected" ] || [ "$expected" != "$actual" ]; then
  echo "The Node.js download does not match its published SHA-256." >&2
  exit 1
fi
"$bsdtar" -xf "$work/$node_name.zip" -C "$work"

echo "Installing code-server $version and compiling its native modules…" >&2
PATH="$work/$node_name:$PATH" npm install --global --no-audit --no-fund \
  --prefix "$work/p" --cache "$work/c" "code-server@$version"

release="$work/$name"
mv "$work/p/node_modules/code-server" "$release"
cp "$work/$node_name/node.exe" "$release/lib/node.exe"

# The postinstall links the terminal's helper scripts with directory junctions, which cannot
# point at files: remote-cli/code-server.cmd breaks and helpers/browser.cmd becomes a link to
# itself, losing the script. Ship real copies, taken from the package npm verified, and run them
# with lib/node.exe like their .sh siblings (the .cmd versions expect node.exe at the root).
bin="$release/lib/vscode/bin"
for link in remote-cli/code-server.cmd helpers/browser.cmd; do
  cmd //c rmdir "$(cygpath -w "$bin/$link")"
done
PATH="$work/$node_name:$PATH" npm pack --silent --cache "$work/c" --pack-destination "$work" \
  "code-server@$version" >/dev/null
"$bsdtar" -xzf "$work/code-server-$version.tgz" -C "$work" package/lib/vscode/bin/helpers/browser.cmd
cp "$work/package/lib/vscode/bin/helpers/browser.cmd" "$bin/helpers/browser.cmd"
cp "$bin/remote-cli/code.cmd" "$bin/remote-cli/code-server.cmd"
# From a file: Git Bash's quoting of native command lines drops backslashes from `node -e`.
cat >"$work/launchers.js" <<'EOF'
const fs = require("node:fs");
const from = String.raw`"%ROOT_DIR%\node.exe"`;
const to = String.raw`"%ROOT_DIR%\lib\node.exe"`;
for (const file of process.argv.slice(2)) {
  const script = fs.readFileSync(file, "utf8");
  if (script.split(from).length !== 2) throw new Error(`Unexpected launcher in ${file}`);
  fs.writeFileSync(file, script.replace(from, to));
}
EOF
"$release/lib/node.exe" "$work/launchers.js" \
  "$bin/remote-cli/code.cmd" "$bin/remote-cli/code-server.cmd" "$bin/helpers/browser.cmd"

# node-gyp leaves project and object files beside each addon (~165 MB), with paths long enough
# to pass Windows' 260-character limit under the app's data folder. Only the addons load.
find "$release" -path '*/build/config.gypi' | while read -r gypi; do
  dir="$(dirname "$gypi")"
  find "$dir" -type f ! \( -path "$dir/Release/*" \
    \( -name '*.node' -o -name '*.dll' -o -name '*.exe' \) \) -delete
  find "$dir" -depth -type d -empty -delete
done

echo "Checking that the editor starts…" >&2
"$release/lib/node.exe" "$release/out/node/entry.js" --version

mkdir -p "$output"
"$bsdtar" -czf "$output/$name.tar.gz" -C "$work" "$name"
sha256sum "$output/$name.tar.gz" | cut -d ' ' -f 1 >"$output/$name.tar.gz.sha256"
echo "Built $output/$name.tar.gz (SHA-256 $(cat "$output/$name.tar.gz.sha256"))" >&2
