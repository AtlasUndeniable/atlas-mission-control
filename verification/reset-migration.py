import os
from pathlib import Path
import json,subprocess
R=Path(__file__).resolve().parents[1]
def sql(s):
 r=subprocess.run(['docker','exec','-i',os.environ.get('ATLAS_FIXTURE_CONTAINER_BASE','atlas-task-docs-20260922'),'psql','-X','-U','postgres','-d','docs','-v','ON_ERROR_STOP=1'],input=s,text=True,capture_output=True)
 if r.returncode:raise RuntimeError(r.stderr)
current=json.loads((R/'verification/hosted-schema-current.json').read_text())
sql('drop function public.meeting_document(text,uuid,jsonb);drop function public.meeting_document_runtime(text,uuid,jsonb);drop function app_private.task_document_packet(uuid,text,text);drop table app_private.task_document_events,app_private.task_document_versions,app_private.task_document_attempts,app_private.task_document_evidence,app_private.task_document_grants,app_private.task_documents;')
sql(next(f['definition']for f in current['functions']if f['name']=='meeting_queue'))
sql('drop function app_private.meeting_queue_v21(text,jsonb);')
sql((R/'migrations/022_task_documents.sql').read_text())
print('Updated migration applied only to owned disposable database.')
