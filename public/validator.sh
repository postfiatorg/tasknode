#!/bin/sh
# Connect using the running validator token. Master files require --keyfile.
# Inspect: https://github.com/postfiatorg/tasknode/blob/main/public/validator.sh
set +x
set -eu
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
  [ -n "$keyfile" ] || fail 'Specify an existing master key file.'
fi
for tool in curl docker awk stat; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required."; done
[ "$(docker inspect --format '{{.State.Running}}' postfiatd 2>/dev/null)" = true ] || fail 'Cannot access running postfiatd. Run as a user with Docker access on the validator host.'
image=$(docker inspect --format '{{.Image}}' postfiatd)
field_program='{for(i=2;i<=NF;i+=2) if($i==name){value=$(i+2); count++}} END{if(count==1) print value; else exit 1}'
json_field() { awk -F '"' -v name="$1" "$field_program"; }
# This only queries public RPC output and config-path metadata. The validator
# token is read later, inside the offline signer, never in a shell variable.
if [ -z "$keyfile" ]; then
  config=$(docker inspect --format '{{range .Args}}{{println .}}{{end}}' postfiatd | awk 'pending {print;exit} $0=="--conf" || $0=="-c" {pending=1} index($0,"--conf=")==1 {print substr($0,8);exit}')
  if [ -z "$config" ]; then
    for candidate in /etc/postfiatd/postfiatd.cfg /etc/opt/postfiat/postfiatd.cfg /etc/opt/ripple/rippled.cfg; do
      if docker exec postfiatd test -r "$candidate" 2>/dev/null; then config=$candidate; break; fi
    done
  fi
  [ -n "$config" ] || fail 'Cannot locate the running postfiatd config. Start the node with --conf pointing to its mounted config.'
  public_key=$(docker exec postfiatd postfiatd --conf "$config" server_info 2>/dev/null | json_field pubkey_validator) || fail 'This node is not configured as a validator, or its local server_info RPC is unavailable.'
  input=$config
  location=container
