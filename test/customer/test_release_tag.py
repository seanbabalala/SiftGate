"""Offline Git fixtures for the tag-only gate, including checkout's flattened ref."""
import importlib.util
import json
from pathlib import Path
import subprocess
import sys
import tempfile
import unittest
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[2]
SPEC = importlib.util.spec_from_file_location("release_tag", ROOT / "scripts/check-customer-release-tag.py")
GATE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(GATE)


class ReleaseTagTests(unittest.TestCase):
    def git(self, repository, *args):
        return subprocess.check_output(["git", "-C", str(repository), *args],
                                       text=True, stderr=subprocess.PIPE, timeout=30).strip()

    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="release-tag-test-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.remote = self.root / "remote.git"
        self.repo = self.root / "checkout"
        self.remote.mkdir()
        self.repo.mkdir()
        self.git(self.remote, "init", "--bare")
        self.git(self.repo, "init")
        self.git(self.repo, "config", "user.name", "Synthetic release test")
        self.git(self.repo, "config", "user.email", "test@example.invalid")
        self.git(self.repo, "config", "commit.gpgsign", "false")
        self.git(self.repo, "config", "tag.gpgsign", "false")
        self.git(self.repo, "config", "core.hooksPath", "/dev/null")
        (self.repo / "package.json").write_text(json.dumps({"version": "1.2.3"}))
        self.git(self.repo, "add", "package.json")
        self.git(self.repo, "commit", "-m", "synthetic source")
        self.commit = self.git(self.repo, "rev-parse", "HEAD")
        self.tag = "v1.2.3"
        self.git(self.repo, "remote", "add", "origin", str(self.remote))
        self.git(self.repo, "push", "origin", "HEAD:refs/heads/main")

    def publish_tag(self, annotated=True, target=None, name=None):
        name = name or self.tag
        args = ["tag"] + (["-a", "-m", "Synthetic tag"] if annotated else [])
        self.git(self.repo, *args, name, target or self.commit)
        self.git(self.repo, "push", "origin", f"refs/tags/{name}:refs/tags/{self.tag}")
        return self.git(self.repo, "rev-parse", f"refs/tags/{name}")

    def verify(self):
        return GATE.verify(self.repo, self.tag, self.commit)

    def assert_no_verification_refs(self):
        self.assertEqual(self.git(self.repo, "for-each-ref", "refs/siftgate-release-check/"), "")

    def test_valid_annotated_tag_preserves_refs_and_fetch_head(self):
        tag_object = self.publish_tag()
        self.git(self.repo, "fetch", "origin", "main")
        before_refs = self.git(self.repo, "show-ref")
        before_fetch = (self.repo / ".git/FETCH_HEAD").read_bytes()
        self.assertEqual(self.verify(), {"tag": self.tag, "tag_object": tag_object, "commit": self.commit})
        self.assertEqual(self.git(self.repo, "show-ref"), before_refs)
        self.assertEqual((self.repo / ".git/FETCH_HEAD").read_bytes(), before_fetch)

    def test_checkout_flattened_local_tag_still_verifies_remote_annotation(self):
        tag_object = self.publish_tag()
        # Reproduce the exact refspec observed in the failed tag workflow.
        self.git(self.repo, "fetch", "--no-tags", "origin", f"+{self.commit}:refs/tags/{self.tag}")
        self.assertEqual(self.git(self.repo, "cat-file", "-t", self.tag), "commit")
        self.assertEqual(self.verify()["tag_object"], tag_object)
        self.assertEqual(self.git(self.repo, "cat-file", "-t", self.tag), "commit")
        self.assertEqual(self.git(self.remote, "rev-parse", f"refs/tags/{self.tag}"), tag_object)
        self.assert_no_verification_refs()

    def test_missing_local_tag_does_not_prevent_remote_validation(self):
        tag_object = self.publish_tag()
        self.git(self.repo, "update-ref", "-d", f"refs/tags/{self.tag}", tag_object)
        self.assertEqual(self.verify()["tag_object"], tag_object)
        self.assertEqual(self.git(self.repo, "tag", "--list"), "")

    def test_cli_validates_the_remote_tag_from_an_explicit_checkout(self):
        tag_object = self.publish_tag()
        self.git(self.repo, "fetch", "--no-tags", "origin", f"+{self.commit}:refs/tags/{self.tag}")
        result = subprocess.run([sys.executable, str(ROOT / "scripts/check-customer-release-tag.py"),
            "--repository", str(self.repo), "--tag", self.tag, "--commit", self.commit],
            text=True, capture_output=True, timeout=30, check=True)
        self.assertEqual(json.loads(result.stdout)["tag_object"], tag_object)
        self.assert_no_verification_refs()

    def test_lightweight_remote_tag_is_rejected(self):
        self.publish_tag()
        # A valid local annotation must not conceal an invalid remote ref.
        self.git(self.remote, "update-ref", f"refs/tags/{self.tag}", self.commit)
        self.assertEqual(self.git(self.repo, "cat-file", "-t", self.tag), "tag")
        with self.assertRaisesRegex(GATE.ReleaseTagError, "must be annotated"):
            self.verify()
        self.assert_no_verification_refs()

    def test_different_remote_commit_is_rejected(self):
        self.git(self.repo, "commit", "--allow-empty", "-m", "other source")
        other = self.git(self.repo, "rev-parse", "HEAD")
        self.publish_tag(target=other)
        self.git(self.repo, "checkout", "--detach", self.commit)
        with self.assertRaisesRegex(GATE.ReleaseTagError, "different source commit"):
            self.verify()
        self.assert_no_verification_refs()

    def test_wrong_annotated_tag_name_is_rejected(self):
        self.publish_tag(name="v9.9.9")
        with self.assertRaisesRegex(GATE.ReleaseTagError, "unexpected identity"):
            self.verify()
        self.assert_no_verification_refs()

    def test_missing_remote_tag_does_not_trust_local_annotation(self):
        self.git(self.repo, "tag", "-a", self.tag, "-m", "Local only")
        with self.assertRaisesRegex(GATE.ReleaseTagError, "fetch failed"):
            self.verify()
        self.assert_no_verification_refs()

    def test_unavailable_remote_fails_closed_without_changing_local_tag(self):
        tag_object = self.publish_tag()
        self.git(self.repo, "remote", "set-url", "origin", str(self.root / "missing.git"))
        with self.assertRaisesRegex(GATE.ReleaseTagError, "fetch failed"):
            self.verify()
        self.assertEqual(self.git(self.repo, "rev-parse", self.tag), tag_object)
        self.assert_no_verification_refs()

    def test_expected_source_and_version_must_match_checkout(self):
        with self.assertRaisesRegex(GATE.ReleaseTagError, "Checkout does not match"):
            GATE.verify(self.repo, self.tag, "0" * 40)
        with self.assertRaisesRegex(GATE.ReleaseTagError, "package version"):
            GATE.verify(self.repo, "v1.2.4", self.commit)

    def test_invalid_refs_fail_before_git_or_network(self):
        with patch.object(GATE, "git") as git:
            for tag in ("main", "--upload-pack=bad", "v1.2.3\n", "v1.2.3/other"):
                with self.subTest(tag=tag), self.assertRaises(GATE.ReleaseTagError):
                    GATE.verify(self.repo, tag, self.commit)
            with self.assertRaises(GATE.ReleaseTagError):
                GATE.verify(self.repo, self.tag, "HEAD")
            git.assert_not_called()

    def test_tag_workflow_uses_remote_validation_and_retains_other_gates(self):
        workflow = (ROOT / ".github/workflows/customer-release.yml").read_text()
        self.assertLess(workflow.index('SOURCE_SHA="$(git rev-parse HEAD)"'),
                        workflow.index('python3 scripts/check-customer-release-tag.py'))
        self.assertIn('python3 scripts/check-customer-release-tag.py', workflow)
        self.assertIn('--tag "$GITHUB_REF_NAME" --commit "$SOURCE_SHA"', workflow)
        self.assertNotIn('test "$(git cat-file -t "$GITHUB_REF_NAME")" = tag', workflow)
        self.assertIn('git merge-base --is-ancestor HEAD origin/main', workflow)
        self.assertIn('r["event"] == "push" and r["head_branch"] == "main"', workflow)


if __name__ == "__main__":
    unittest.main()
