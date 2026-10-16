"""Explicitly fetch the pinned upstream AWS baseline skill; no credentials/inference."""
import argparse, hashlib, io, json, os, tempfile, urllib.request, zipfile
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
PINS=json.loads((ROOT/'deployment/baseline-fixtures/PROVENANCE.json').read_text())
DEST=ROOT/'deployment/baseline-fixtures/hello-bma/SKILL.md'

def prepare(data):
    if hashlib.sha256(data).hexdigest()!=PINS['bundleSha256']: raise ValueError('Upstream bundle changed; review the new version before use')
    with zipfile.ZipFile(io.BytesIO(data)) as z:
        member=z.getinfo(PINS['member'])
        if member.file_size>65536: raise ValueError('Unexpected fixture size')
        body=z.read(member)
    if hashlib.sha256(body).hexdigest()!=PINS['skillSha256']: raise ValueError('Stock skill hash mismatch')
    for p in [DEST,*DEST.parents]:
        if p==ROOT: break
        if p.is_symlink(): raise ValueError('Refusing a symlink destination')
    if DEST.exists():
        if DEST.read_bytes()!=body: raise ValueError('Existing fixture differs; preserve and review it')
        return
    DEST.parent.mkdir(parents=True,exist_ok=True)
    fd=os.open(DEST,os.O_WRONLY|os.O_CREAT|os.O_EXCL,0o644)
    with os.fdopen(fd,'wb') as f:f.write(body)

if __name__=='__main__':
    parser=argparse.ArgumentParser(description=__doc__)
    source=parser.add_mutually_exclusive_group(required=True)
    source.add_argument('--download',action='store_true',help='Retrieve official sample after reviewing upstream terms')
    source.add_argument('--bundle',type=Path,help='Use an already reviewed official ZIP')
    args=parser.parse_args()
    if args.download:
        with urllib.request.urlopen(PINS['source'],timeout=30) as response:data=response.read(2*1024*1024+1)
        if len(data)>2*1024*1024: raise ValueError('Bundle exceeds size limit')
    else:data=args.bundle.read_bytes()
    prepare(data)
    print('Verified stock fixture prepared locally; not redistributed, no AWS credentials or model call.')
