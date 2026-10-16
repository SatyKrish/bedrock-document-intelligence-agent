"""Verify every allowlisted source byte against the approved build environment."""
import hashlib,json,os
from pathlib import Path
root=Path('.').resolve()
manifest=json.loads((root/'source-manifest.json').read_text())
# JS canonicalizes objects by sorted keys; all values here are ASCII SHA digests.
encoded=json.dumps(manifest,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode()
if hashlib.sha256(encoded).hexdigest()!=os.environ['SOURCE_DIGEST']: raise SystemExit('Approved source digest mismatch')
for name,expected in manifest.items():
    path=root/name
    if path.is_symlink() or root not in path.resolve().parents or not path.is_file():raise SystemExit('Unsafe source file')
    if hashlib.sha256(path.read_bytes()).hexdigest()!=expected:raise SystemExit('Source hash mismatch')

actual=set()
for path in root.rglob('*'):
    if path.is_symlink(): raise SystemExit('Source bundle rejects symlinks')
    if path.is_file(): actual.add(path.relative_to(root).as_posix())
if actual != set(manifest) | {'source-manifest.json'}: raise SystemExit('Source bundle contains unapproved files')
