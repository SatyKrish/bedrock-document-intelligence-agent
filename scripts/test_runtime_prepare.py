"""Preparation safety tests; no downloads, Docker or AWS."""
import importlib.util, tempfile, unittest
from pathlib import Path
from unittest.mock import patch
spec=importlib.util.spec_from_file_location("prepare",Path(__file__).with_name("prepare-runtime.py"))
prepare=importlib.util.module_from_spec(spec);spec.loader.exec_module(prepare)
class PreparationTests(unittest.TestCase):
    def test_destination_symlinks_rejected_without_writing_outside_root(self):
        with tempfile.TemporaryDirectory() as tmp:
            root=Path(tmp)/"project";root.mkdir()
            outside=Path(tmp)/"outside";outside.mkdir()
            with patch.object(prepare,"ROOT",root):
                for relative in ["bin", "runtime/vendor", ".runtime-build", ".runtime-build/context", "bin/codex.tmp", "runtime/vendor/control_plane.py"]:
                    target=root/relative;target.parent.mkdir(parents=True,exist_ok=True)
                    target.symlink_to(outside)
                    with self.assertRaisesRegex(ValueError,"symlink"): prepare.safe_destination(target/"child" if target.name in ["bin","vendor",".runtime-build","context"] else target)
                    target.unlink()
                self.assertEqual(list(outside.iterdir()),[])
    def test_wrong_digest_fails(self):
        with tempfile.TemporaryDirectory() as tmp:
            p=Path(tmp)/"source";p.write_text("unverified")
            with self.assertRaisesRegex(ValueError,"digest mismatch"): prepare.verify(p,"0"*64)
if __name__=="__main__": unittest.main()
