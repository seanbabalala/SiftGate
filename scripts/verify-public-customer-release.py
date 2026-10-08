#!/usr/bin/env python3
"""Anonymous public-asset bytes and signature verification after release visibility."""
import argparse
import os
from pathlib import Path
import sys
import tempfile
import time
import urllib.error

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"deploy/customer"))
import siftgate as kit
import siftgate_release as release
from siftgate_releases import download


def verify(tag,directory):
    release.version(tag.removeprefix("v"))
    release.require(tag.startswith("v"),"version_tag_required")
    prefix="siftgate-"+tag
    with tempfile.TemporaryDirectory(prefix="siftgate-anonymous-assets-") as temporary:
        root=Path(temporary).resolve()
        for suffix,limit in (("-install.tar.gz",release.MAX_INSTALLER),("-install.tar.gz.sha256",4096),
                             ("-release.json",release.MAX_MANIFEST),("-release.sigstore.jsonl",4*1024*1024)):
            name=prefix+suffix; target=root/name
            for attempt in range(6):
                try:
                    download("https://github.com/"+release.REPOSITORY+"/releases/download/"+tag+"/"+name,target,limit)
                    break
                except urllib.error.HTTPError as error:
                    if target.exists(): target.unlink()
                    if error.code not in (404,429,502,503) or attempt==5: raise
                    time.sleep(10)
            release.require(release.sha256(target)==release.sha256(directory/name),"anonymous_asset_bytes_changed")
        environment=dict(os.environ)
        for key in ("GH_TOKEN","GITHUB_TOKEN","GH_ENTERPRISE_TOKEN","GITHUB_ENTERPRISE_TOKEN"): environment.pop(key,None)
        config=root/"gh-empty"; config.mkdir(); environment["GH_CONFIG_DIR"]=str(config)
        verified=release.verify_release(root/(prefix+"-release.json"),root/(prefix+"-release.sigstore.jsonl"),
            runner=lambda args,**kwargs:kit.run(args,env=environment,**kwargs))
        release.require(verified.manifest["tag"]==tag,"anonymous_release_tag_changed")
        return {"anonymous_assets_verified":True,"publisher_verified":True,"version":verified.manifest["version"],"deployed":False}


if __name__=="__main__":
    import json
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--tag",required=True); parser.add_argument("--directory",type=Path,required=True)
    args=parser.parse_args(); print(json.dumps(verify(args.tag,args.directory)))
