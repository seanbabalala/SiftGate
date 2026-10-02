#!/usr/bin/env python3
"""Resume release asset uploads without deleting or overwriting published bytes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True).strip()


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def synchronize(repo, tag, directory, verify_only=False):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid repository")
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?", tag):
        raise ValueError("Expected a version tag")
    names = [f"siftgate-{tag}-install.tar.gz", f"siftgate-{tag}-install.tar.gz.sha256"]
    files = list(directory.iterdir())
    if {p.name for p in files} != set(names) or any(p.is_symlink() or not p.is_file() for p in files):
        raise ValueError("Upload directory must contain only the exact installer archive/checksum pair")
    checksum = (directory / names[1]).read_text().strip()
    if checksum != f"{sha256(directory / names[0])}  {names[0]}":
        raise ValueError("Local archive/checksum mismatch")
    response = json.loads(gh("release", "view", tag, "--repo", repo, "--json", "assets"))
    present = {asset["name"] for asset in response["assets"]}
    # Check ALL existing assets before uploading anything missing.
    with tempfile.TemporaryDirectory(prefix="siftgate-release-assets-") as temporary:
        for name in names:
            if name not in present:
                continue
            gh("release", "download", tag, "--repo", repo, "--pattern", name, "--dir", temporary)
            if sha256(Path(temporary) / name) != sha256(directory / name):
                raise ValueError(f"Existing release asset differs: {name}; refusing overwrite")
    for name in names:
        if name in present:
            continue
        if verify_only:
            raise ValueError(f"Missing release asset: {name}")
        gh("release", "upload", tag, str(directory / name), "--repo", repo)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", required=True)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--directory", type=Path, required=True)
    parser.add_argument("--verify-only", action="store_true")
    args = parser.parse_args()
    synchronize(args.repo, args.tag, args.directory, args.verify_only)
    print("Release assets match; no existing bytes were overwritten.")


if __name__ == "__main__":
    main()
