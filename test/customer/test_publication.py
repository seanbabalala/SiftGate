"""Release orchestration boundaries; GitHub transport and crypto are simulated."""
import copy
import hashlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch

ROOT=Path(__file__).resolve().parents[2]
sys.path.insert(0,str(ROOT/"deploy/customer"))
import siftgate_release as release
import test_release as manifests


def module(name,filename):
    spec=importlib.util.spec_from_file_location(name,ROOT/"scripts"/filename); value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


upload=module("quad_upload","upload-customer-assets.py")
resume=module("proof_resume","prepare-customer-attestation.py")
public=module("public_verify","verify-public-customer-release.py")
baseline=module("baseline_verify","fetch-customer-baseline.py")


class SignedReleaseTests(unittest.TestCase):
    def setUp(self):
        self.temp=tempfile.TemporaryDirectory(); self.root=Path(self.temp.name).resolve()
        self.tag="v2.12.0"; self.names=upload.names_for(self.tag); self.remote={}; self.uploads=[]; self.draft=True
        archive=self.root/self.names[0]; archive.write_bytes(b"synthetic installer")
        (self.root/self.names[1]).write_text(upload.sha256(archive)+"  "+archive.name+"\n")
        self.manifest=manifests.fixture(); self.manifest["installer"].update(sha256=upload.sha256(archive),bytes=archive.stat().st_size)
        (self.root/self.names[2]).write_bytes(release.canonical(self.manifest))
        (self.root/self.names[3]).write_bytes(b"synthetic signature bundle")
        self.proof=patch.object(release,"verify_release",side_effect=self.verifier); self.proof.start()
    def tearDown(self): self.proof.stop(); self.temp.cleanup()
    def verifier(self,manifest,bundle,**kwargs):
        if Path(bundle).read_bytes()!=b"synthetic signature bundle": raise release.ReleaseError("publisher_verification_failed")
        return release.VerifiedRelease(self.manifest,release.sha256(manifest))
    def gh(self,*args):
        if args[1]=="view": return json.dumps({"assets":[{"name":name} for name in self.remote],"isDraft":self.draft})
        if args[1]=="download":
            name=args[args.index("--pattern")+1]; directory=Path(args[args.index("--dir")+1]); (directory/name).write_bytes(self.remote[name]); return ""
        if args[1]=="upload":
            file=Path(args[3]); self.assertNotIn(file.name,self.remote); self.assertNotIn("--clobber",args)
            self.remote[file.name]=file.read_bytes(); self.uploads.append(file.name); return ""
        self.fail("Unexpected GitHub mutation")

    def test_new_versions_require_exact_signed_quartet_and_verify_before_network(self):
        with patch.object(upload,"gh",side_effect=self.gh):
            upload.synchronize(release.REPOSITORY,self.tag,self.root)
            upload.synchronize(release.REPOSITORY,self.tag,self.root,verify_only=True)
        self.assertEqual(self.uploads,self.names)
        (self.root/self.names[-1]).unlink()
        with patch.object(upload,"gh") as gh,self.assertRaises(ValueError): upload.synchronize(release.REPOSITORY,self.tag,self.root)
        gh.assert_not_called()

    def test_invalid_signature_or_installer_pair_refuses_all_uploads(self):
        (self.root/self.names[-1]).write_bytes(b"invalid")
        with patch.object(upload,"gh") as gh,self.assertRaises(release.ReleaseError): upload.synchronize(release.REPOSITORY,self.tag,self.root)
        gh.assert_not_called()
        (self.root/self.names[-1]).write_bytes(b"synthetic signature bundle")
        changed=copy.deepcopy(self.manifest); changed["installer"]["sha256"]="0"*64
        (self.root/self.names[2]).write_bytes(release.canonical(changed))
        with patch.object(upload,"gh") as gh,self.assertRaises(ValueError): upload.synchronize(release.REPOSITORY,self.tag,self.root)
        gh.assert_not_called()

    def test_one_different_existing_asset_prevents_every_missing_upload(self):
        self.remote[self.names[2]]=b"different manifest"
        with patch.object(upload,"gh",side_effect=self.gh),self.assertRaises(ValueError): upload.synchronize(release.REPOSITORY,self.tag,self.root)
        self.assertFalse(self.uploads)

    def test_resume_uses_existing_verified_bundle_without_resigning_or_overwriting(self):
        self.remote={name:(self.root/name).read_bytes() for name in self.names}
        (self.root/self.names[-1]).unlink()
        with patch.object(resume.assets,"gh",side_effect=self.gh): reused=resume.prepare(release.REPOSITORY,self.tag,self.root)
        self.assertTrue(reused); self.assertEqual((self.root/self.names[-1]).read_bytes(),self.remote[self.names[-1]])
        self.assertFalse(self.uploads)

    def test_bad_saved_proof_never_enters_local_release_directory(self):
        (self.root/self.names[-1]).unlink(); self.remote[self.names[-1]]=b"invalid"
        with patch.object(resume.assets,"gh",side_effect=self.gh),self.assertRaises(release.ReleaseError): resume.prepare(release.REPOSITORY,self.tag,self.root)
        self.assertFalse((self.root/self.names[-1]).exists())

    def test_existing_public_release_cannot_be_silently_repaired(self):
        self.draft=False
        with patch.object(resume.assets,"gh",side_effect=self.gh),self.assertRaisesRegex(ValueError,"public release is incomplete"):
            resume.prepare(release.REPOSITORY,self.tag,self.root)

    def test_anonymous_verification_downloads_all_bytes_and_clears_gh_identity(self):
        downloads=[]; environments=[]
        def fetch(url,path,limit):
            name=url.rsplit("/",1)[1]; downloads.append(name); path.write_bytes((self.root/name).read_bytes())
        def verify(manifest,bundle,runner):
            runner(["gh","version"],timeout=1); return self.verifier(manifest,bundle)
        with patch.object(public,"download",side_effect=fetch),patch.object(public.kit,"run",side_effect=lambda *args,**kwargs:environments.append(kwargs["env"])), \
                patch.object(public.release,"verify_release",side_effect=verify),patch.dict(os.environ,{"GH_TOKEN":"synthetic-private-token","GITHUB_TOKEN":"synthetic-ci-token"}):
            result=public.verify(self.tag,self.root)
        self.assertEqual(downloads,self.names); self.assertTrue(result["anonymous_assets_verified"])
        self.assertNotIn("GH_TOKEN",environments[0]); self.assertNotIn("GITHUB_TOKEN",environments[0]); self.assertIn("gh-empty",environments[0]["GH_CONFIG_DIR"])

    def test_public_byte_mismatch_fails_before_signature_claim(self):
        with patch.object(public,"download",side_effect=lambda url,path,limit:path.write_bytes(b"changed")), \
                patch.object(public.release,"verify_release") as verifier,self.assertRaises(release.ReleaseError):
            public.verify(self.tag,self.root)
        verifier.assert_not_called()


