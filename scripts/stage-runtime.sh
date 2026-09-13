#!/usr/bin/env bash
# Stage the Android runtime bundle: a minimal Ubuntu arm64 rootfs containing
# Node 24, official dsh 0.1.5-rc.2 and the five SSH-only packages, packaged
# as the single asset the app extracts on first run.
#
# Runs on the x86_64 build server. arm64 binaries are never executed except
# through qemu-user when verifying, so no cross toolchain is needed.
#
# Usage:  scripts/stage-runtime.sh [--skip-downloads]
# Output: app/src/main/assets/dsh-runtime.tar.gz   (the runtime bundle)
#         app/src/main/jniLibs/arm64-v8a/libproot.so + libtalloc.so (Android loader side)
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
DSH_SSH_DIR="${DSH_SSH_DIR:-$ROOT_DIR/../dsh-ssh}"
STAGE="$ROOT_DIR/.stage-runtime"
# Deliberately NOT overridable from the environment: a stray NODE_VERSION in
# the shell once silently swapped the runtime to a non-LTS Node.
UBUNTU_VERSION="24.04.4"
NODE_VERSION="24.4.1"
DSH_VERSION="0.1.5-rc.2"

UBUNTU_BASE_URL="https://cdimage.ubuntu.com/ubuntu-base/releases/${UBUNTU_VERSION}/release/ubuntu-base-${UBUNTU_VERSION}-base-arm64.tar.gz"
NODE_URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-linux-arm64.tar.xz"
TERMUX_PACKAGES_INDEX="https://packages.termux.dev/apt/termux-main/dists/stable/main/binary-aarch64/Packages"

log() { printf '\033[1;32m[stage]\033[0m %s\n' "$*"; }

download() { # download <url> <dest>
  local url="$1" dest="$2"
  if [[ -s "$dest" ]]; then
    log "cached: $(basename "$dest")"
  else
    log "downloading: $(basename "$dest")"
    curl -fL --retry 3 -o "$dest" "$url"
  fi
}

mkdir -p "$STAGE/downloads"

if [[ "${1:-}" != "--skip-downloads" ]]; then
  # 1. Ubuntu base rootfs (arm64, ~30 MB).
  download "$UBUNTU_BASE_URL" "$STAGE/downloads/ubuntu-base.tar.gz"

  # 2. Official Node.js arm64 build.
  download "$NODE_URL" "$STAGE/downloads/node.tar.xz"

  # 3. proot + its two Android/bionic libraries from Termux.
  if [[ ! -f "$STAGE/downloads/proot.deb" || ! -f "$STAGE/downloads/libtalloc.deb" || ! -f "$STAGE/downloads/libandroid-shmem.deb" ]]; then
    log "fetching Termux package index"
    curl -fsSL "$TERMUX_PACKAGES_INDEX" -o "$STAGE/downloads/Packages"
    proot_rel="$(awk '/^Package: proot$/{f=1;next} f&&/^Filename:/{print $2;exit}' "$STAGE/downloads/Packages")"
    talloc_rel="$(awk '/^Package: libtalloc$/{f=1;next} f&&/^Filename:/{print $2;exit}' "$STAGE/downloads/Packages")"
    shmem_rel="$(awk '/^Package: libandroid-shmem$/{f=1;next} f&&/^Filename:/{print $2;exit}' "$STAGE/downloads/Packages")"
    [[ -n "$proot_rel" && -n "$talloc_rel" && -n "$shmem_rel" ]] \
      || { echo "Termux proot dependencies missing from index" >&2; exit 1; }
    download "https://packages.termux.dev/apt/termux-main/$proot_rel" "$STAGE/downloads/proot.deb"
    download "https://packages.termux.dev/apt/termux-main/$talloc_rel" "$STAGE/downloads/libtalloc.deb"
    download "https://packages.termux.dev/apt/termux-main/$shmem_rel" "$STAGE/downloads/libandroid-shmem.deb"
  fi
fi

# 4. Assemble the rootfs.
ROOTFS="$STAGE/rootfs"
rm -rf "$ROOTFS"
mkdir -p "$ROOTFS"
log "unpacking Ubuntu base"
tar -xzf "$STAGE/downloads/ubuntu-base.tar.gz" -C "$ROOTFS"

