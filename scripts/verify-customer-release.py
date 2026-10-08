#!/usr/bin/env python3
"""Verify a release manifest's publisher proof. Does not install or restart anything."""
import argparse
import json
from pathlib import Path
import sys

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy/customer"))
import siftgate_release as release


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--manifest", type=Path, required=True)
    parser.add_argument("--bundle", type=Path, required=True)
    parser.add_argument("--trusted-root", type=Path)
    parser.add_argument("--trusted-root-sha256")
    args = parser.parse_args()
    verified = release.verify_release(args.manifest, args.bundle,
        trusted_root=args.trusted_root, trusted_root_sha256=args.trusted_root_sha256)
    print(json.dumps({"publisher_verified": True, "release_digest": verified.digest,
                      "version": verified.manifest["version"], "deployed": False}))


if __name__ == "__main__":
    try: main()
    except release.ReleaseError as error:
        print(json.dumps({"error": str(error)}), file=sys.stderr); sys.exit(1)
    except Exception:
        print(json.dumps({"error": "release_verification_unavailable"}), file=sys.stderr); sys.exit(1)
