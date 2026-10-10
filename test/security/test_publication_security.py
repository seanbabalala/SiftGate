"""Security gates use real synthetic Git/scanner/Docker-policy inputs, never a live gateway."""
import hashlib
import importlib.util
import json
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
import unittest
import uuid
from unittest.mock import patch

ROOT = Path(__file__).resolve().parents[2]


def module(name, path):
    spec = importlib.util.spec_from_file_location(name, path)
    value = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(value)
    return value


scan = module("secret_scan", ROOT / "scripts/scan-secrets.py")
boundary = module("publication_boundary", ROOT / "scripts/check-publication-boundary.py")


class ScannerTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.tool_home = tempfile.TemporaryDirectory()
        cls.binary = scan.scanner(Path(cls.tool_home.name))

    @classmethod
    def tearDownClass(cls):
        cls.tool_home.cleanup()

    def setUp(self):
        self.home = tempfile.TemporaryDirectory()
        self.root = Path(self.home.name).resolve()
        self.repo = self.root / "repo"
        self.repo.mkdir()
        self.policy = self.root / "policy"
        (self.policy / ".security").mkdir(parents=True)
        shutil.copyfile(ROOT / ".gitleaks.toml", self.policy / ".gitleaks.toml")
        self.write_exceptions([])
        self.git("init", "-q")
        self.git("config", "user.email", "fixture@example.invalid")
        self.git("config", "user.name", "Synthetic Security Test")
        self.secret = "gw_" + "sk_" + uuid.uuid4().hex + uuid.uuid4().hex[:16]

    def tearDown(self):
        self.home.cleanup()

    def git(self, *args):
        return scan.git(self.repo, *args)

    def write_exceptions(self, records):
        (self.policy / ".security/secret-exceptions.json").write_text(json.dumps({"format": 1, "exceptions": records}))

    def write(self, file, value):
        p = self.repo / file
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(value)

    def run_scan(self, mode):
        with tempfile.TemporaryDirectory(dir=self.root) as temp:
            return scan.run_scan(self.binary, self.repo, self.policy, mode, Path(temp))

    def test_dotfiles_extensionless_docs_and_tests_are_all_scanned_and_redacted(self):
        files = [".env.example", ".npmrc", "Dockerfile", "docs/README.md", "test/unit/fixture.ts"]
        for file in files:
            self.write(file, 'API_KEY="' + self.secret + '"\n')
        self.git("add", ".")
        result = self.run_scan("current")
        self.assertEqual({f["file"] for f in result["unreviewed"]}, set(files))
        self.assertNotIn(self.secret, json.dumps(result))

    def test_deleted_secret_stays_detectable_in_commit_history(self):
        self.write("docs/removed.md", 'api_key = "' + self.secret + '"\n')
        self.git("add", "."); self.git("commit", "-qm", "synthetic fixture")
        self.git("rm", "docs/removed.md"); self.git("commit", "-qm", "remove fixture")
        result = self.run_scan("history")
        self.assertTrue(any(v["file"] == "docs/removed.md" for v in result["unreviewed"]))
        self.assertNotIn(self.secret, json.dumps(result))

    def test_repo_ignore_and_inline_allow_comments_cannot_skip_credentials(self):
        self.write(".gitleaksignore", "*\n")
        self.write("test/fixture.ts", 'api_key = "' + self.secret + '" # gitleaks:allow\n')
        self.git("add", ".")
        self.assertTrue(self.run_scan("current")["unreviewed"])

    def test_modern_provider_and_github_tokens_are_not_limited_to_legacy_sk_format(self):
        prefixes = ["sk-" + "proj-", "sk-" + "ant-api03-", "gh" + "p_"]
        for index, prefix in enumerate(prefixes):
            token = prefix + uuid.uuid4().hex + uuid.uuid4().hex
            self.write(f"docs/provider-{index}.txt", 'api_key = "' + token + '"\n')
        self.git("add", ".")
        self.assertEqual({row["file"] for row in self.run_scan("current")["unreviewed"]},
                         {f"docs/provider-{i}.txt" for i in range(len(prefixes))})

    def test_exception_is_exact_value_rule_and_path_not_a_test_directory_exemption(self):
        row = {"path": "test/fixture.ts", "rule": "siftgate-gateway-key",
               "value_digest": hashlib.sha256(self.secret.encode()).hexdigest(),
               "reason": "Synthetic test value generated in this temporary test repository."}
        self.write_exceptions([row])
        base = {"File": row["path"], "RuleID": row["rule"], "Secret": self.secret, "StartLine": 1}
        self.assertEqual(scan.classify([base], scan.exceptions(self.policy)), ([], 1))
        for change in ({"File": "test/other.ts"}, {"RuleID": "generic-api-key"}, {"Secret": self.secret + "new"}):
            self.assertEqual(len(scan.classify([{**base, **change}], scan.exceptions(self.policy))[0]), 1)
        row["path"] = "test/*"
        self.write_exceptions([row])
        with self.assertRaisesRegex(RuntimeError, "unbounded_secret_exception"):
            scan.exceptions(self.policy)

    def test_wrong_archive_digest_fails_before_execution(self):
        bad = self.root / "bad.tar.gz"
        bad.write_bytes(b"not the pinned executable")
        with patch.dict(os.environ, {"SIFTGATE_GITLEAKS_ARCHIVE": str(bad)}):
            with self.assertRaisesRegex(RuntimeError, "scanner_archive_digest_mismatch"):
                scan.scanner(self.root)

    def test_untracked_private_files_are_not_copied_and_tracked_symlinks_fail_closed(self):
        self.write("private.txt", self.secret)
        self.write("safe.txt", "public fixture")
        self.git("add", "safe.txt")
        self.assertEqual(self.run_scan("current")["unreviewed"], [])
        (self.repo / "link").symlink_to(self.repo / "private.txt")
        self.git("add", "link")
        with self.assertRaisesRegex(RuntimeError, "nonregular_tracked_file"):
            self.run_scan("current")


