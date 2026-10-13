#!/usr/bin/env bash
set -euo pipefail

project_root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
library_root="$project_root/third_party/browser-libs"
package_root="$library_root/packages"
rootfs="$library_root/rootfs"

mkdir -p "$package_root" "$rootfs"
(
  cd "$package_root"
  apt download libgbm1 libasound2 libwayland-server0
  for package_file in ./*.deb; do
    dpkg-deb -x "$package_file" "$rootfs"
  done
)

library_path="$rootfs/usr/lib/x86_64-linux-gnu"
echo "Project-local Chromium libraries are ready: $library_path"
LD_LIBRARY_PATH="$library_path" ldd "$project_root/node_modules/playwright-core/.local-browsers/chromium-1161/chrome-linux/chrome" | grep 'not found' || true
