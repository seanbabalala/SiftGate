#!/usr/bin/env python3
"""Fetch a contract-pinned legacy installer for isolated native CI acceptance."""
import hashlib
import json
from pathlib import Path
import re
import sys
import tarfile

ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/"deploy/customer"))
import siftgate_release as release
from siftgate_releases import download,private_directory


def fetch(record,destination,fetcher=download):
    release.version(record["version"])
    release.require(release.SHA.fullmatch(record.get("installer_sha256","")) and re.fullmatch(r"[a-f0-9]{40}",record.get("source_commit","")),"baseline_identity_required")
    destination=Path(destination).absolute()
    release.require(not destination.exists(),"baseline_destination_exists")
    private_directory(destination,create=True)
    tag="v"+record["version"]; filename="siftgate-"+tag+"-install.tar.gz"; archive=destination/filename
    fetcher("https://github.com/"+release.REPOSITORY+"/releases/download/"+tag+"/"+filename,archive,release.MAX_INSTALLER)
    release.require(release.sha256(archive)==record["installer_sha256"],"baseline_archive_identity_mismatch")
    extracted=destination/"kit"; private_directory(extracted,create=True)
    with tarfile.open(archive,"r:gz") as source:
        seen=set(); total=0
        for member in source:
            release.safe_member(member.name); parts=member.name.split("/")
            release.require(member.isfile() and len(parts)==2 and parts[0]=="siftgate-"+tag and member.name not in seen and
                            0<=member.size<=16*1024*1024,"unsafe_baseline_archive")
            seen.add(member.name); total+=member.size
            release.require(len(seen)<=128 and total<=release.MAX_INSTALLER,"baseline_archive_limit")
            with (extracted/parts[1]).open("xb") as output: output.write(source.extractfile(member).read())
    nested=release.json_bytes(release.read_bytes(extracted/"release.json",release.MAX_MANIFEST))
    release.require(nested=={"format":"siftgate-customer-release-v1","version":tag,"commit":record["source_commit"],"image":record["image"]},"baseline_release_pair_mismatch")
    return extracted


if __name__=="__main__":
    import argparse
    parser=argparse.ArgumentParser(description=__doc__); parser.add_argument("--version",required=True); parser.add_argument("--output",type=Path,required=True)
    args=parser.parse_args(); contract=json.loads((ROOT/"deploy/customer/release-contract.json").read_text())
    selected=next(item for item in contract["source_releases"] if item["version"]==args.version)
    print(fetch(selected,args.output))