class BaselinePinTests(unittest.TestCase):
    def test_pinned_archive_and_nested_release_identity_are_both_required(self):
        with tempfile.TemporaryDirectory() as directory:
            root=Path(directory).resolve(); source=root/"source.tar.gz"
            nested={"format":"siftgate-customer-release-v1","version":"v2.11.7","commit":"a"*40,"image":release.REGISTRY+"@sha256:"+"b"*64}
            with tarfile.open(source,"w:gz") as tar:
                data=release.canonical(nested); member=tarfile.TarInfo("siftgate-v2.11.7/release.json"); member.size=len(data); tar.addfile(member,io.BytesIO(data))
            record={"version":"2.11.7","source_commit":"a"*40,"image":nested["image"],"installer_sha256":release.sha256(source)}
            fetcher=lambda url,destination,limit:destination.write_bytes(source.read_bytes())
            extracted=baseline.fetch(record,root/"valid",fetcher)
            self.assertEqual(json.loads((extracted/"release.json").read_text()),nested)
            for changed in ({**record,"installer_sha256":"0"*64},{**record,"source_commit":"c"*40}):
                with self.assertRaises(release.ReleaseError): baseline.fetch(changed,root/("bad-"+changed["installer_sha256"][:3]+changed["source_commit"][:3]),fetcher)


if __name__=="__main__": unittest.main()
