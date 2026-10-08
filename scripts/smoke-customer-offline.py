#!/usr/bin/env python3
"""Native offline image transport acceptance; never runs/stops/restarts containers.

This tests a locally built candidate BEFORE the publication attestation exists.
It is not a substitute for cryptographic publisher verification after signing.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import sys
import tempfile

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy/customer"))
import siftgate as kit
import siftgate_release as release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--image", required=True)
    parser.add_argument("--output", type=Path)
    args = parser.parse_args()
    def docker(*arguments, timeout=120):
        return kit.run(["docker", *arguments], timeout=timeout, output_limit=2 * 1024 * 1024)
    before = json.loads(docker("image", "inspect", args.image))[0]
    release.require(before["Os"] == "linux" and before["Architecture"] in ("amd64", "arm64"), "native_image_required")
    identity, architecture = before["Id"], before["Architecture"]
    before_tags = sorted(before.get("RepoTags") or [])
    output = args.output or ROOT / ".local-dev"
    output.mkdir(parents=True, exist_ok=True)
    release.require(shutil.disk_usage(output).free >= before["Size"] * 2 + 512 * 1024 * 1024, "offline_smoke_disk_space")
    folder = Path(tempfile.mkdtemp(prefix="offline-image-smoke-", dir=output)).resolve()
    # Trusted local test harness identity, not a publishable VerifiedRelease receipt.
    raw, normalized = folder / "docker-export.tar", folder / "image.tar"
    try:
        docker("image", "save", "--output", str(raw), identity, timeout=1200)
        os.chmod(raw, 0o600)
        configuration = release.saved_image_identity(raw)
        fixture = release.VerifiedRelease({"platforms": {"linux/" + architecture: {"config_digest": configuration["config_digest"]}}}, "0" * 64)
        verified = release.normalize_offline_image(fixture, raw, normalized, architecture)
        digest = release.sha256(normalized)
        loaded = docker("image", "load", "--input", str(normalized), timeout=1200)
        handles = re.findall(r"^Loaded image ID: (sha256:[a-f0-9]{64})\s*$", loaded, re.MULTILINE)
        release.require(len(handles) == 1, "offline_runtime_handle_missing")
        after = json.loads(docker("image", "inspect", identity))[0]
        release.require(after["Id"] == identity and sorted(after.get("RepoTags") or []) == before_tags, "offline_image_or_tags_changed")
        raw.unlink()
        docker("image", "save", "--output", str(raw), handles[0], timeout=1200)
        roundtrip = release.saved_image_identity(raw)
        release.require(roundtrip == configuration, "offline_config_or_layers_changed")
        result = {"format": "siftgate-offline-smoke-v1", "platform": "linux/" + architecture,
                  "runtime_source_id": identity, "runtime_loaded_id": handles[0], "config_digest": configuration["config_digest"],
                  "archive_sha256": digest, "layers_verified": verified["verified_layers"],
                  "checks": ["normalized_export", "all_layer_digests", "native_docker_load", "no_tag_changes", "no_container_actions"],
                  "publisher_signature_tested": False}
        kit.write_json(folder / "result.json", result)
        print(json.dumps(result, indent=2))
    finally:
        # Large synthetic image archives are disposable; retain the bounded receipt.
        for path in (raw, normalized):
            if path.exists(): path.unlink()


if __name__ == "__main__": main()