else
  input=$keyfile
  location=container
  if [ -f "$keyfile" ] && [ -r "$keyfile" ]; then
    location=host
    case "$input" in /*) ;; *) input="$(pwd)/$input" ;; esac
    case "$input" in *:*) fail 'Key file path cannot contain a colon.' ;; esac
    public_key=$(awk -F '"' -v name=public_key "$field_program" "$input") || fail 'Cannot read the public_key field.'
  else
    public_key=$(docker exec postfiatd awk -F '"' -v name=public_key "$field_program" "$input" 2>/dev/null) || fail 'Cannot read the specified master key file.'
  fi
fi
case "$public_key" in nH*) ;; *) fail 'This node is not configured as a validator (no master pubkey_validator).';; esac
case "$public_key" in *[!123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]*) fail 'Invalid public key.' ;; esac
[ "${#public_key}" -ge 40 ] && [ "${#public_key}" -le 60 ] || fail 'Invalid public key length.'
if [ "$location" = host ]; then
  sign_user=$(stat -c '%u:%g' "$input") || fail 'Cannot inspect input file permissions.'
else
  sign_user=$(docker exec postfiatd stat -c '%u:%g' "$input" 2>/dev/null) || fail 'Cannot inspect the mounted config or explicit key file.'
fi
# No network, writes, container logs, core dumps or added capabilities in signer.
# Only existing volumes are exposed read-only; the helper opens only input.
offline() {
  entrypoint=$1
  shift
  if [ "$location" = host ]; then
    docker run --rm -i --user "$sign_user" --network none --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges --ulimit core=0 \
      -v "$input:/run/tasknode-input:ro" --entrypoint "$entrypoint" "$image" "$@"
  else
    docker run --rm -i --user "$sign_user" --network none --read-only --log-driver none --cap-drop ALL --security-opt no-new-privileges --ulimit core=0 \
      --volumes-from postfiatd:ro --entrypoint "$entrypoint" "$image" "$@"
  fi
}
# Fixed HTTPS origin. No redirects and no credentials in URLs.
base=https://tasknode.postfiat.org
post() {
  curl --silent --show-error --proto '=https' --connect-timeout 15 --max-time 45 \
    -H 'Content-Type: application/json' --data-binary @- "$base/api/validators/connect/$1"
}
challenge_reply=$(printf '{"token":"%s"}' "$token" | post challenge) || fail 'Challenge request failed. Check network access and try a fresh command.'
challenge=$(printf '%s' "$challenge_reply" | json_field challenge) || fail 'Token expired, already used, or unavailable. Copy a fresh command from Settings.'
case "$challenge" in pf-tasknode:*) ;; *) fail 'Unexpected signing challenge.' ;; esac
case "$challenge" in *[!a-zA-Z0-9:_-]*) fail 'Unexpected signing challenge characters.' ;; esac
if [ -n "$keyfile" ]; then
  sign_input=$input
  [ "$location" != host ] || sign_input=/run/tasknode-input
  signature=$(offline /usr/local/bin/validator-keys --keyfile "$sign_input" sign "$challenge" </dev/null 2>/dev/null) || fail 'Master signing failed. The explicit key file must be available in the image or a mounted volume.'
  case "$signature" in *[!0-9a-fA-F]*|'') fail 'Signing returned an invalid signature; no proof was sent.' ;; esac
  [ "${#signature}" -ge 128 ] && [ "${#signature}" -le 144 ] || fail 'Invalid signature length.'
  proof=$(printf '{"master_public_key":"%s","signature":"%s"}' "$public_key" "$signature")
else
  # Python stdlib and OpenSSL from the running image. Secret bytes travel only
  # through memory and anonymous pipes inside this network-disabled container.
  proof=$(offline python3 - "$input" "$public_key" "$challenge" <<'PY'
import base64, hashlib, json, os, resource, subprocess, sys
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))

def error(message):
    # Fixed messages only: exceptions may contain private input.
    print("Validator connect: " + message, file=sys.stderr)
    sys.exit(1)

def openssl(args, data, pass_fds=()):
    return subprocess.run(["openssl", *args], input=data, stdout=subprocess.PIPE,
                          stderr=subprocess.DEVNULL, check=True, pass_fds=pass_fds).stdout

def node_public(key):
    alphabet = "rpshnaf39wBUDNEGHJKLM4PQRST7VWXYZ2bcdeCg65jkm8oFqi1tuvAxyz"
    body = bytes([28]) + key
    raw = body + hashlib.sha256(hashlib.sha256(body).digest()).digest()[:4]
    value, result = int.from_bytes(raw, "big"), ""
    while value:
        value, digit = divmod(value, 58)
        result = alphabet[digit] + result
    return result

try:
    active, parts, sections = False, [], 0
    with open(sys.argv[1], encoding="utf8") as config:
        for line in config:
            line = line.split("#", 1)[0].strip()
            if line.startswith("["):
                active = line == "[validator_token]"
                sections += int(active)
            elif active and line:
                parts.append(line)
    if sections != 1 or not parts:
        error("This node is not configured with a single [validator_token].")
    token_data = json.loads(base64.b64decode("".join(parts), validate=True))
    secret = bytes.fromhex(token_data["validation_secret_key"])
    manifest = token_data["manifest"]
    if len(secret) != 32 or not isinstance(manifest, str) or not 1 <= len(manifest) <= 2048:
        error("Invalid validator token. Check the running node configuration.")
    base64.b64decode(manifest, validate=True)
    # SEC1 ECPrivateKey, secp256k1 OID. OpenSSL performs all EC operations.
    der = bytes.fromhex("302e0201010420") + secret + bytes.fromhex("a00706052b8104000a")
    spki = openssl(["pkey", "-inform", "DER", "-pubout", "-outform", "DER", "-ec_conv_form", "compressed"], der)
    prefix = bytes.fromhex("3036301006072a8648ce3d020106052b8104000a032200")
    if not spki.startswith(prefix) or len(spki) != len(prefix) + 33:
        error("OpenSSL did not return a secp256k1 public key.")
    signing_key = node_public(spki[len(prefix):])
    # validator-keys sign uses SHA512Half + canonical low-S DER ECDSA.
    digest = hashlib.sha512(sys.argv[3].encode()).digest()[:32]
    read_fd, write_fd = os.pipe()
    try:
        os.write(write_fd, digest)
        os.close(write_fd)
        signature = openssl(["pkeyutl", "-sign", "-keyform", "DER", "-inkey", "/dev/stdin", "-in", "/proc/self/fd/" + str(read_fd)], der, (read_fd,))
    finally:
        os.close(read_fd)
    r_len = signature[3]
    r = int.from_bytes(signature[4:4+r_len], "big")
    s = int.from_bytes(signature[6+r_len:], "big")
    order = 0xfffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141
    s = min(s, order-s)
    def integer(value):
        raw = value.to_bytes((value.bit_length()+7)//8, "big")
        if raw[0] & 128:
            raw = b"\0" + raw
        return b"\x02" + bytes([len(raw)]) + raw
    encoded = integer(r) + integer(s)
    signature = b"\x30" + bytes([len(encoded)]) + encoded
    print(json.dumps({"master_public_key": sys.argv[2], "signing_public_key": signing_key,
                      "signature": signature.hex().upper(), "manifest": manifest}))
except Exception:
    error("Offline signing failed. The mounted config must contain a valid validator token; the running image needs Python 3 and OpenSSL with secp256k1.")
PY
  ) || fail 'Offline token signing failed. Check the mounted config and Python 3/OpenSSL in the running image. Master-key fallback requires explicit --keyfile.'
fi
reply=$(printf '{"token":"%s",%s' "$token" "${proof#\{}" | post complete) || fail 'Connection request failed. Check Settings before retrying.'
if message=$(printf '%s' "$reply" | json_field message); then
  printf '%s\n' "$message"
else
  error=$(printf '%s' "$reply" | json_field error) || error=connection_failed
  fail "$error. Check Settings or create a fresh command."
fi
