#!/usr/bin/env python3
"""Verify the reviewed Docker input policy and media approvals without deployment."""
import argparse
import hashlib
import json
from pathlib import Path
import re
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
MEDIA = {".png", ".jpg", ".jpeg", ".gif", ".webp", ".svg", ".pdf", ".mp4", ".mov"}


def require(value, message):
    if not value:
        raise ValueError(message)


def tracked(root):
    return [p for p in subprocess.check_output(["git", "-C", str(root), "ls-files", "-z"]).decode().split("\0") if p]


def check(root=ROOT):
    policy = json.loads((root / ".security/docker-context.json").read_text())
    actual = [line.strip() for line in (root / ".dockerignore").read_text().splitlines()
              if line.strip() and not line.startswith("#")]
    require(actual == policy["patterns"] and actual[0] == "**", "Docker input policy changed; review its allowlist and sentinel tests")
    dockerfile = (root / "Dockerfile").read_text()
    copies = [line.strip() for line in dockerfile.splitlines() if re.match(r"(?i)^COPY\s", line)]
    require(copies == policy["copy_instructions"], "Docker COPY inputs changed; review the publication boundary")
    reviews = json.loads((root / ".security/media-review.json").read_text())["files"]
    media = {p for p in tracked(root) if Path(p).suffix.lower() in MEDIA and (root / p).exists()}
    require(media == set(reviews), "Added/deleted media requires an explicit privacy/provenance review")
    for name in media:
        review = reviews[name]
        require(review["sha256"] == hashlib.sha256((root / name).read_bytes()).hexdigest() and
                len(review["privacy_review"]) >= 30 and len(review["source_note"]) >= 30,
                "Changed media requires renewed review: " + name)
    print(f"Publication boundary passed: {len(copies)} COPY inputs, {len(media)} reviewed media files.")


def docker_sentinel(root=ROOT):
    """Use only synthetic bytes; no actual source, credentials, ports or service containers."""
    policy = json.loads((root / ".security/docker-context.json").read_text())
    with tempfile.TemporaryDirectory(prefix="siftgate-context-test-") as name:
        temporary = Path(name)
        context = temporary / "context"
        context.mkdir()
        (context / ".dockerignore").write_bytes((root / ".dockerignore").read_bytes())
        (context / "Dockerfile").write_text("FROM scratch\nCOPY . /\n")
        for file in policy["allowed_sentinels"] + policy["denied_sentinels"]:
            path = context / file
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text("synthetic-publication-boundary-probe\n")
        output = temporary / "result"
        command = ["docker", "buildx", "build", "--no-cache", "--network=none", "--output", "type=local,dest=" + str(output), str(context)]
        result = subprocess.run(command, capture_output=True, timeout=180)
        require(result.returncode == 0, "Synthetic Docker context test failed; no production instance was touched")
        for file in policy["allowed_sentinels"]:
            require((output / file).is_file(), "Required Docker input excluded: " + file)
        for file in policy["denied_sentinels"]:
            require(not (output / file).exists(), "Private Docker input included: " + file)
        print("Real Docker matcher refused every private sentinel; required build inputs retained.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--docker", action="store_true")
    args = parser.parse_args()
    check()
    if args.docker:
        docker_sentinel()
