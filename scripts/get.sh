#!/bin/sh
# RackDeck bootstrap installer.
#
# Resolves the latest published release, verifies the installer checksum, and runs it.
# CasaOS is detected automatically; pass --role peer for a peer node.
set -eu

DEFAULT_REPOSITORY="Kaquely/RackDeck"
REPOSITORY="${HOMELABMD_REPOSITORY:-$DEFAULT_REPOSITORY}"
VERSION="${HOMELABMD_VERSION:-}"

log() { printf '%s\n' "$*" >&2; }
die() { log "homelabmd: $*"; exit 1; }

command -v curl >/dev/null 2>&1 || die "curl is required"
command -v mktemp >/dev/null 2>&1 || die "mktemp is required"
command -v bash >/dev/null 2>&1 || die "bash is required"

if [ -z "$VERSION" ]; then
  latest_url="$(curl -fsSL -o /dev/null -w '%{url_effective}' "https://github.com/${REPOSITORY}/releases/latest")" ||
    die "could not resolve the latest release; set HOMELABMD_VERSION"
  tag="${latest_url##*/}"
  case "$tag" in
    v[0-9]*) VERSION="${tag#v}" ;;
    *) die "unexpected release tag: ${tag}" ;;
  esac
fi

tmpdir="$(mktemp -d)"
trap 'rm -rf "$tmpdir"' EXIT HUP INT TERM

base="https://github.com/${REPOSITORY}/releases/download/v${VERSION}"
curl -fsSL "${base}/install.sh" -o "${tmpdir}/install.sh" ||
  die "could not download install.sh for ${VERSION}"
curl -fsSL "${base}/SHA256SUMS" -o "${tmpdir}/SHA256SUMS" ||
  die "could not download SHA256SUMS for ${VERSION}"

expected="$(awk '$2 == "install.sh" { print $1 }' "${tmpdir}/SHA256SUMS" | head -n 1)"
[ -n "$expected" ] || die "SHA256SUMS does not list install.sh"

if command -v sha256sum >/dev/null 2>&1; then
  actual="$(sha256sum "${tmpdir}/install.sh" | awk '{ print $1 }')"
elif command -v shasum >/dev/null 2>&1; then
  actual="$(shasum -a 256 "${tmpdir}/install.sh" | awk '{ print $1 }')"
else
  die "sha256sum or shasum is required"
fi
[ "$actual" = "$expected" ] || die "install.sh checksum does not match"

case "${1:-}" in
  install | update | rollback | status) ;;
  *) set -- install "$@" ;;
esac

if [ "$1" = "install" ] && [ -d /var/lib/casaos ]; then
  case " $* " in
    *" --casaos "* | *" --prefix "* | *" --image "* | *" --role peer "* | *" --help "* | *" -h "*) ;;
    *) set -- "$@" --casaos ;;
  esac
fi

bash "${tmpdir}/install.sh" "$@"
