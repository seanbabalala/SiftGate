#!/usr/bin/env python3
"""Collect exact native lifecycle acceptance receipts before publishing an image."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import platform
import subprocess
import sys
import tempfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"deploy/customer"))
import siftgate as kit
import siftgate_release as release


def module(name,path):
    spec=importlib.util.spec_from_file_location(name,path); value=importlib.util.module_from_spec(spec); spec.loader.exec_module(value); return value


baseline=module("baseline_fetch",ROOT/"scripts/fetch-customer-baseline.py")


def assert_checks(value,expected,key="checks"):
    release.require(type(value) is dict and isinstance(value.get(key),list) and set(expected)<=set(value[key]),"native_acceptance_receipt_incomplete")


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--image",required=True); parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args(); commit=subprocess.check_output(["git","rev-parse","HEAD"],cwd=ROOT,text=True).strip()
    subprocess.run(["git","diff","--exit-code","HEAD","--"],cwd=ROOT,check=True,stdout=subprocess.DEVNULL)
    release.require(not subprocess.check_output(["git","ls-files","--others","--exclude-standard"],cwd=ROOT,text=True).strip(),"clean_committed_source_required")
    release.require(not args.output.exists(),"acceptance_output_exists"); args.output.mkdir(parents=True,mode=0o700)
    scratch=ROOT/".local-dev"; scratch.mkdir(exist_ok=True)
    private=Path(tempfile.mkdtemp(prefix="native-acceptance-",dir=scratch)).resolve()
    info=json.loads(kit.run(["docker","image","inspect",args.image],output_limit=1024*1024))[0]
    architecture=info["Architecture"]; host={"x86_64":"amd64","aarch64":"arm64"}.get(platform.machine(),platform.machine())
    release.require(info["Os"]=="linux" and architecture==host and architecture in ("amd64","arm64"),"native_runner_required")
    class ImageHost:
        meta={"engine_arch":architecture}
        def docker(self,*arguments,**kwargs): return kit.run(["docker",*arguments],**kwargs)
    target=release.inspect_local_image(ImageHost(),args.image,private)
    receipts={}
    def run(name,script,*arguments):
        log=args.output/(name+".log")
        with log.open("w") as file:
            result=subprocess.run([sys.executable,str(ROOT/"scripts"/script),*map(str,arguments)],cwd=ROOT,stdout=file,stderr=file,timeout=1800)
        if result.returncode:
            # These are deliberately synthetic fixtures; never upload their
            # config/data/SSH-key directories. Keep bounded command diagnostics.
            print(log.read_text()[-16000:],file=sys.stderr)
        release.require(result.returncode==0,"native_"+name.replace("-","_")+"_failed")
        raw=log.read_text(); offset=raw.find("{")
        release.require(offset>=0,"native_receipt_missing")
        value=json.JSONDecoder().raw_decode(raw[offset:])[0]
        receipts[name]=value
        return value
    fresh=run("install","smoke-customer-install.py","--image",args.image)
    assert_checks(fresh,{"fresh-init","http-readiness","wal-aware-backup","independent-restore","restored-session-revocation","key-log-preservation"},"passed")
    independent=run("control","smoke-customer-control.py","--image",args.image,"--output",private)
    assert_checks(independent,{"separate_control_identity","control_http_during_gateway_stop","durable_queued_job_across_control_restart","reviewed_agent_plan_not_executable","reconciliation_never_reexecutes"})
    restored=run("vault","smoke-customer-vault.py","--image",args.image,"--output",private)
    assert_checks(restored,{"backup_integrity","independent_directory_restore","network_none","http_readiness","key_log_and_configuration_match","cleanup_verified"})
    portable=run("portable","smoke-customer-portable-restore.py","--image",args.image,"--output",private)
    assert_checks(portable,{"tag_free_image_import","config_digest_bound_restore","frozen_backup_kit","business_key_preserved"})
    release.require(portable["config_digest"]==target["config_digest"],"tested_image_changed")
    host_operator=run("operator","smoke-customer-operator.py","--image",args.image)
    assert_checks(host_operator,{"durable-stage-journal","read-only-instance-bound-bridge","api-key-preserved","queued-job-survives-worker-restart"},"passed")
    contract=json.loads((ROOT/"deploy/customer/release-contract.json").read_text()); source_digests={}; sources={}
    for record in contract["source_releases"]:
        tools=baseline.fetch(record,private/("baseline-"+record["version"]))
        kit.run(["docker","pull",record["image"]],timeout=1200,output_limit=2*1024*1024)
        common=["--source-image",record["image"],"--image",args.image,"--baseline-kit",tools,"--output",private]
        migrated=run("upgrade-"+record["version"],"smoke-customer-upgrade.py",*common)
        assert_checks(migrated,{"actual_cross_version_upgrade","actual_config_digest_compatibility","paired_image_and_host_kit","business_database_unchanged","existing_management_session_preserved","release_notice_api_available"})
        release.require(migrated["source_version"]==record["version"] and migrated["target_config_digest"]==target["config_digest"],"cross_version_receipt_mismatch")
        fleet=run("fleet-"+record["version"],"smoke-customer-fleet.py",*common)
        assert_checks(fleet,{"real_pinned_ssh_rpc","wrong_host_key_refused_before_agent","offline_import_and_layer_verification","actual_canary_upgrade","manual_next_wave","pause_prevents_dispatch","cancel_preserves_remaining_source","failure_threshold_prevents_later_targets"})
        release.require(fleet["target_config_digest"]==target["config_digest"] and fleet["source_config_digest"]==migrated["source_config_digest"],"fleet_receipt_mismatch")
        recovered=run("source-recovery-"+record["version"],"smoke-customer-legacy-recovery.py","--image",record["image"],"--baseline-kit",tools,"--output",private)
        assert_checks(recovered,{"actual_source_release","management_sessions_revoked","old_jwt_rejected_after_restore","same_password_works","business_key_preserved"})
        release.require(recovered["source_version"]==record["version"],"source_recovery_version_mismatch")
        expected_identity="managed" if release.version(record["version"])>=(2,12,0) else "legacy"
        release.require(recovered["source_identity_mode"]==expected_identity and migrated["source_identity_mode"]==expected_identity,"source_identity_receipt_mismatch")
        sources[record["version"]]=record["image"]; source_digests[record["version"]]=migrated["source_config_digest"]
    final=release.inspect_local_image(ImageHost(),args.image,private)
    release.require(final==target,"candidate_changed_during_acceptance")
    receipt={"architecture":architecture,"commit":commit,"runtime_image_id":target["runtime_image_id"],"config_digest":target["config_digest"],
        "source_releases":sources,"source_config_digests":source_digests,
        "checks":["fresh_install","cross_version_upgrade","restore_verification","operator_durability","offline_image","fleet_governance"],
        "native_runner":True,"publisher_signature_tested":False,"fleet_fixture_scope":"separate SSH host keys; shared physical host/engine"}
    kit.write_json(args.output/(architecture+".json"),receipt)
    kit.write_json(args.output/"receipts.json",receipts)
    print(json.dumps(receipt,indent=2))


if __name__=="__main__": main()
