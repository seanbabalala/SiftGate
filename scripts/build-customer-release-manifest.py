#!/usr/bin/env python3
"""Build the attestation subject from exact source and both native acceptance receipts."""
import argparse
import datetime as dt
import json
from pathlib import Path
import subprocess
import sys

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "deploy/customer"))
import siftgate_release as release

REQUIRED_CHECKS = {"fresh_install", "cross_version_upgrade", "restore_verification", "operator_durability", "offline_image", "fleet_governance"}


def build_manifest(version, commit, epoch, image, archive, contract, candidates):
    release.version(version)
    release.require(contract.get("format") == "siftgate-release-contract-v1", "invalid_release_contract")
    sources = contract["source_releases"]
    release.require(type(sources) is list and sources, "tested_source_releases_required")
    expected_sources = {item["version"]: item["image"] for item in sources}
    release.require(len(expected_sources) == len(sources), "duplicate_source_release")
    platforms = {}; source_images = {version: {} for version in expected_sources}
    for architecture in ("amd64", "arm64"):
        candidate = candidates[architecture]
        release.require(candidate["architecture"] == architecture and candidate["commit"] == commit and candidate.get("native_runner") is True,
                        "candidate_source_or_architecture_mismatch")
        release.require(candidate.get("source_releases") == expected_sources, "cross_version_evidence_missing")
        release.keys(candidate.get("source_config_digests"), expected_sources)
        for source_version in expected_sources:
            source_images[source_version]["linux/" + architecture] = candidate["source_config_digests"][source_version]
        checks = candidate.get("checks")
        release.require(type(checks) is list and all(isinstance(check, str) for check in checks) and
                        REQUIRED_CHECKS <= set(checks), "native_acceptance_incomplete")
        release.require(isinstance(candidate["digest"], str) and release.IMAGE_ID.fullmatch(candidate["digest"]), "invalid_candidate_digest")
        platforms["linux/" + architecture] = {"image": release.REGISTRY + "@" + candidate["digest"], "config_digest": candidate["config_digest"]}
    return release.validate_manifest({"format": release.FORMAT, "repository": release.REPOSITORY,
        "version": version, "tag": "v" + version, "source_commit": commit,
        "built_at": dt.datetime.fromtimestamp(epoch, dt.timezone.utc).isoformat(), "image": image, "platforms": platforms,
        "installer": {"name": archive.name, "sha256": release.sha256(archive), "bytes": archive.stat().st_size},
        "compatibility": {"source_versions": list(expected_sources), "source_config_digests": source_images,
            **{key: contract[key] for key in ("source_kit_protocols", "target_kit_protocol", "operator_protocol", "database", "downtime_required")}},
        "changes": contract["changes"]})


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--version", required=True)
    parser.add_argument("--image", required=True)
    parser.add_argument("--archive", type=Path, required=True)
    parser.add_argument("--candidates", type=Path, required=True)
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()
    commit = subprocess.check_output(["git", "rev-parse", "HEAD"], cwd=ROOT, text=True).strip()
    # The publication subject comes from the exact tagged tree, never a local overlay.
    def source(name):
        return subprocess.check_output(["git", "show", commit + ":" + name], cwd=ROOT)
    package = json.loads(source("package.json"))
    release.require(args.version == "v" + package["version"], "tag_version_mismatch")
    contract = json.loads(source("deploy/customer/release-contract.json"))
    epoch = int(subprocess.check_output(["git", "show", "-s", "--format=%ct", commit], cwd=ROOT, text=True))
    candidates = {arch: release.json_bytes(release.read_bytes(args.candidates / (arch + ".json"), 65536)) for arch in ("amd64", "arm64")}
    manifest = build_manifest(package["version"], commit, epoch, args.image, args.archive, contract, candidates)
    args.output.mkdir(parents=True, exist_ok=True)
    output = args.output / ("siftgate-" + args.version + "-release.json")
    with output.open("xb") as file: file.write(release.canonical(manifest) + b"\n")
    print(json.dumps({"manifest": str(output), "sha256": release.sha256(output), "publisher_attestation_still_required": True}))


if __name__ == "__main__": main()
