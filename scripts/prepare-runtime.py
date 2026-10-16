"""Prepare only verified official sources and an allowlisted Docker build context."""
import argparse, hashlib, json, shutil, struct, tarfile, tempfile, urllib.request, zipfile
from pathlib import Path
ROOT = Path(__file__).resolve().parents[1]
PINS = json.loads((ROOT / "runtime/provenance.json").read_text())

def sha(path):
    h = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""): h.update(block)
    return h.hexdigest()

def verify(path, expected):
    if not path.is_file() or path.is_symlink() or sha(path) != expected:
        raise ValueError("Unverified source: digest mismatch or invalid file: " + str(path))

def download(spec, directory, filename):
    path = directory / filename
    with urllib.request.urlopen(spec["url"], timeout=60) as response, path.open("wb") as stream:
        size = 0
        while True:
            block = response.read(1024 * 1024)
            if not block: break
            size += len(block)
            if size > 200 * 1024 * 1024: raise ValueError("Source download exceeds limit")
            stream.write(block)
    verify(path, spec["sha256"])
    return path

def safe_destination(path):
    # Refuse redirected ancestors/files before any write; preserve unrelated work.
    path.relative_to(ROOT)
    for candidate in [path, *path.parents]:
        if candidate == ROOT: break
        if candidate.is_symlink(): raise ValueError("Write destination must not be a symlink: " + str(candidate))

def prepare(bundle, archive):
    verify(bundle, PINS["awsBundle"]["sha256"])
    verify(archive, PINS["codex"]["sha256"])
    destinations = [ROOT / "runtime/vendor/control_plane.py", ROOT / "runtime/vendor/test_control_plane.py", ROOT / "bin/codex", ROOT / "bin/codex.tmp", ROOT / ".runtime-build/context"]
    for destination in destinations: safe_destination(destination)
    vendor = ROOT / "runtime/vendor"
    vendor.mkdir(parents=True, exist_ok=True)
    with zipfile.ZipFile(bundle) as source:
        for key, name in [("adapterEntry", "control_plane.py"), ("testsEntry", "test_control_plane.py")]:
            entry = source.getinfo(PINS["awsBundle"][key])
            if entry.file_size > 1024 * 1024: raise ValueError("Unexpected adapter size")
            (vendor / name).write_bytes(source.read(entry))
    verify(vendor / "control_plane.py", PINS["awsBundle"]["adapterSha256"])
    verify(vendor / "test_control_plane.py", PINS["awsBundle"]["testsSha256"])
    binary = ROOT / "bin/codex"
    binary.parent.mkdir(exist_ok=True)
    with tarfile.open(archive, "r:gz") as source:
        entry = source.getmember(PINS["codex"]["archiveEntry"])
        if not entry.isfile() or entry.size > 400 * 1024 * 1024: raise ValueError("Invalid executable archive entry")
        with source.extractfile(entry) as stream, binary.with_suffix(".tmp").open("wb") as out:
            shutil.copyfileobj(stream, out)
    binary.with_suffix(".tmp").replace(binary)
    binary.chmod(0o755)
    verify(binary, PINS["codex"]["executableSha256"])
    with binary.open("rb") as stream: header = stream.read(20)
    if header[:6] != b"\x7fELF\x02\x01" or struct.unpack_from("<H", header, 18)[0] != 183:
        raise ValueError("Expected a 64-bit little-endian Linux AArch64 ELF executable")
    context = ROOT / ".runtime-build/context"
    context.mkdir(parents=True, exist_ok=True)
    allowed = {"control_plane.py": vendor / "control_plane.py", "codex": binary,
               "guard.py": ROOT / "runtime/guard.py", "entrypoint.py": ROOT / "runtime/entrypoint.py",
               "Dockerfile": ROOT / "runtime/Dockerfile"}
    # Refuse an unexpectedly populated context instead of sending unrelated files.
    for path in context.iterdir():
        if path.name not in allowed and path.name not in {"manifest.json", ".dockerignore"}:
            raise ValueError("Unexpected file in dedicated Docker context: " + path.name)
        if path.is_symlink(): raise ValueError("Build context must not contain symlinks")
    for name, source in allowed.items():
        if source.is_symlink(): raise ValueError("Context source must not be a symlink: " + str(source))
        shutil.copyfile(source, context / name)
    (context / "codex").chmod(0o755)
    (context / ".dockerignore").write_text("**\n!Dockerfile\n!control_plane.py\n!guard.py\n!entrypoint.py\n!codex\n")
    manifest = {"sourcePins": PINS, "files": {name: sha(context / name) for name in allowed}}
    (context / "manifest.json").write_text(json.dumps(manifest, indent=2) + "\n")
    print("Prepared pinned adapter, Linux ARM64 Codex, and allowlisted .runtime-build/context. No AWS calls.")

if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--bundle", type=Path)
    parser.add_argument("--codex-archive", type=Path)
    parser.add_argument("--download", action="store_true", help="Download pinned public AWS/OpenAI sources; no AWS credentials used")
    args = parser.parse_args()
    try:
        with tempfile.TemporaryDirectory(prefix="docintel-runtime-") as tmp:
            directory = Path(tmp)
            bundle = args.bundle or (download(PINS["awsBundle"], directory, "bma.zip") if args.download else None)
            archive = args.codex_archive or (download(PINS["codex"], directory, "codex.tar.gz") if args.download else None)
            if not bundle or not archive: parser.error("Provide both --bundle and --codex-archive, or --download")
            prepare(bundle, archive)
    except (ValueError, OSError, KeyError) as error:
        raise SystemExit(str(error)) from error