log "installing Node ${NODE_VERSION}"
mkdir -p "$STAGE/node"
tar -xJf "$STAGE/downloads/node.tar.xz" -C "$STAGE/node" --strip-components=1
cp -a "$STAGE/node/bin/node" "$ROOTFS/usr/bin/node"
# node needs its shared libraries and the npm payload.
cp -a "$STAGE/node/lib/node_modules" "$ROOTFS/usr/lib/node_modules"
cp -a "$STAGE/node/lib/"lib*.so* "$ROOTFS/usr/lib/" 2>/dev/null || true
ln -sf /usr/lib/node_modules/npm/bin/npm-cli.js "$ROOTFS/usr/bin/npm"

# Minimal runtime environment inside the container.
mkdir -p "$ROOTFS/opt/dsh" "$ROOTFS/root" "$ROOTFS/tmp" "$ROOTFS/data"
printf 'APT::Get::Install-Recommends "false";\n' > "$ROOTFS/etc/apt/apt.conf.d/99no-recommends"

# 5. Install official dsh plus the five SSH packages, pinned.
#    npm runs on the host; JS payloads are arch-independent and the optional
#    native addons resolve to their arm64 variants via the platform flags.
log "installing @deepseek-ai/dsh@${DSH_VERSION} + SSH packages (host npm, arm64 platform flags)"
cat > "$ROOTFS/opt/dsh/package.json" <<'JSON'
{
  "name": "dsh-runtime",
  "private": true,
  "version": "1.0.0",
  "dependencies": {
    "@deepseek-ai/dsh": "0.1.5-rc.2",
    "@local/dsh-ssh-runtime": "file:./ssh/ssh-runtime",
    "@local/dsh-fs-ssh": "file:./ssh/fs-ssh",
    "@local/dsh-subprocess-ssh": "file:./ssh/subprocess-ssh",
    "@local/dsh-ssh-integration": "file:./ssh/ssh-integration",
    "@local/dsh-ssh-bundle": "file:./ssh/ssh-bundle"
  }
}
JSON

mkdir -p "$ROOTFS/opt/dsh/ssh"
for pkg in ssh-runtime fs-ssh subprocess-ssh ssh-integration ssh-bundle; do
  src="$DSH_SSH_DIR/packages/$pkg"
  [[ -d "$src" ]] || { echo "missing SSH package: $src" >&2; exit 1; }
  # Ship sources and built output, never dev dependencies or test scratch.
  # (cp, not rsync: the build host has no rsync.)
  cp -a "$src" "$ROOTFS/opt/dsh/ssh/$pkg"
  rm -rf "$ROOTFS/opt/dsh/ssh/$pkg/node_modules" "$ROOTFS/opt/dsh/ssh/$pkg/tests"
  find "$ROOTFS/opt/dsh/ssh/$pkg" -name '*.spec.ts' -type f -delete
done

# The host environment exports NPM_CONFIG_GLOBAL=true and NPM_CONFIG_PREFIX
# (its "npm install" is a global install by default) — neutralize both or
# every dependency lands outside the rootfs.
( cd "$ROOTFS/opt/dsh" && env -u NPM_CONFIG_GLOBAL -u NPM_CONFIG_PREFIX \
    npm install --omit=dev --ignore-scripts --no-audit --no-fund \
    --os=linux --cpu=arm64 --libc=glibc )

log "smoke: official dsh version through the real arm64 Node"
QEMU_LD_PREFIX="$ROOTFS" qemu-aarch64-static \
    "$ROOTFS/usr/bin/node" \
    "$ROOTFS/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" --version

# 6. The SSH-only overlay the boot command applies over the web profile.
#    Lives at /opt/dsh (NOT /data): the Android service bind-mounts the app's
#    private data dir over the container's /data, which would shadow it.
log "writing ssh-only patch overlay"
cp "$DSH_SSH_DIR/packages/ssh-bundle/cordis.patch.yml" "$ROOTFS/opt/dsh/ssh-only.yml"
# Preseed the web profile with the five private packages. dsh later heals its
# official dependency fallback around this profile; no network/install occurs
# on the phone.
DSH_HOME="$ROOTFS/data" node \
    "$ROOTFS/opt/dsh/node_modules/@deepseek-ai/dsh/lib/bin.js" \
    web --dump-config >/dev/null
