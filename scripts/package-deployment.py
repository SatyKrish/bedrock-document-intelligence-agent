"""Deterministic allowlisted deployment source ZIP, excluding local state/secrets."""
import hashlib,json,sys,zipfile
from pathlib import Path
root=Path(sys.argv[1]).resolve()
output=Path(sys.argv[2])
files=json.loads(sys.argv[3])
if output.exists(): raise SystemExit('Output already exists; preserve existing work')
with zipfile.ZipFile(output,'x',zipfile.ZIP_DEFLATED) as archive:
    manifest=json.dumps(files,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
    info=zipfile.ZipInfo('source-manifest.json',date_time=(1980,1,1,0,0,0));info.external_attr=0o100644 << 16
    archive.writestr(info,manifest,compress_type=zipfile.ZIP_DEFLATED)
    for name,expected in sorted(files.items()):
        source=root/name
        if source.is_symlink() or root not in source.resolve().parents: raise SystemExit('Unsafe source path')
        data=source.read_bytes()
        if hashlib.sha256(data).hexdigest()!=expected: raise SystemExit('Source changed while packaging')
        entry=zipfile.ZipInfo(name,date_time=(1980,1,1,0,0,0))
        entry.external_attr=0o100644 << 16
        archive.writestr(entry,data,compress_type=zipfile.ZIP_DEFLATED)
