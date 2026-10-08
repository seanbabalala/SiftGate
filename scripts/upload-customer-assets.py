#!/usr/bin/env python3
"""Resume release asset uploads without deleting or overwriting published bytes."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile
import sys

sys.path.insert(0,str(Path(__file__).resolve().parents[1]/"deploy/customer"))
import siftgate_release as release


def gh(*args):
    return subprocess.check_output(["gh", *args], text=True).strip()


def sha256(path):
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def names_for(tag, require_attestation=False):
    matched=re.fullmatch(r"v([0-9]+)\.([0-9]+)\.([0-9]+)(?:-[A-Za-z0-9.-]+)?",tag)
    if not matched: raise ValueError("Expected a version tag")
    signed=require_attestation or tuple(map(int,matched.groups()))>=(2,12,0)
    prefix="siftgate-"+tag
    return [prefix+"-install.tar.gz",prefix+"-install.tar.gz.sha256"]+([prefix+"-release.json",prefix+"-release.sigstore.jsonl"] if signed else [])


def validate_local(repo,tag,directory,require_attestation=False,allow_missing_bundle=False):
    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", repo):
        raise ValueError("Invalid repository")
    names=names_for(tag,require_attestation)
    files = list(directory.iterdir())
    allowed=[set(names)]
    if allow_missing_bundle and len(names)==4: allowed.append(set(names[:-1]))
    if {p.name for p in files} not in allowed or any(p.is_symlink() or not p.is_file() or p.stat().st_nlink!=1 for p in files):
        raise ValueError("Upload directory must contain only the exact release artifact set")
    checksum = (directory / names[1]).read_text().strip()
    if checksum != f"{sha256(directory / names[0])}  {names[0]}":
        raise ValueError("Local archive/checksum mismatch")
    if len(names)==4:
        manifest=release.validate_manifest(release.json_bytes(release.read_bytes(directory/names[2],release.MAX_MANIFEST)))
        if manifest["tag"]!=tag or manifest["repository"].lower()!=repo.lower() or manifest["installer"]!={
                "name":names[0],"sha256":sha256(directory/names[0]),"bytes":(directory/names[0]).stat().st_size}:
            raise ValueError("Manifest does not bind this release and installer")
        if (directory/names[3]).exists():
            release.verify_release(directory/names[2],directory/names[3])
    return names


def synchronize(repo, tag, directory, verify_only=False, require_attestation=False):
    names=validate_local(repo,tag,directory,require_attestation)
    response = json.loads(gh("release", "view", tag, "--repo", repo, "--json", "assets"))
    present = {asset["name"] for asset in response["assets"]}
    if len(present)!=len(response["assets"]): raise ValueError("Ambiguous duplicate release assets")
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
    parser.add_argument("--require-attestation",action="store_true")
    args = parser.parse_args()
    synchronize(args.repo, args.tag, args.directory, args.verify_only,args.require_attestation)
    print("Release assets match; no existing bytes were overwritten.")


if __name__ == "__main__":
    main()
