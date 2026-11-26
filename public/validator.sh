#!/bin/sh
# Connect using the running validator token. Master files require --keyfile.
# Inspect: https://github.com/postfiatorg/tasknode/blob/main/public/validator.sh
set +x
set -eu
fail() { printf '%s\n' "Validator connect: $*" >&2; exit 1; }
token=${1:-}
[ "$token" != '--help' ] || { printf '%s\n' 'Usage: sh validator.sh <token> [--diagnose] [--keyfile /existing/validator-keys.json]'; exit 0; }
[ "$#" -gt 0 ] || fail 'Copy a fresh command from Task Node Settings > Validator.'
shift
case "$token" in vct_*) ;; *) fail 'Invalid connect token. Copy a fresh command.' ;; esac
[ "${#token}" -eq 68 ] || fail 'Invalid connect token.'
case "${token#vct_}" in *[!0-9a-f]*) fail 'Invalid connect token.' ;; esac
keyfile=
diagnose=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --diagnose) diagnose=1; shift ;;
    --keyfile) [ "$#" -ge 2 ] && [ -n "$2" ] || fail 'Specify an existing master key file.'; keyfile=$2; shift 2 ;;
    *) fail 'Usage: sh validator.sh <token> [--diagnose] [--keyfile /existing/validator-keys.json]' ;;
  esac
done
note() { [ "$diagnose" = 0 ] || printf '%s\n' "Validator diagnose: $1" >&2; }
note 'host tools and running container'

for tool in curl docker awk stat; do command -v "$tool" >/dev/null 2>&1 || fail "$tool is required."; done
[ "$(docker inspect --format '{{.State.Running}}' postfiatd 2>/dev/null)" = true ] || fail 'Cannot access running postfiatd. Run as a user with Docker access on the validator host.'
image=$(docker inspect --format '{{.Image}}' postfiatd)
field_program='{for(i=2;i<=NF;i+=2) if($i==name){value=$(i+2); count++}} END{if(count==1) print value; else exit 1}'
json_field() { awk -F '"' -v name="$1" "$field_program"; }
# This only queries public RPC output and config-path metadata. The validator
# token is read later, inside the offline signer, never in a shell variable.
if [ -z "$keyfile" ]; then
  note 'running config path and public server_info'
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
case "$public_key" in nH*|n9*) ;; *) fail 'This node is not configured as a validator (no master pubkey_validator).';; esac
case "$public_key" in *[!123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz]*) fail 'Invalid public key.' ;; esac
[ "${#public_key}" -ge 40 ] && [ "${#public_key}" -le 60 ] || fail 'Invalid public key length.'
if [ "$location" = host ]; then
  sign_user=$(stat -c '%u:%g' "$input") || fail 'Cannot inspect input file permissions.'
else
  sign_user=$(docker exec postfiatd stat -c '%u:%g' "$input" 2>/dev/null) || fail 'Cannot inspect the mounted config or explicit key file.'
