import os
from pathlib import Path
import re,subprocess
R=Path(__file__).resolve().parents[1]
s=(R/'migrations/022_task_documents.sql').read_text()
for f in re.findall(r'create function .*?\$\$;',s,re.S):
 r=subprocess.run(['docker','exec','-i',os.environ.get('ATLAS_FIXTURE_CONTAINER_BASE','atlas-task-docs-20260922'),'psql','-X','-U','postgres','-d','docs','-v','ON_ERROR_STOP=1'],input=f.replace('create function','create or replace function',1),text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr)
print('Refreshed functions in owned synthetic database only.')
