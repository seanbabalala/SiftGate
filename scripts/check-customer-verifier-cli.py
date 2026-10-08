#!/usr/bin/env python3
"""Exercise the actual gh parser offline. This is NOT signature acceptance."""
import json
import os
from pathlib import Path
import re
import subprocess
import sys
import tempfile

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "deploy/customer"))
import siftgate_release as release


def main():
    version = subprocess.check_output(["gh", "version"], text=True, timeout=10)
    match = re.search(r"gh version (\d+)\.(\d+)\.(\d+)", version)
    release.require(match and tuple(map(int, match.groups())) >= (2, 86, 0), "github_verifier_2_86_required")
    with tempfile.TemporaryDirectory(prefix="siftgate-verifier-parser-") as temporary:
        root = Path(temporary)
        artifact = root / "not-a-release.json"
        artifact.write_text("{}")
        bundle = root / "not-an-attestation.jsonl"
        bundle.write_text("{}")
        missing = root / "deliberately-missing-trusted-root.jsonl"
        arguments = release.verifier_arguments(artifact, bundle, {"tag": "v0.0.0", "source_commit": "0" * 40})
        arguments += ["--custom-trusted-root", str(missing)]
        environment = {key: value for key, value in os.environ.items()
                       if key not in ("GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN")}
        environment.update(HOME=temporary, GH_CONFIG_DIR=temporary, GH_PROMPT_DISABLED="1",
                           HTTP_PROXY="http://127.0.0.1:9", HTTPS_PROXY="http://127.0.0.1:9",
                           ALL_PROXY="http://127.0.0.1:9", NO_PROXY="")
        def invoke(command):
            return subprocess.run(command, env=environment, capture_output=True, text=True, timeout=20)
        accepted = invoke(arguments)
        # It must reach local trust-file loading, not reject the CLI argument set.
        release.require(accepted.returncode != 0 and missing.name in accepted.stderr and
                        "error creating Sigstore verifier" in accepted.stderr,
                        "verifier_cli_policy_not_accepted")
        conflicting = invoke(arguments + ["--signer-workflow", release.WORKFLOW])
        release.require(conflicting.returncode != 0 and "cert-identity" in conflicting.stderr and
                        "signer-workflow" in conflicting.stderr and "none of the others" in conflicting.stderr,
                        "verifier_cli_conflict_control_failed")
    print(json.dumps({"actual_cli_policy_accepted": True, "conflicting_selectors_rejected": True,
                      "publisher_signature_tested": False, "network_required": False}))


if __name__ == "__main__":
    main()
