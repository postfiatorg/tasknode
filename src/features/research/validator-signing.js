export function validatorSigningCommands(challenge) {
  const message = typeof challenge === "string" && challenge ? challenge : "<challenge>";
  const quoted = `"${message.replaceAll("\\", "\\\\").replaceAll('"', '\\"').replaceAll("$", "\\$").replaceAll("`", "\\`")}"`;
  return [
    { id: "container", title: "Key inside the postfiatd container",
      command: `docker exec postfiatd validator-keys --keyfile /root/.ripple/validator-keys.json sign ${quoted}` },
    { id: "host", title: "Key file on the host",
      command: `docker run --rm --network none -v /path/to/validator-keys.json:/keys/validator-keys.json:ro --entrypoint /usr/local/bin/validator-keys <postfiatd image> --keyfile /keys/validator-keys.json sign ${quoted}` },
  ];
}
