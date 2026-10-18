#!/bin/bash
# Create the local self-signed code-signing identity Lux Didi is signed with.
#
# Why: an ad-hoc signature (`codesign --sign -`) has the designated requirement
# `cdhash H"..."`, and that hash changes on every build. macOS keys Naya's
# Accessibility grant to that requirement, so every install drops the grant
# (issue #382). A certificate-backed signature gives the requirement
# `identifier "ai.peat.lux-didi" and certificate leaf = H"..."`, which survives
# a reinstall, and the owner grants Accessibility once.
#
# Usage: scripts/create-signing-identity.sh [--dry-run] [--keychain PATH]
#   --dry-run        print the plan and change nothing
#   --keychain PATH  keychain to create the identity in (default: the user's
#                    default keychain, which is the login keychain)
#
# Environment:
#   LUX_DIDI_SIGNING_IDENTITY   certificate common name (default: Lux Didi Local Signing)
#   LUX_DIDI_SIGNING_STATE_DIR  directory holding the public certificate
#                               (default: "$HOME/Library/Application Support/LuxDidi/signing")
#
# It is idempotent, never prints key material, needs no network, and writes
# nothing inside the repository. Trusting the certificate asks for the login
# keychain password, so this script prints that one command instead of running
# it unattended.
set -euo pipefail
export CI=1
root="$(cd "$(dirname "$0")/.." && pwd)"
identity="${LUX_DIDI_SIGNING_IDENTITY:-Lux Didi Local Signing}"
keychain="$(security default-keychain -d user 2>/dev/null | tr -d '"[:space:]')"
state_dir="${LUX_DIDI_SIGNING_STATE_DIR:-$HOME/Library/Application Support/LuxDidi/signing}"
cert="$state_dir/lux-didi-local-signing.crt"
dry_run=no
while [ $# -gt 0 ]; do
  case "$1" in
    --dry-run) dry_run=yes; shift;;
    --keychain) keychain="${2:?--keychain needs a path}"; shift 2;;
    -h|--help) sed -n '2,25p' "$0"; exit 0;;
    *) echo "create-signing-identity.sh: unknown option $1" >&2; exit 2;;
  esac
done

[ -n "$keychain" ] || { echo "create-signing-identity.sh: the user's default keychain could not be resolved" >&2; exit 2; }

print_trust_step() {
  echo "create-signing-identity.sh: trust it once, then build and install:"
  printf '  security add-trusted-cert -r trustRoot -p codeSign -k "%s" "%s"\n' "$keychain" "$cert"
  echo "  (that command asks for your login keychain password; nothing else is needed)"
}

if [ -n "$(security find-certificate -c "$identity" -p "$keychain" 2>/dev/null)" ]; then
  echo "create-signing-identity.sh: identity '$identity' already exists in $keychain, nothing to do"
  print_trust_step
  exit 0
fi

if [ "$dry_run" = yes ]; then
  echo "create-signing-identity.sh: plan"
  echo "  identity:    '$identity', self-signed, valid 10 years"
  echo "  keychain:    $keychain"
  echo "  key usage:   keyUsage digitalSignature, extendedKeyUsage codeSigning"
  echo "  certificate: $cert (public certificate only, no key material)"
  echo "  network:     none; nothing is written inside $root"
  print_trust_step
  exit 0
fi

umask 077
work="$(mktemp -d "${TMPDIR:-/tmp}/lux-didi-signing.XXXXXX")"
cleanup() { status=$?; trap - EXIT INT TERM; rm -rf "$work"; exit "$status"; }
trap cleanup EXIT INT TERM

cat > "$work/openssl.cnf" <<EOF
[req]
distinguished_name = dn
x509_extensions = v3
prompt = no
[dn]
CN = $identity
O = Lux Didi Local
[v3]
basicConstraints = critical,CA:false
keyUsage = critical,digitalSignature
extendedKeyUsage = critical,codeSigning
subjectKeyIdentifier = hash
EOF

pass="$(openssl rand -hex 24)"
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 3650 -config "$work/openssl.cnf" \
  -keyout "$work/key.pem" -out "$work/cert.pem" >"$work/openssl.log" 2>&1 \
  || { echo "create-signing-identity.sh: openssl could not create the certificate:" >&2
       sed -n '1,3p' "$work/openssl.log" >&2; exit 1; }

# macOS reads the SHA1/3DES form of a PKCS#12; OpenSSL 3 and later need -legacy
# for it, while LibreSSL, the system openssl, writes it by default.
if openssl pkcs12 -export -help 2>&1 | grep -q -- '-legacy'; then
  openssl pkcs12 -export -out "$work/identity.p12" -inkey "$work/key.pem" -in "$work/cert.pem" \
    -name "$identity" -passout "pass:$pass" -legacy >/dev/null 2>&1 \
    || { echo "create-signing-identity.sh: openssl could not bundle the identity" >&2; exit 1; }
else
  openssl pkcs12 -export -out "$work/identity.p12" -inkey "$work/key.pem" -in "$work/cert.pem" \
    -name "$identity" -passout "pass:$pass" >/dev/null 2>&1 \
    || { echo "create-signing-identity.sh: openssl could not bundle the identity" >&2; exit 1; }
fi

# -T grants codesign the key without a prompt; the private key still never
# leaves the keychain and is never printed.
security import "$work/identity.p12" -k "$keychain" -P "$pass" \
  -T /usr/bin/codesign -T /usr/bin/security >/dev/null \
  || { echo "create-signing-identity.sh: security import into $keychain failed" >&2; exit 1; }

security find-identity -p codesigning "$keychain" 2>/dev/null | grep -qF "\"$identity\"" \
  || { echo "create-signing-identity.sh: the imported identity '$identity' is not listed in $keychain" >&2; exit 1; }

mkdir -p "$state_dir"
install -m 0644 "$work/cert.pem" "$cert"

echo "create-signing-identity.sh: created identity '$identity' in $keychain"
print_trust_step
