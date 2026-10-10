#!/usr/bin/env python3
"""Pinned, local-only secret scanning. Never print matches or upload raw reports."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import platform
import re
import subprocess
import tarfile
import tempfile
import urllib.request

ROOT = Path(__file__).resolve().parents[1]
VERSION = "8.30.1"
ARCHIVES = {
    ("Linux", "x86_64"): ("linux_x64", "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb"),
    ("Linux", "aarch64"): ("linux_arm64", "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080"),
    ("Darwin", "arm64"): ("darwin_arm64", "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5"),
    ("Darwin", "x86_64"): ("darwin_x64", "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709"),
}


def require(ok, code):
    if not ok:
        raise RuntimeError(code)


def git(repo, *args):
    return subprocess.check_output(["git", "-C", str(repo), *args], stderr=subprocess.PIPE)


def scanner(directory):
    """Fetch only the public scanner binary, verify before executing; no repo data sent."""
    target = ARCHIVES.get((platform.system(), platform.machine()))
    require(target is not None, "unsupported_scanner_platform")
    suffix, expected = target
    name = f"gitleaks_{VERSION}_{suffix}.tar.gz"
    url = f"https://github.com/gitleaks/gitleaks/releases/download/v{VERSION}/{name}"
    archive = directory / name
    # An explicit local archive is useful offline; its bytes still must match the pin.
    local = os.environ.get("SIFTGATE_GITLEAKS_ARCHIVE")
    if local:
        data = Path(local).read_bytes()
    else:
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read(32 * 1024 * 1024 + 1)
    require(len(data) <= 32 * 1024 * 1024 and hashlib.sha256(data).hexdigest() == expected,
            "scanner_archive_digest_mismatch")
    archive.write_bytes(data)
    with tarfile.open(archive) as bundle:
        members = [m for m in bundle.getmembers() if m.name == "gitleaks"]
        require(len(members) == 1 and members[0].isfile() and members[0].size < 100 * 1024 * 1024,
                "unsafe_scanner_archive")
        binary = directory / "gitleaks"
        binary.write_bytes(bundle.extractfile(members[0]).read())
    binary.chmod(0o700)
    version = subprocess.check_output([str(binary), "version"], stderr=subprocess.PIPE, text=True).strip()
    require(version == VERSION, "scanner_version_mismatch")
    return binary


def exceptions(policy_root):
    value = json.loads((policy_root / ".security/secret-exceptions.json").read_text())
    require(value.get("format") == 1 and isinstance(value.get("exceptions"), list), "invalid_secret_exceptions")
    keys = set()
    for row in value["exceptions"]:
        require(set(row) == {"path", "rule", "value_digest", "reason"} and
                isinstance(row["path"], str) and not Path(row["path"]).is_absolute() and
                ".." not in Path(row["path"]).parts and not any(c in row["path"] for c in "*?[]") and
                re.fullmatch(r"[a-f0-9]{64}", row["value_digest"]) and len(row["reason"]) >= 20,
                "unbounded_secret_exception")
        key = (row["path"], row["rule"], row["value_digest"])
        require(key not in keys, "duplicate_secret_exception")
        keys.add(key)
    return keys


def classify(findings, allowed, directory=None):
    result = []
    ignored = 0
    for row in findings:
        file = row["File"]
        if directory is not None:
            file = Path(file).resolve().relative_to(directory.resolve()).as_posix()
        digest = hashlib.sha256(row["Secret"].encode()).hexdigest()
        if (file, row["RuleID"], digest) in allowed:
            ignored += 1
            continue
        # The report and console expose only locations and rule identifiers.
        result.append({"file": file, "line": row["StartLine"], "rule": row["RuleID"],
                       "commit": row.get("Commit", "")})
    return result, ignored


def run_scan(binary, repo, policy_root, mode, temporary, revision="HEAD"):
    report = temporary / (mode + ".json")
    empty_ignore = temporary / "empty.ignore"
    empty_ignore.write_text("")
    directory = None
    if mode == "current":
        directory = temporary / "tracked"
        directory.mkdir()
        # Include staged new files and current edits, not ignored private files.
        for item in git(repo, "ls-files", "-z").decode().split("\0"):
            if not item:
                continue
            source = repo / item
            if not source.exists() and not source.is_symlink():
                continue  # A tracked deletion is still covered by history scanning.
            require(not source.is_symlink() and source.is_file(), "nonregular_tracked_file")
            target = directory / item
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(source.read_bytes())
        command = [str(binary), "dir", str(directory)]
    else:
        require(git(repo, "rev-parse", "--is-shallow-repository").strip() == b"false", "full_history_required")
        commit = git(repo, "rev-parse", "--verify", revision + "^{commit}").decode().strip()
        require(re.fullmatch(r"[a-f0-9]{40}", commit), "invalid_revision")
        command = [str(binary), "git", str(repo), "--log-opts=" + commit + " --full-history --diff-merges=first-parent"]
    command += ["--config", str(policy_root / ".gitleaks.toml"), "--gitleaks-ignore-path", str(empty_ignore),
                "--ignore-gitleaks-allow", "--no-banner", "--no-color", "--log-level", "error",
                "--max-archive-depth", "2", "--report-format", "json", "--report-path", str(report)]
    # Raw findings exist only in this owner-private TemporaryDirectory. They are
    # needed for exact-value comparison, never logged or uploaded as CI artifacts.
    outcome = subprocess.run(command, cwd=repo, capture_output=True, timeout=300)
    require(outcome.returncode in (0, 1) and report.is_file(), "secret_scanner_failed")
    findings = json.loads(report.read_text())
    require(isinstance(findings, list), "invalid_secret_scan_report")
    unknown, reviewed = classify(findings, exceptions(policy_root), directory)
    return {"mode": mode, "unreviewed": unknown, "reviewed_synthetic_matches": reviewed}


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repository", type=Path, default=ROOT)
    parser.add_argument("--policy-root", type=Path, default=ROOT)
    parser.add_argument("--revision", default="HEAD")
    parser.add_argument("--history-only", action="store_true")
    parser.add_argument("--current-only", action="store_true")
    args = parser.parse_args()
    require(not (args.history_only and args.current_only), "conflicting_modes")
    os.umask(0o077)
    with tempfile.TemporaryDirectory(prefix="siftgate-secret-scan-") as folder:
        temporary = Path(folder)
        binary = scanner(temporary)
        modes = ["history"] if args.history_only else ["current"] if args.current_only else ["current", "history"]
        results = [run_scan(binary, args.repository.resolve(), args.policy_root.resolve(), mode, temporary, args.revision)
                   for mode in modes]
        print(json.dumps({"scanner": "gitleaks-" + VERSION, "results": results}, indent=2))
        return 1 if any(r["unreviewed"] for r in results) else 0


if __name__ == "__main__":
    try:
        raise SystemExit(main())
    except Exception:
        # Never echo exception text: it may carry a raw match or credential URL.
        print("Secret scan could not complete; refusing publication. Check the pinned tool, full Git history and policy.")
        raise SystemExit(2)