fi
note 'input owner found; preparing offline signer'
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
note 'requesting account-bound challenge'
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
  proof=$(offline python3 - "$input" "$public_key" "$challenge" "$diagnose" <<'PY'
import base64, hashlib, json, os, resource, subprocess, sys
resource.setrlimit(resource.RLIMIT_CORE, (0, 0))
step = "initialization"
diagnose = len(sys.argv) > 4 and sys.argv[4] == "1"

def stage(value):
    global step
    step = value
    if diagnose:
        print("Validator diagnose: " + value, file=sys.stderr)

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

def manifest_keys(raw):
    # Bounded XRPL manifest STObject: UInt16, UInt32 and variable-length fields.
    # Master/signing keys are VL fields 1/3; never infer key type from the master.
    offset, fields = 0, {}
    allowed = {(1, 16), (2, 4), (7, 1), (7, 3), (7, 6), (7, 7), (7, 18)}
    def take(size):
        nonlocal offset
        if size < 0 or offset + size > len(raw):
            raise ValueError()
        value = raw[offset:offset+size]
        offset += size
        return value
    while offset < len(raw):
        header = take(1)[0]
        kind, field = header >> 4, header & 15
        if kind == 0:
            kind = take(1)[0]
        if field == 0:
            field = take(1)[0]
        tag = (kind, field)
        if tag not in allowed or tag in fields:
            raise ValueError()
        if kind == 7:
            first = take(1)[0]
            if first <= 192:
                size = first
            elif first <= 240:
                size = 193 + (first-193)*256 + take(1)[0]
            elif first <= 254:
                size = 12481 + (first-241)*65536 + int.from_bytes(take(2), "big")
            else:
                raise ValueError()
        else:
            size = {1: 2, 2: 4}[kind]
        fields[tag] = take(size)
    return fields[(7, 1)], fields[(7, 3)]

try:
    stage("config_read")
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
    stage("token_decode")
    token_text = "".join(parts).strip()
    token_text += "=" * (-len(token_text) % 4)
    token_data = json.loads(base64.b64decode(token_text, altchars=b"-_", validate=True))
    secret = bytes.fromhex(token_data["validation_secret_key"])
    manifest = token_data["manifest"]
    if len(secret) != 32 or not isinstance(manifest, str) or not 1 <= len(manifest) <= 2048:
        error("Invalid validator token. Check the running node configuration.")
    stage("manifest_decode")
    master, signing = manifest_keys(base64.b64decode(manifest, validate=True))
    if len(master) != 33 or len(signing) != 33 or node_public(master) != sys.argv[2]:
        error("Token manifest does not match this running validator's public key.")
    if signing[0] == 0xed:
        stage("derive_ed25519_public_key")
        # PKCS#8 Ed25519 seed. Sign raw UTF-8 bytes (no prehash).
        der = bytes.fromhex("302e020100300506032b657004220420") + secret
        prefix = bytes.fromhex("302a300506032b6570032100")
        spki = openssl(["pkey", "-inform", "DER", "-pubout", "-outform", "DER"], der)
        expected = prefix + signing[1:]
        payload = sys.argv[3].encode()
        sign_options = ["-rawin"]
    elif signing[0] in (2, 3):
        stage("derive_secp256k1_public_key")
        der = bytes.fromhex("302e0201010420") + secret + bytes.fromhex("a00706052b8104000a")
        prefix = bytes.fromhex("3036301006072a8648ce3d020106052b8104000a032200")
        spki = openssl(["pkey", "-inform", "DER", "-pubout", "-outform", "DER", "-ec_conv_form", "compressed"], der)
        expected = prefix + signing
        payload = hashlib.sha512(sys.argv[3].encode()).digest()[:32]
        sign_options = []
    else:
        error("Unsupported validator signing-key type in the public manifest.")
    if spki != expected:
        error("Validator token secret does not match its public signing key.")
    signing_key = node_public(signing)
    stage("sign_challenge")
    # OpenSSL 3 Ed25519 needs a known-length input. Only the PUBLIC challenge
    # enters this anonymous memory file; private DER stays on the stdin pipe.
    public_fd = os.memfd_create("tasknode-public-challenge", os.MFD_CLOEXEC)
    try:
        os.write(public_fd, payload)
        os.lseek(public_fd, 0, os.SEEK_SET)
        signature = openssl(["pkeyutl", "-sign", *sign_options, "-keyform", "DER", "-inkey", "/dev/stdin", "-in", "/proc/self/fd/" + str(public_fd)], der, (public_fd,))
    finally:
        os.close(public_fd)
    if signing[0] == 0xed:
        if len(signature) != 64:
            raise ValueError()
    else:
        # Canonical low-S DER ECDSA, matching validator-keys sign.
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
    stage("public_proof_ready")
    print(json.dumps({"master_public_key": sys.argv[2], "signing_public_key": signing_key,
                      "signature": signature.hex().upper(), "manifest": manifest}))
except FileNotFoundError:
    error("Offline step " + step + " failed: required config or tool is absent in the offline container.")
except PermissionError:
    error("Offline step " + step + " failed: input is not readable by the signing user.")
except Exception:
    error("Offline step " + step + " failed. Use --diagnose to show safe step names; no private input is displayed.")
PY
  ) || fail 'Offline token signing failed. Check the mounted config and Python 3/OpenSSL in the running image. Master-key fallback requires explicit --keyfile.'
fi
note 'submitting public proof'
reply=$(printf '{"token":"%s",%s' "$token" "${proof#\{}" | post complete) || fail 'Connection request failed. Check Settings before retrying.'
if message=$(printf '%s' "$reply" | json_field message); then
  printf '%s\n' "$message"
else
  error=$(printf '%s' "$reply" | json_field error) || error=connection_failed
  fail "$error. Check Settings or create a fresh command."
fi
