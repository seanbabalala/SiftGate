#!/usr/bin/env python3
"""Authenticated-transport agent RPC over stdin/stdout, never a gateway HTTP API.

Run locally as the installation owner or via a pinned SSH connection. Paths,
Docker arguments, executables and shell commands are not accepted in RPC JSON.
"""
import argparse
import json
import os
from pathlib import Path
import re
import sys
import time
import uuid

sys.dont_write_bytecode=True
import siftgate as kit
import siftgate_operator as op
import siftgate_release as release
from siftgate_releases import ReleaseCache, OFFLINE_FILES, private_directory, copy_regular
from siftgate_tools import bootstrap, delegate
from siftgate_vault import Vault

PROTOCOL = "siftgate-agent-rpc-v1"


def require(value, code):
    if not value: raise op.OperatorFailure(code)


def fields(value, names):
    require(type(value) is dict and set(value)==set(names),"invalid_rpc_arguments")


def public_operation(job):
    value=op.public_job(job)
    verified=job["plan"].get("verified_release")
    value["publisher_verified"]=bool(verified)
    value["approve_before"]=job["plan"]["approve_before"]
    value["control_review"]=job.get("control_review")
    if verified:
        value["release"]={"digest":verified["digest"],"source_version":verified["source_version"],"target_version":verified["version"],
                          "source_config_digest":verified["source_config_digest"],"target_config_digest":verified["target_config_digest"]}
    return value


def public_drill(job):
    return {"id":job["id"],"operation":"verify_restore","status":job["status"],"stage":job["stage"],"plan_digest":job["plan_digest"],
            "backup_id":job["plan"]["backup_id"],"backup_digest":job["plan"]["backup_digest"],"created_at":job["created_at"],
            "updated_at":job["updated_at"],"error_code":job["error_code"],"restore_drill_verified":job["restore_drill_verified"],
            "cleanup_confirmed":job["cleanup_confirmed"],"events":job["events"],"evidence":job["evidence"],"cutover_selected":False,
            "approve_before":op.timestamp(op.parse_time(job["created_at"])+900),"control_review":job.get("control_review")}