class BoundaryTests(unittest.TestCase):
    def test_current_copy_and_media_ledger_match(self):
        boundary.check()

    def test_changed_media_and_context_policy_are_not_silently_approved(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            (root / ".security").mkdir()
            for file in (".dockerignore", "Dockerfile", ".security/docker-context.json", ".security/media-review.json"):
                shutil.copyfile(ROOT / file, root / file)
            reviews = json.loads((root / ".security/media-review.json").read_text())["files"]
            for name in reviews:
                (root / name).parent.mkdir(parents=True, exist_ok=True)
                shutil.copyfile(ROOT / name, root / name)
            with patch.object(boundary, "tracked", return_value=list(reviews)):
                boundary.check(root)
                changed = root / next(iter(reviews))
                changed.write_bytes(changed.read_bytes() + b"\n")
                with self.assertRaisesRegex(ValueError, "Changed media"):
                    boundary.check(root)
                (root / ".dockerignore").write_text("\n!**\n")
                with self.assertRaisesRegex(ValueError, "Docker input policy changed"):
                    boundary.check(root)

    def test_installer_mapping_is_explicit_and_uses_git_objects_not_local_globs(self):
        package = module("customer_package", ROOT / "scripts/package-customer-release.py")
        for source, destination in package.FILES.items():
            self.assertTrue(source.startswith(("deploy/customer/", "docs/")) or source in {"LICENSE", "gateway.config.example.yaml"})
            self.assertNotIn("..", Path(source).parts)
            self.assertNotIn("/", destination)
            self.assertFalse(any(part in source for part in (".env", "private-records", "output/", ".local-dev", ".bundle")))
        text = (ROOT / "scripts/package-customer-release.py").read_text()
        self.assertIn('git("show", f"{commit}:{source}")', text)

    def test_ci_and_tag_publication_both_have_secret_and_boundary_gates(self):
        for file in (".github/workflows/ci.yml", ".github/workflows/customer-release.yml"):
            text = (ROOT / file).read_text()
            self.assertIn("python3 scripts/scan-secrets.py", text)
            self.assertIn("python3 scripts/check-publication-boundary.py", text)
            self.assertIn("fetch-depth: 0", text)


if __name__ == "__main__":
    unittest.main()