(
  cd "$ROOTFS/data/profiles/web"
  env -u NPM_CONFIG_GLOBAL -u NPM_CONFIG_PREFIX npm install \
    --omit=dev --ignore-scripts --no-audit --no-fund --save \
    file:../../../opt/dsh/ssh/ssh-runtime \
    file:../../../opt/dsh/ssh/fs-ssh \
    file:../../../opt/dsh/ssh/subprocess-ssh \
    file:../../../opt/dsh/ssh/ssh-integration \
    file:../../../opt/dsh/ssh/ssh-bundle
)

# 7. Android-side loader pieces: proot as jniLibs so the package manager
#    extracts it with exec permission into nativeLibraryDir.
log "extracting proot for Android"
mkdir -p "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a"

# Prefer the vendored proot set. The Termux package currently ships a loader
# stripped of its .rodata segment (18 KB, two LOAD segments), and proot uses
# that loader to exec every binary inside the container: with the truncated
# one the traced child dies with SIGKILL ("proot info: vpid 1: terminated
# with signal 9"). The vendored copy is the set that was verified working on
# a real device, so it is the default and the Termux download is the fallback.
VENDOR="$ROOT_DIR/vendor/proot-arm64"
if [[ -x "$VENDOR/proot" && -s "$VENDOR/loader" ]]; then
  log "using vendored proot (verified on device)"
  cp "$VENDOR/proot" "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/libproot.so"
  cp "$VENDOR/loader" "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/libprootloader.so"
  cp "$VENDOR/loader32" "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/libprootloader32.so"
  cp "$VENDOR/libtalloc.so" "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/libtalloc.so"
  cp "$VENDOR/libandroid-shmem.so" "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/libandroid-shmem.so"
else
  log "vendored proot missing; falling back to the Termux packages"
  rm -rf "$STAGE/proot-deb" "$STAGE/talloc-deb" "$STAGE/shmem-deb"
  mkdir -p "$STAGE/proot-deb" "$STAGE/talloc-deb" "$STAGE/shmem-deb"
  dpkg -x "$STAGE/downloads/proot.deb" "$STAGE/proot-deb"
  dpkg -x "$STAGE/downloads/libtalloc.deb" "$STAGE/talloc-deb"
  dpkg -x "$STAGE/downloads/libandroid-shmem.deb" "$STAGE/shmem-deb"
  find "$STAGE/proot-deb" -name 'proot' -exec cp {} "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/libproot.so" \;
  find "$STAGE/proot-deb" -path '*/libexec/proot/loader' -exec cp {} "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/libprootloader.so" \;
  find "$STAGE/proot-deb" -path '*/libexec/proot/loader32' -exec cp {} "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/libprootloader32.so" \;
  find "$STAGE/talloc-deb" -type f -name 'libtalloc.so*' -exec cp {} "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/libtalloc.so" \;
  find "$STAGE/shmem-deb" -type f -name 'libandroid-shmem.so*' -exec cp {} "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/libandroid-shmem.so" \;
fi
for required in libproot.so libprootloader.so libtalloc.so libandroid-shmem.so; do
  test -s "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/$required" \
    || { echo "missing Android loader library: $required" >&2; exit 1; }
done
ls -la "$ROOT_DIR/app/src/main/jniLibs/arm64-v8a/"

# 8. Pack the runtime bundle as the single first-run asset.
log "packing dsh-runtime.bin"
ASSET_DIR="$ROOT_DIR/app/src/main/assets"
mkdir -p "$ASSET_DIR"
# Deterministic-ish and reproducible-ish: fixed owner, sorted entries.
# GNU format pins the LongLink dialect the app's tar reader implements.
# '.bin', not '.tar.gz': AAPT2 would otherwise gunzip the asset during merge.
tar -czf "$ASSET_DIR/dsh-runtime.bin" --format=gnu \
    --owner=0 --group=0 --numeric-owner -C "$STAGE" "rootfs"
ls -la "$ASSET_DIR/dsh-runtime.bin"
log "done"
