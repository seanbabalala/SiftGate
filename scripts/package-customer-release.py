#!/usr/bin/env python3
"""Build a secret-free, checksummed installer archive from an exact Git commit."""
import argparse
import hashlib
import io
import json
from pathlib import Path
import re
import subprocess
import tarfile

ROOT = Path(__file__).resolve().parent.parent
FILES = {
    "deploy/customer/siftgate.py": "siftgate.py",
    "deploy/customer/compose.yaml": "compose.yaml",
    "deploy/customer/container-ops.cjs": "container-ops.cjs",
    "deploy/customer/siftgate-watchdog.service": "siftgate-watchdog.service",
    "deploy/customer/siftgate-watchdog.timer": "siftgate-watchdog.timer",
    "gateway.config.example.yaml": "gateway.config.example.yaml",
    "docs/customer-install.md": "README.md",
    "docs/customer-install.zh-cn.md": "README.zh-CN.md",
    "LICENSE": "LICENSE",
}


def git(*args):
    return subprocess.check_output(["git", "-C", str(ROOT), *args])


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--ref", default="HEAD")
    parser.add_argument("--version", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9.-]{0,100}", args.version):
        raise ValueError("Invalid version")
    if not re.fullmatch(r"[a-z0-9./:_-]+@sha256:[a-f0-9]{64}", args.image):
        raise ValueError("Release archives require an immutable registry digest, not a local tag")
    commit = git("rev-parse", "--verify", args.ref + "^{commit}").decode().strip()
    epoch = int(git("show", "-s", "--format=%ct", commit))
    payload = {target: git("show", f"{commit}:{source}") for source, target in FILES.items()}
    payload["release.json"] = (json.dumps({
        "format": "siftgate-customer-release-v1", "version": args.version,
        "commit": commit, "image": args.image,
    }, indent=2) + "\n").encode()
    payload["SHA256SUMS"] = "".join(
        f"{hashlib.sha256(data).hexdigest()}  {name}\n" for name, data in sorted(payload.items())
    ).encode()
    output = Path(args.output).resolve()
    output.mkdir(parents=True, exist_ok=True)
    destination = output / f"siftgate-{args.version}-install.tar.gz"
    # Explicit whitelist + git show: never include a worktree's config, databases, .env, or test evidence.
    with destination.open("xb") as raw:
        import gzip
        with gzip.GzipFile(fileobj=raw, mode="wb", filename="", mtime=epoch) as zipped:
            with tarfile.open(fileobj=zipped, mode="w") as archive:
                for name, data in sorted(payload.items()):
                    info = tarfile.TarInfo(f"siftgate-{args.version}/{name}")
                    info.size, info.mtime = len(data), epoch
                    info.mode = 0o755 if name == "siftgate.py" else 0o644
                    archive.addfile(info, io.BytesIO(data))
    digest = hashlib.sha256(destination.read_bytes()).hexdigest()
    destination.with_suffix(destination.suffix + ".sha256").write_text(f"{digest}  {destination.name}\n")
    print(json.dumps({"archive": str(destination), "sha256": digest, "commit": commit}))


if __name__ == "__main__":
    main()
