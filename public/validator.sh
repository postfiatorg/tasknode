#!/bin/sh
# Connect an existing validator to Task Node. No key creation or key upload.
# Inspect: https://github.com/postfiatorg/tasknode/blob/main/public/validator.sh
set -eu
set +x
fail() { printf '%s\n' "Validator connect: $*" >&2; exit 1; }
token=${1:-}
[ "$token" != '--help' ] || { printf '%s\n' 'Usage: sh validator.sh <token> [--keyfile /existing/validator-keys.json]'; exit 0; }
[ "$#" -gt 0 ] || fail 'Copy a fresh command from Task Node Settings > Validator.'
shift
case "$token" in vct_*) ;; *) fail 'Invalid connect token. Copy a fresh command.' ;; esac
[ "${#token}" -eq 68 ] || fail 'Invalid connect token.'
case "${token#vct_}" in *[!0-9a-f]*) fail 'Invalid connect token.' ;; esac
keyfile=
if [ "$#" -gt 0 ]; then
  [ "$#" -eq 2 ] && [ "$1" = '--keyfile' ] || fail 'Usage: sh validator.sh <token> [--keyfile /existing/validator-keys.json]'
  keyfile=$2
fi
command -v curl >/dev/null 2>&1 || fail 'curl is required.'
command -v docker >/dev/null 2>&1 || fail 'Docker is required to use the existing postfiatd image.'
command -v awk >/dev/null 2>&1 || fail 'awk is required.'
[ "$(docker inspect --format '{{.State.Running}}' postfiatd 2>/dev/null)" = true ] || fail 'Cannot access running postfiatd. Run as a user with Docker access on the validator host.'
image=$(docker inspect --format '{{.Image}}' postfiatd)
location=host
if [ -z "$keyfile" ]; then
  if docker exec postfiatd test -r /root/.ripple/validator-keys.json 2>/dev/null; then
    keyfile=/root/.ripple/validator-keys.json
    location=container
  else
    for candidate in /root/validator-keys/validator-keys.json "${HOME:-/root}/.ripple/validator-keys.json" /etc/postfiatd/validator-keys.json /etc/postfiatd/validator-keys/validator-keys.json; do
      if [ -f "$candidate" ] && [ -r "$candidate" ]; then keyfile=$candidate; break; fi
    done
  fi
elif [ ! -r "$keyfile" ] && docker exec postfiatd test -r "$keyfile" 2>/dev/null; then
  location=container
fi
[ -n "$keyfile" ] || fail 'Key not found. Run again with --keyfile /existing/path/validator-keys.json.'
if [ "$location" = host ]; then
  [ -f "$keyfile" ] && [ -r "$keyfile" ] || fail 'Cannot read the specified host key file.'
  case "$keyfile" in /*) ;; *) keyfile="$(pwd)/$keyfile" ;; esac
  case "$keyfile" in *:*) fail 'Key file path cannot contain a colon.' ;; esac
fi

# Select only a single quoted field. The key file itself never leaves its host
# or enters a shell variable. validator-keys files use a literal public_key.
field_program='{for(i=2;i<=NF;i+=2) if($i==name){value=$(i+2); count++}} END{if(count==1) print value; else exit 1}'
json_field() { awk -F '"' -v name="$1" "$field_program"; }
if [ "$location" = container ]; then
  public_key=$(docker exec postfiatd awk -F '"' -v name=public_key "$field_program" "$keyfile" 2>/dev/null) || fail 'Could not read the public_key field.'
else
  public_key=$(awk -F '"' -v name=public_key "$field_program" "$keyfile" 2>/dev/null) || fail 'Could not read the public_key field.'
fi
case "$public_key" in nH*) ;; *) fail 'The file must contain a validator master public_key (nH...).';; esac
case "$public_key" in *[!123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]*) fail 'Invalid public key.' ;; esac
[ "${#public_key}" -ge 40 ] && [ "${#public_key}" -le 60 ] || fail 'Invalid public key length.'

# Fixed HTTPS origin; no credentials in URLs, redirects or shell history beyond
# the 30-minute connect token supplied by the operator.
base=https://tasknode.postfiat.org
post() {
  curl --silent --show-error --proto '=https' --connect-timeout 15 --max-time 45 \
    -H 'Content-Type: application/json' --data-binary @- "$base/api/validators/connect/$1"
}
challenge_reply=$(printf '{"token":"%s"}' "$token" | post challenge) || fail 'Challenge request failed. Check network access and try a fresh command.'
challenge=$(printf '%s' "$challenge_reply" | json_field challenge) || fail 'Token expired, already used, or unavailable. Copy a fresh command from Settings.'
case "$challenge" in pf-tasknode:*) ;; *) fail 'Unexpected signing challenge.' ;; esac
case "$challenge" in *[!a-zA-Z0-9:_-]*) fail 'Unexpected signing challenge characters.' ;; esac
if [ "$location" = container ]; then
  signature=$(docker exec postfiatd validator-keys --keyfile "$keyfile" sign "$challenge" 2>/dev/null) || fail 'Signing failed. Check the key file and Docker permissions.'
else
  signature=$(docker run --rm --network none -v "$keyfile:/keys/validator-keys.json:ro" \
    --entrypoint /usr/local/bin/validator-keys "$image" --keyfile /keys/validator-keys.json sign "$challenge" 2>/dev/null) || fail 'Signing failed with the existing postfiatd image.'
fi
case "$signature" in *[!0-9a-fA-F]*|'') fail 'Signing returned an invalid signature; no proof was sent.' ;; esac
[ "${#signature}" -ge 128 ] && [ "${#signature}" -le 144 ] || fail 'Signing returned an invalid signature length.'
reply=$(printf '{"token":"%s","master_public_key":"%s","signature":"%s"}' "$token" "$public_key" "$signature" | post complete) || fail 'Connection request failed. Check Settings before retrying.'
if message=$(printf '%s' "$reply" | json_field message); then
  printf '%s\n' "$message"
else
  error=$(printf '%s' "$reply" | json_field error) || error=connection_failed
  fail "$error. Check Settings or create a fresh command."
fi