class Agent:
    def __init__(self, directory):
        self.install=kit.Install.load(directory)

    def operator(self): return op.Operator(self.install.root)

    def cache(self):
        self.operator()  # Explicit host enrollment, never inferred from a web request.
        return ReleaseCache(self.install.root/"operator/releases")

    def observe(self):
        self.install.check_engine()
        current=self.install.container()
        tools=kit.tool_directory(self.install.root,self.install.meta)
        matching=all((tools/name).is_file() and release.sha256(tools/name)==release.sha256(Path(__file__).resolve().parent/name) for name in kit.KIT_FILES)
        version=self.install.meta.get("app_version")
        if not version and current:
            label=current["Config"].get("Labels",{}).get("org.opencontainers.image.version","").lstrip("v")
            if re.fullmatch(r"\d+\.\d+\.\d+",label): version=label
        return {"protocol":PROTOCOL,"installation_id":self.install.meta["id"],"engine_id":self.install.meta["engine_id"],
                "architecture":self.install.meta["engine_arch"],"app_version":version or "unknown", "kit_protocol":2 if matching else self.install.meta.get("kit_protocol",1),
                "runtime_image_id":current["Image"] if current else self.install.meta["image"],
                "running":bool(current and current["State"]["Running"]),
                "live":kit.local_probe(self.install.meta["port"],"live"),"ready":kit.local_probe(self.install.meta["port"],"ready"),
                "operator_enrolled":(self.install.root/"operator/policy.json").is_file(),"requires_host_bootstrap":not matching,
                "host_tools_origin":self.install.meta.get("host_tools",{}).get("origin","original_kit"),"observed_at":op.timestamp()}

    def offline_packages(self):
        parent=self.install.root/"operator/inbox"
        if not parent.exists(): return []
        result=[]
        for folder in parent.iterdir():
            if not re.fullmatch(r"offline-[a-f0-9]{32}",folder.name): continue
            require(len(result)<20,"offline_inbox_retention_required")
            try:
                manifest=release.validate_manifest(release.json_bytes(release.read_bytes(folder/"release.json",release.MAX_MANIFEST)))
                result.append({"id":folder.name,"version":manifest["version"],"publisher_verified":False})
            except Exception:
                result.append({"id":folder.name,"version":None,"publisher_verified":False,"error_code":"unreadable_offline_package"})
        return result

    def handle(self, request):
        fields(request,("format","installation_id","request_id","command","arguments"))
        require(request["format"]==PROTOCOL and isinstance(request["request_id"],str) and re.fullmatch(r"[a-zA-Z0-9_-]{8,80}",request["request_id"]),"invalid_rpc_request")
        command=request["command"]; args=request["arguments"]
        require(request["installation_id"]==self.install.meta["id"] or (command=="observe" and request["installation_id"] is None),"rpc_installation_mismatch")
        if command=="observe":
            fields(args,()); return self.observe()
        if command=="discover_releases":
            fields(args,("current_version",)); return self.cache().discover(args["current_version"])
        if command=="fetch_release":
            fields(args,("version",)); cache=self.cache(); location=cache.fetch(args["version"])
            verified,_=cache.get(location.name)
            return {"release_digest":verified.digest,"manifest":verified.manifest,"publisher_verified":True,"deployed":False}
        if command=="list_releases":
            fields(args,()); cache=self.cache(); result=[]
            for folder in cache.root.iterdir():
                if not release.SHA.fullmatch(folder.name): continue
                require(len(result)<100,"release_cache_retention_required")
                # Historical local observation, not fresh signature verification.
                try:
                    observation=release.json_bytes(release.read_bytes(folder/"observation.json",8192))
                    result.append({"release_digest":folder.name,"version":observation["version"],"verified_at":observation["verified_at"],"rechecked":False})
                except Exception: result.append({"release_digest":folder.name,"version":None,"rechecked":False})
            return result
        if command=="inspect_release":
            fields(args,("release_digest","offline")); require(type(args["offline"]) is bool,"invalid_offline_mode")
            verified,_=self.cache().get(args["release_digest"],offline=args["offline"])
            return {"release_digest":verified.digest,"manifest":verified.manifest,"publisher_verified":True,"deployed":False}
        if command=="list_offline_packages":
            fields(args,()); return self.offline_packages()
        if command=="import_offline":
            fields(args,("package_id",)); require(isinstance(args["package_id"],str) and re.fullmatch(r"offline-[a-f0-9]{32}",args["package_id"]),"invalid_offline_package")
            return self.cache().import_offline(self.install.root/"operator/inbox"/args["package_id"],self.install)
        if command=="plan_backup":
            fields(args,()); return public_operation(self.operator().plan("backup",request["request_id"]))
        if command=="plan_upgrade":
            fields(args,("release_digest","offline")); require(type(args["offline"]) is bool,"invalid_offline_mode")
            return public_operation(self.operator().plan_verified(args["release_digest"],request["request_id"],offline=args["offline"]))
        if command=="vault_catalog":
            fields(args,())
            return Vault(self.install,create=False).catalog()
        if command=="vault_records":
            fields(args,())
            if not (self.install.root/"vault").exists(): return []
            return [public_drill(job) for job in Vault(self.install).records()]
        if command=="plan_restore_verification":
            fields(args,("backup_id","manifest_digest"))
            return public_drill(Vault(self.install).plan(args["backup_id"],args["manifest_digest"],request["request_id"]))
        if command=="reconcile_job":
            fields(args,("plan_id","plan_digest","cancel_pending"))
            require(args["cancel_pending"] is True and isinstance(args["plan_id"],str),"reconciliation_confirmation_required")
            if args["plan_id"].startswith("rv-"):
                return public_drill(Vault(self.install).reconcile_for_control(args["plan_id"],args["plan_digest"]))
            return public_operation(self.operator().reconcile_for_control(args["plan_id"],args["plan_digest"]))
        if command=="review_job":
            fields(args,("plan_id","plan_digest","review"))
            require(isinstance(args["plan_id"],str),"invalid_plan_id")
            if args["plan_id"].startswith("rv-"):
                return public_drill(Vault(self.install).record_control_review(args["plan_id"],args["plan_digest"],args["review"]))
            operator=self.operator(); job=operator.store.get(args["plan_id"])
            require(job["plan"]["operation"]!="upgrade" or job["plan"].get("verified_release"),"verified_release_required")
            return public_operation(operator.record_control_review(args["plan_id"],args["plan_digest"],args["review"]))
        if command=="get_job":
            fields(args,("plan_id",)); require(isinstance(args["plan_id"],str),"invalid_plan_id")
            if args["plan_id"].startswith("rv-"):
                vault=Vault(self.install); job=vault.get(args["plan_id"])
                if job["status"]=="running":
                    try: vault.reconcile_interrupted()
                    except op.OperatorFailure as error:
                        if str(error)!="operator_busy": raise
                return public_drill(vault.get(args["plan_id"]))
            operator=self.operator(); job=operator.store.get(args["plan_id"])
            if job["status"]=="running":
                try:
                    with op.file_lock(operator.home/"worker.lock"): operator.reconcile_interrupted()
                except op.OperatorFailure as error:
                    if str(error)!="operator_busy": raise
            return public_operation(operator.store.get(args["plan_id"]))
        if command=="approve_job":
            fields(args,("plan_id","plan_digest","not_before","not_after","accept_downtime","control_job_id"))
            require(type(args["accept_downtime"]) is bool,"invalid_approval")
            operator=self.operator(); job=operator.store.get(args["plan_id"])
            require(job["plan"]["operation"]!="upgrade" or job["plan"].get("verified_release"),"verified_release_required")
            require(job.get("control_review") and job["control_review"]["control_job_id"]==args["control_job_id"],"recorded_control_review_required")
            # Repeated delivery is an observation, not a new approval/window.
            if job["status"]!="planned":
                approval=job["approval"]
                require(job["plan_digest"]==args["plan_digest"] and approval and approval["not_before"]==op.timestamp(op.parse_time(args["not_before"])) and
                        approval["not_after"]==op.timestamp(op.parse_time(args["not_after"])) and approval["accepted_downtime"]==args["accept_downtime"] and
                        approval.get("control_job_id")==args["control_job_id"],"approval_replay_conflict")
                return public_operation(job)
            return public_operation(operator.approve(args["plan_id"],args["plan_digest"],op.parse_time(args["not_before"]),
                                    op.parse_time(args["not_after"]),args["accept_downtime"],False,control_job_id=args["control_job_id"]))
        if command=="execute_job":
            fields(args,("plan_id","plan_digest","control_job_id")); operator=self.operator(); job=operator.store.get(args["plan_id"])
            require(job["plan_digest"]==args["plan_digest"],"execution_plan_mismatch")
            require(job["plan"]["operation"]!="upgrade" or job["plan"].get("verified_release"),"verified_release_required")
            require(job.get("control_review") and job["control_review"]["control_job_id"]==args["control_job_id"],"recorded_control_review_required")
            if job["status"] in op.TERMINAL or job["status"] in ("needs_attention","running"): return public_operation(job)
            require(job["status"]=="queued","job_not_approved")
            result=operator.run_once(args["plan_id"])
            return public_operation(result or operator.store.get(args["plan_id"]))
        if command=="execute_restore_verification":
            fields(args,("plan_id","plan_digest","control_job_id"))
            vault=Vault(self.install); job=vault.get(args["plan_id"])
            require(job["plan_digest"]==args["plan_digest"],"execution_plan_mismatch")
            require(job.get("control_review") and job["control_review"]["control_job_id"]==args["control_job_id"],"recorded_control_review_required")
            if job["status"]!="planned": return public_drill(job)
            return public_drill(vault.execute(args["plan_id"],args["plan_digest"],confirmed=True,control_job_id=args["control_job_id"]))
        raise op.OperatorFailure("unsupported_rpc_command")


