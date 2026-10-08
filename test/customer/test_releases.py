"""Cache/discovery/offline orchestration tests with a simulated external verifier."""
import hashlib
import json
from pathlib import Path
import shutil
import sys
import unittest
import urllib.error

sys.path.insert(0, str(Path(__file__).resolve().parents[2] / "deploy/customer"))
import siftgate as kit
import siftgate_release as trust
import siftgate_releases as updates
import test_release as fixtures


class CacheTests(unittest.TestCase):
    def setUp(self):
        self.fixture = fixtures.ReleaseFilesTests(); self.fixture.setUp()
        self.root = self.fixture.root
        verified, self.image = self.fixture.image_archive()
        self.fixture.manifest = verified.manifest
        verified, archive = self.fixture.installer()
        self.manifest = verified.manifest
        self.payloads = {"release.json": trust.canonical(self.manifest), "release.sigstore.jsonl": b"unit verifier fixture",
                         "installer.tar.gz": archive.read_bytes()}
        self.digest = hashlib.sha256(self.payloads["release.json"]).hexdigest()
        self.calls = []; self.downloads = []; self.refuse = False
        self.cache = updates.ReleaseCache(self.root / "cache", runner=self.runner, fetcher=self.fetcher)
    def tearDown(self): self.fixture.tearDown()
    def runner(self, args, **kwargs):
        self.calls.append(args)
        if args == ["gh", "version"]: return "gh version 2.86.0"
        if self.refuse: raise kit.OperatorError("synthetic private verifier output")
        digest = hashlib.sha256(Path(args[3]).read_bytes()).hexdigest()
        return json.dumps([{"verificationResult":{"statement":{"predicateType":"https://slsa.dev/provenance/v1","subject":[{"digest":{"sha256":digest}}]}}}])
    def fetcher(self, url, destination, limit):
        self.downloads.append(url)
        destination.write_bytes(self.payloads[destination.name])
    def pin(self):
        root = self.root / "out-of-band-root.jsonl"; root.write_bytes(b"unit-only out of band root")
        return self.cache.pin_trusted_root(root, hashlib.sha256(root.read_bytes()).hexdigest(), confirmed=True)
    def offline(self):
        source = self.root / "offline"; source.mkdir(mode=0o700)
        for name, raw in self.payloads.items(): (source/name).write_bytes(raw)
        shutil.copyfile(self.image, source/"image.tar")
        (source/"offline.json").write_text(json.dumps({"format":"siftgate-offline-v1","architecture":"arm64","release_digest":self.digest}))
        return source
    def install(self):
        actions = []
        image_id = "sha256:" + "1" * 64
        image_archive = self.image
        class FakeInstall:
            meta = {"engine_arch":"arm64","engine_id":"synthetic-engine"}
            def check_engine(self): actions.append("engine")
            def docker(self, *args, **kwargs):
                actions.append(args)
                if args[:2] == ("image", "load"): return "Loaded image ID: " + image_id
                if args[:2] == ("image", "inspect"): return json.dumps([{"Id":image_id,"Os":"linux","Size":1024}])
                if args[:2] == ("image", "save"): shutil.copyfile(image_archive,args[args.index("--output")+1])
                return ""
            def resolve_image(self, reference, local=False):
                actions.append(("resolve",reference,local)); return image_id
        return FakeInstall(), actions

    def test_fetch_is_fixed_origin_verified_idempotent_and_never_installs(self):
        first = self.cache.fetch("2.12.0"); second = self.cache.fetch("2.12.0")
        self.assertEqual(first,second); self.assertEqual(first.name,self.digest)
        verified,path = self.cache.get(self.digest)
        self.assertEqual(verified.manifest["version"],"2.12.0"); self.assertEqual(path,first)
        self.assertTrue(all(url.startswith(updates.DOWNLOAD+"v2.12.0/") for url in self.downloads))
        self.assertTrue(all(args[0]=="gh" for args in self.calls))
        self.assertEqual(len([p for p in self.cache.root.iterdir() if p.is_dir()]),1)

    def test_unsigned_changed_and_wrong_requested_release_do_not_stage(self):
        for reason in ("signature","installer","version"):
            with self.subTest(reason=reason):
                original = dict(self.payloads)
                if reason=="signature": self.refuse=True
                if reason=="installer": self.payloads["installer.tar.gz"]+=b"changed"
                with self.assertRaises(trust.ReleaseError): self.cache.fetch("2.12.1" if reason=="version" else "2.12.0")
                self.assertFalse(any(p.is_dir() for p in self.cache.root.iterdir()))
                self.refuse=False; self.payloads=original

    def test_discovery_is_not_signature_verification_or_deployment(self):
        names=["siftgate-v2.12.0"+suffix for suffix in ("-release.json","-release.sigstore.jsonl","-install.tar.gz")]
        self.payloads["releases.json"]=json.dumps([
          {"tag_name":"v2.12.0","draft":False,"prerelease":False,"assets":[{"name":name} for name in names]},
          {"tag_name":"v2.11.7","draft":False,"prerelease":False,"assets":[]},
          {"tag_name":"v9.0.0","draft":True,"prerelease":False,"assets":[]}]).encode()
        result=self.cache.discover("2.11.7")
        self.assertEqual(len(result["releases"]),2)
        self.assertTrue(result["releases"][0]["managed_metadata_available"])
        self.assertFalse(result["releases"][0]["publisher_verified"])
        self.assertFalse(result["automatic_install"]); self.assertEqual(self.calls,[])

    def test_public_feed_fallback_never_claims_assets_or_signatures_verified(self):
        def fetch(url,path,limit):
            if path.name=="releases.json": raise urllib.error.HTTPError(url,403,"rate limited",{},None)
            path.write_text('<feed xmlns="http://www.w3.org/2005/Atom"><entry><link rel="alternate" href="https://github.com/seanbabalala/SiftGate/releases/tag/v2.12.0"/><content type="html">&lt;a href="https://github.com/seanbabalala/SiftGate/releases/tag/v9.9.9"&gt;not an entry&lt;/a&gt;</content></entry></feed>')
        self.cache.fetcher=fetch
        result=self.cache.discover("2.11.7")
        self.assertEqual(result["discovery_source"],"public_feed")
        self.assertEqual([item["version"] for item in result["releases"]],["2.12.0"])
        self.assertIsNone(result["releases"][0]["managed_metadata_available"])
        self.assertFalse(result["releases"][0]["publisher_verified"])
        self.assertEqual(self.calls,[])

    def test_download_policy_rejects_local_network_credentials_and_other_origins(self):
        for url in ("http://github.com/file","https://127.0.0.1/file","https://attacker.invalid/file",
                    "https://secret@github.com/file","https://github.com:2099/file","https://github.com:bad/file"):
            with self.subTest(url=url), self.assertRaises(trust.ReleaseError): updates.check_url(url)
        updates.check_url("https://release-assets.githubusercontent.com/path?signature=public-download")

    def test_trust_initialization_is_host_confirmed_and_never_accepted_from_package(self):
        root=self.root/"out-of-band"; root.write_bytes(b"unit root"); digest=hashlib.sha256(root.read_bytes()).hexdigest()
        with self.assertRaises(trust.ReleaseError): self.cache.pin_trusted_root(root,digest)
        self.cache.pin_trusted_root(root,digest,confirmed=True)
        with self.assertRaises(trust.ReleaseError): self.cache.pin_trusted_root(root,digest,confirmed=True)
        source=self.offline(); (source/"trusted-root.jsonl").write_bytes(b"attacker root")
        install,actions=self.install()
        with self.assertRaises(trust.ReleaseError): self.cache.import_offline(source,install)
        self.assertEqual(actions,[])

    def test_offline_import_requires_preexisting_trust_and_only_preloads_image(self):
        source=self.offline(); install,actions=self.install()
        with self.assertRaises(trust.ReleaseError): self.cache.import_offline(source,install)
        self.assertEqual(actions,[]); self.pin()
        result=self.cache.import_offline(source,install)
        self.assertFalse(result["restarted"]); self.assertFalse(result["approved"])
        self.assertEqual(result["release_digest"],self.digest)
        commands=[item for item in actions if type(item) is tuple]
        self.assertEqual(commands[0][:2],("image","load"))
        self.assertEqual(commands[1][:2],("image","inspect"))
        self.assertEqual(commands[2][:2],("image","save"))
        self.assertEqual(self.downloads,[])
        self.assertTrue(any("--custom-trusted-root" in args for args in self.calls))

    def test_bad_offline_layers_refuse_docker_load(self):
        source=self.offline(); self.pin()
        verified,image=self.fixture.image_archive("layer"); shutil.copyfile(image,source/"image.tar")
        install,actions=self.install()
        with self.assertRaises(trust.ReleaseError): self.cache.import_offline(source,install)
        self.assertNotIn("load",str(actions))

    def test_cached_files_are_reverified_not_trusted_from_receipt(self):
        path=self.cache.fetch("2.12.0")
        (path/"observation.json").write_text('{"publisher_verified":true}')
        self.refuse=True
        with self.assertRaises(trust.ReleaseError): self.cache.get(self.digest)


if __name__ == "__main__": unittest.main()
