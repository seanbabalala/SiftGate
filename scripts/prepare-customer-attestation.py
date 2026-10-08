#!/usr/bin/env python3
"""Reuse a verified saved bundle; never replace existing draft/public release bytes."""
import argparse
import importlib.util
import json
import os
from pathlib import Path
import shutil
import tempfile

ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location("asset_upload",ROOT/"scripts/upload-customer-assets.py")
assets=importlib.util.module_from_spec(spec); spec.loader.exec_module(assets)


def prepare(repo,tag,directory):
    names=assets.validate_local(repo,tag,directory,require_attestation=True,allow_missing_bundle=True)
    value=json.loads(assets.gh("release","view",tag,"--repo",repo,"--json","assets,isDraft"))
    present={item["name"] for item in value["assets"]}
    if len(present)!=len(value["assets"]): raise ValueError("Ambiguous release assets")
    if not value["isDraft"] and not set(names)<=present:
        raise ValueError("Existing public release is incomplete; refusing silent repair")
    with tempfile.TemporaryDirectory(prefix="siftgate-attestation-resume-") as temporary:
        temporary=Path(temporary).resolve()
        for name in names:
            if name not in present: continue
            assets.gh("release","download",tag,"--repo",repo,"--pattern",name,"--dir",str(temporary))
            source=Path(temporary)/name; destination=directory/name
            if name!=names[-1] or destination.exists():
                if assets.sha256(source)!=assets.sha256(destination): raise ValueError("Existing release bytes differ; do not rebuild successful jobs")
            else:
                assets.release.verify_release(directory/names[2],source)
                with destination.open("xb") as output,source.open("rb") as input_file: shutil.copyfileobj(input_file,output)
    reuse=(directory/names[-1]).exists()
    if reuse: assets.validate_local(repo,tag,directory,require_attestation=True)
    return reuse


if __name__=="__main__":
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo",required=True); parser.add_argument("--tag",required=True); parser.add_argument("--directory",type=Path,required=True)
    args=parser.parse_args(); reuse=prepare(args.repo,args.tag,args.directory)
    if os.environ.get("GITHUB_OUTPUT"):
        with open(os.environ["GITHUB_OUTPUT"],"a") as output: output.write("reuse_bundle="+str(reuse).lower()+"\n")
    print(json.dumps({"reuse_bundle":reuse,"existing_bytes_overwritten":False}))
