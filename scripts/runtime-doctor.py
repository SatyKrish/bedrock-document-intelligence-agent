"""Verify the prepared context, host prerequisites and local Docker availability."""
import hashlib,json,shutil,subprocess,sys
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
sys.path.insert(0,str(ROOT/'scripts'))
from importlib.util import spec_from_file_location,module_from_spec
spec=spec_from_file_location('preparer',ROOT/'scripts/prepare-runtime.py')
preparer=module_from_spec(spec);spec.loader.exec_module(preparer)
context=ROOT/'.runtime-build/context'
def check_context():
    preparer.safe_destination(context)
    expected={'control_plane.py','guard.py','entrypoint.py','Dockerfile','codex','.dockerignore','manifest.json'}
    if not context.is_dir() or {p.name for p in context.iterdir()} != expected: raise ValueError('Prepare the exact allowlisted runtime context first')
    for p in context.iterdir():
        if p.is_symlink() or not p.is_file(): raise ValueError('Context contains an invalid entry')
    manifest=json.loads((context/'manifest.json').read_text())
    if manifest['sourcePins'] != preparer.PINS: raise ValueError('Context provenance differs from current pins')
    if set(manifest['files']) != expected - {'.dockerignore','manifest.json'}: raise ValueError('Context hash inventory is incomplete')
    preparer.verify(context/'codex',preparer.PINS['codex']['executableSha256'])
    preparer.verify(context/'control_plane.py',preparer.PINS['awsBundle']['adapterSha256'])
    for name,digest in manifest['files'].items():
        preparer.verify(context/name,digest)
    for name in ['guard.py','entrypoint.py','Dockerfile']:
        if preparer.sha(ROOT/'runtime'/name)!=manifest['files'][name]: raise ValueError('Context is stale; rerun preparation: '+name)
    return context
if __name__=='__main__':
    try:
        check_context();print('PASS: byte-pinned ARM64 sources and exact context inventory.')
        docker=shutil.which('docker')
        if not docker: raise ValueError('Docker is not installed')
        result=subprocess.run([docker,'info','--format','{{.ServerVersion}}'],capture_output=True,text=True,timeout=10)
        if result.returncode: raise ValueError('Docker daemon unavailable at the configured context; no daemon was started')
        print('PASS: configured Docker daemon responds. Container compatibility is not yet validated.')
    except (ValueError,OSError,subprocess.TimeoutExpired) as error:
        raise SystemExit('BLOCKED: '+str(error))
