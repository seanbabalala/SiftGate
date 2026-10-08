#!/usr/bin/env python3
"""Verify the remote annotated tag without trusting checkout's local tag ref."""
import argparse
import json
from pathlib import Path
import re
import subprocess
import sys
import uuid


class ReleaseTagError(ValueError):
    pass


def git(repository, *args):
    try:
        return subprocess.check_output(
            ["git", "-C", str(repository), *args], text=True,
            stderr=subprocess.PIPE, timeout=60,
        ).strip()
    except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as error:
        # Do not echo remote URLs, authentication headers or tag messages.
        raise ReleaseTagError(f"git {args[0]} failed; refusing publication") from error


def verify(repository, tag, commit):
    repository = Path(repository).resolve()
    if not re.fullmatch(r"v[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?", tag):
        raise ReleaseTagError("Expected an explicit version tag")
    if not re.fullmatch(r"[a-f0-9]{40}", commit):
        raise ReleaseTagError("Expected a full source commit SHA")
    if git(repository, "rev-parse", "HEAD^{commit}") != commit:
        raise ReleaseTagError("Checkout does not match the expected source commit")
    if tag != "v" + json.loads((repository / "package.json").read_text())["version"]:
        raise ReleaseTagError("Tag does not match the checked-out package version")

    # actions/checkout can fetch <event-commit>:refs/tags/<name>, flattening a
    # valid annotated tag locally. Fetch the remote object into a fresh private
    # ref instead. Never overwrite local/remote version tags or FETCH_HEAD.
    reference = "refs/siftgate-release-check/" + uuid.uuid4().hex
    if git(repository, "for-each-ref", "--format=%(refname)", reference):
        raise ReleaseTagError("Verification ref already exists")
    tag_object = None
    try:
        git(repository, "fetch", "--no-tags", "--no-write-fetch-head", "origin",
            f"refs/tags/{tag}:{reference}")
        tag_object = git(repository, "rev-parse", "--verify", reference)
        if git(repository, "cat-file", "-t", tag_object) != "tag":
            raise ReleaseTagError("Remote release tag must be annotated")
        header = git(repository, "cat-file", "tag", tag_object).split("\n\n", 1)[0]
        fields = dict(line.split(" ", 1) for line in header.splitlines())
        if fields.get("tag") != tag or fields.get("type") != "commit":
            raise ReleaseTagError("Remote annotated tag has an unexpected identity or target type")
        if fields.get("object") != commit or git(repository, "rev-parse", reference + "^{commit}") != commit:
            raise ReleaseTagError("Remote annotated tag points to a different source commit")
        if git(repository, "rev-parse", "HEAD^{commit}") != commit:
            raise ReleaseTagError("Checkout changed during tag verification")
        return {"tag": tag, "tag_object": tag_object, "commit": commit}
    finally:
        if tag_object is not None:
            # Delete only this invocation's ref, and only if it still has the
            # object we fetched. This never deletes the release tag itself.
            git(repository, "update-ref", "-d", reference, tag_object)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=Path(__file__).resolve().parent.parent)
    parser.add_argument("--tag", required=True)
    parser.add_argument("--commit", required=True)
    args = parser.parse_args()
    try:
        print(json.dumps(verify(args.repository, args.tag, args.commit)))
    except (ReleaseTagError, OSError, KeyError, json.JSONDecodeError) as error:
        print(f"Release tag validation failed: {error}", file=sys.stderr)
        raise SystemExit(1) from error


if __name__ == "__main__":
    main()
