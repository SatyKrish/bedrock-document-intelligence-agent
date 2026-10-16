"""Build locally for ARM64; never push an image or call AWS."""
import argparse,importlib.util,re,subprocess
from pathlib import Path
ROOT=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('doctor',ROOT/'scripts/runtime-doctor.py')
doctor=importlib.util.module_from_spec(spec);spec.loader.exec_module(doctor)
parser=argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image',default='docintel-runtime:preview-0.154.0')
args=parser.parse_args()
if not re.fullmatch(r'docintel-[a-z0-9._-]+:[a-zA-Z0-9._-]+',args.image): parser.error('Use a local docintel-* image tag')
context=doctor.check_context()
subprocess.run(['docker','info','--format','{{.ServerVersion}}'],check=True,timeout=10)
subprocess.run(['docker','buildx','build','--platform','linux/arm64','--load','--tag',args.image,'--file',str(context/'Dockerfile'),str(context)],check=True)
print('Local image built. Review/scan it; registry publication and deployment require separate authorization.')
