"""Build the pinned prover checkout read-only and reuse its two-validator HTTP test setup."""
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile


def main(fix, target):
    revision = subprocess.check_output(["git", "-C", fix, "rev-parse", "HEAD"], text=True).strip()
    status = subprocess.check_output(["git", "-C", fix, "status", "--porcelain"])
    if revision != "e230c4ec3bb66ad0074006f3125e9ad2b41e94fb" or status:
        raise ValueError("The browser run requires a clean prover checkout at e230c4ec3")
    print(f"Building clean prover tree {revision}", flush=True)
    root = Path.cwd()
    parent = root / ".tmp"
    parent.mkdir(exist_ok=True)
    with tempfile.TemporaryDirectory(prefix="wallet-chain-", dir=parent) as temp:
        work = Path(temp)
        env = dict(os.environ, CARGO_TARGET_DIR=str(target), TMPDIR=temp)
        build = subprocess.run([
            "cargo", "build", "--locked", "--offline", "--release", "--message-format=json",
            "--manifest-path", str(fix / "Cargo.toml"), "-p", "postfiat-node",
            "--bin", "postfiat-node", "--bin", "pftl-transferd",
        ], env=env, stdout=subprocess.PIPE, check=True, text=True)
        libraries = {}
        native = []
        for artifact in map(json.loads, build.stdout.splitlines()):
            for path in artifact.get("filenames", []):
                if path.endswith(".rlib"):
                    libraries[artifact["target"]["name"]] = path
            for path in artifact.get("linked_paths", []):
                native.extend(["-L", path])

        reference = (fix / "crates/node/tests/private_actions_gateway.rs").read_text()
        setup = reference.split("#[test]")[0]
        # The test holder needs an importable wallet backup. Use whole-unit precision
        # so entering 9 in the UI moves the same 9 atoms as the reference test.
        holder = """
        let key_file = harness.root.join("browser.key.json");
        postfiat_node::wallet_keygen(postfiat_node::WalletKeygenOptions {
            chain_id: CHAIN_ID.into(), account_index: 0,
            master_seed_hex: bytes_to_hex(&rand::random::<[u8; 32]>()),
            key_file: key_file.clone(), backup_file: harness.root.join("browser.backup.json"),
            overwrite: false,
        }).unwrap();
        let holder: DevKeyFile = serde_json::from_slice(&fs::read(key_file).unwrap()).unwrap();
        """
        assert setup.count("let holder = dev_key();") == setup.count("precision: 6,") == 1
        setup = setup.replace("let holder = dev_key();", holder).replace("precision: 6,", "precision: 0,")
        source = setup + """
        fn main() {
            let chain = start_chain(&std::env::temp_dir());
            let LocalChain { mut harness, rpc_ports, genesis_hash_hex, asset_id, holder, .. } = chain;
            let bearer = harness.root.join("bearer");
            write_private(&bearer, bytes_to_hex(&rand::random::<[u8; 32]>()));
            for name in ["online", "offline"] {
                let mut cmd = Command::new(env!("CARGO_BIN_EXE_pftl-transferd"));
                cmd.args(["--listen", "127.0.0.1:0", "--node-rpc", &format!("127.0.0.1:{}", rpc_ports[0]),
                    "--admission-peer", &format!("127.0.0.1:{}", rpc_ports[1])])
                    .arg("--ready-file").arg(harness.root.join(format!("{name}.ready")))
                    .arg("--state-dir").arg(harness.root.join(name)).arg("--token-file").arg(&bearer);
                if name == "offline" { cmd.arg("--no-submit"); }
                harness.children.push(cmd.stdout(Stdio::null())
                    .stderr(fs::File::create(harness.root.join(format!("{name}.log"))).unwrap())
                    .spawn().unwrap());
            }
            let listen = |name: &str| {
                let ready = harness.root.join(format!("{name}.ready"));
                wait_for_file(&ready, Duration::from_secs(1200));
                let result: Value = serde_json::from_slice(&fs::read(ready).unwrap()).unwrap();
                assert_eq!(result["schema"], "pftl-transferd-ready-v1");
                result["listen"].as_str().unwrap().to_owned()
            };
            let config = harness.root.join("browser.json");
            fs::write(&config, json!({"listen":listen("online"), "offline":listen("offline"), "ports":rpc_ports,
                "chain":CHAIN_ID, "genesis":genesis_hash_hex, "asset":asset_id,
                "account":holder.address}).to_string()).unwrap();
            let status = Command::new("node").arg("scripts/private-wallet/real-browser.mjs")
                .arg(config).status().unwrap();
            assert!(status.success(), "browser run failed");
        }
        """
        src = work / "chain.rs"
        src.write_text(source)
        release = target / "release"
        for name in ["postfiat-node", "pftl-transferd"]:
            env["CARGO_BIN_EXE_" + name] = str(release / name)
        env["CARGO_MANIFEST_DIR"] = str(fix / "crates/node")
        env["WALLET_PROXY_SOURCE"] = str(fix / "wallet-proxy/server.js")
        deps = ["postfiat_crypto_provider", "postfiat_execution", "postfiat_network",
                "postfiat_node", "postfiat_storage", "postfiat_types", "serde_json", "rand"]
        args = [arg for dep in deps for arg in ("--extern", dep + "=" + libraries[dep])]
        binary = work / "chain"
        subprocess.run(["rustc", "--edition=2021", "-Awarnings", str(src), "-L",
                        "dependency=" + str(release / "deps"), *args, *native,
                        "-o", str(binary)], env=env, check=True)
        subprocess.run([binary], env=env, check=True)


if __name__ == "__main__":
    os.umask(0o077)
    main(*(Path(arg).resolve() for arg in sys.argv[1:]))