def main():
    os.umask(0o077)
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--directory",required=True)
    sub=parser.add_subparsers(dest="command",required=True)
    sub.add_parser("rpc")
    sub.add_parser("observe")
    bootstrap_command=sub.add_parser("bootstrap-host-tools"); bootstrap_command.add_argument("--confirm",action="store_true",required=True)
    enroll=sub.add_parser("enroll"); enroll.add_argument("--confirm",action="store_true",required=True); enroll.add_argument("--development",action="store_true")
    trust=sub.add_parser("pin-trust"); trust.add_argument("--file",type=Path,required=True); trust.add_argument("--sha256",required=True); trust.add_argument("--confirm",action="store_true",required=True)
    fetch=sub.add_parser("fetch-release"); fetch.add_argument("--version",required=True)
    inspect=sub.add_parser("inspect-release"); inspect.add_argument("--release-digest",required=True); inspect.add_argument("--offline",action="store_true")
    export=sub.add_parser("export-offline"); export.add_argument("--release-digest",required=True); export.add_argument("--output",type=Path,required=True)
    export.add_argument("--local-image",action="store_true"); export.add_argument("--confirm",action="store_true",required=True)
    offline=sub.add_parser("stage-offline"); offline.add_argument("--source",type=Path,required=True); offline.add_argument("--confirm",action="store_true",required=True)
    args=parser.parse_args()
    if args.command!="bootstrap-host-tools": delegate(args.directory,"siftgate_agent.py",sys.argv[1:])
    agent=Agent(args.directory)
    if args.command=="rpc":
        raw=sys.stdin.buffer.read(512*1024+1); require(len(raw)<=512*1024,"rpc_request_too_large")
        result=agent.handle(release.json_bytes(raw))
    elif args.command=="observe": result=agent.observe()
    elif args.command=="bootstrap-host-tools": result=bootstrap(agent.install,confirmed=args.confirm)
    elif args.command=="enroll":
        operator=op.Operator.enroll(args.directory,development=args.development)
        result={"enrolled":True,"installation_id":operator.policy["installation_id"],"restarted":False}
    elif args.command=="pin-trust": result=agent.cache().pin_trusted_root(args.file,args.sha256,confirmed=args.confirm)
    elif args.command=="fetch-release":
        cache=agent.cache(); destination=cache.fetch(args.version); verified,_=cache.get(destination.name)
        result={"release_digest":verified.digest,"manifest":verified.manifest,"publisher_verified":True,"restarted":False}
    elif args.command=="inspect-release":
        verified,_=agent.cache().get(args.release_digest,offline=args.offline)
        result={"release_digest":verified.digest,"manifest":verified.manifest,"publisher_verified":True,"restarted":False}
    elif args.command=="export-offline":
        result=agent.cache().export_offline(args.release_digest,agent.install,args.output,local=args.local_image)
    else:
        agent.operator()
        require({path.name for path in args.source.iterdir()}==OFFLINE_FILES,"invalid_offline_members")
        parent=private_directory(agent.install.root/"operator/inbox",create=True)
        require(sum(1 for _ in parent.iterdir())<20,"offline_inbox_retention_required")
        destination=private_directory(parent/("offline-"+uuid.uuid4().hex),create=True)
        for name in OFFLINE_FILES:
            copy_regular(args.source/name,destination/name,release.MAX_IMAGE if name=="image.tar" else release.MAX_INSTALLER)
        result={"package_id":destination.name,"publisher_verified":False,"restarted":False,"next":"Review and import in the independent Control Room."}
    print(json.dumps({"format":PROTOCOL,"ok":True,"result":result}))


if __name__=="__main__":
    try: main()
    except (op.OperatorFailure,release.ReleaseError) as error:
        print(json.dumps({"format":PROTOCOL,"ok":False,"error_code":str(error)})); sys.exit(1)
    except Exception:
        print(json.dumps({"format":PROTOCOL,"ok":False,"error_code":"agent_operation_failed"})); sys.exit(1)
