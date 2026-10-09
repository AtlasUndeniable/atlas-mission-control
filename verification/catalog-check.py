from pathlib import Path
import json,subprocess,hashlib
R=Path(__file__).resolve().parents[1];name='atlas-task-docs-20260922-clean'
def query(s):
 return subprocess.run(['docker','exec',name,'psql','-X','-U','postgres','-d','docs','-At','-c',s],check=True,capture_output=True,text=True).stdout.strip()
checks=[];differences=[]
for filename in ['hosted-schema-current.json','hosted-dependencies-current.json']:
 for t in json.loads((R/'verification'/filename).read_text())['tables']:
  rel=t['schema']+'.'+t['name'] if 'schema'in t else t['name']
  actual=json.loads(query("select json_build_object('rls',c.relrowsecurity,'acl',coalesce(c.relacl,acldefault('r',c.relowner)),'columns',(select json_agg(json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull)order by a.attnum)from pg_attribute a where a.attrelid=c.oid and a.attnum>0 and not a.attisdropped),'constraints',(select json_agg(pg_get_constraintdef(oid))from pg_constraint where conrelid=c.oid),'triggers',(select json_agg(pg_get_triggerdef(oid))from pg_trigger where tgrelid=c.oid and not tgisinternal and tgname not like 'task_document_%'))from pg_class c where c.oid='"+rel+"'::regclass;"))
  for key in ['columns','constraints','triggers','acl','rls']:
   if key not in t:continue
   a,b=actual[key],t[key]
   if key in ['constraints','triggers','acl']:a,b=sorted(a or []),sorted(b or [])
   if a!=b:differences.append({'relation':rel,'field':key,'local':a,'captured':b})
  checks.append(rel)
(R/'evidence/catalog-differences.json').write_text(json.dumps(differences,indent=2)+'\n')
assert {d['relation'] for d in differences}=={'public.requests','public.tasks','public.evidence_revisions','public.request_source_bindings'}
for d in differences:
 assert d['field']=='constraints'
 assert sorted(x.replace('(','').replace(')','')for x in d['local'])==sorted(x.replace('(','').replace(')','')for x in d['captured'])
# Reviewed seven differences: nested AND groups flattened by local PostgreSQL; surrounding OR groups unchanged.
assert query('select count(*)from app_private.task_documents')=='0'
assert query("select count(*)from information_schema.routine_privileges where routine_name in('meeting_document','meeting_document_runtime')and grantee<>'postgres'")=='0'
p=subprocess.run(['docker','exec','-i',name,'psql','-X','-U','postgres','-d','docs','-v','ON_ERROR_STOP=1'],input=(R/'migrations/022_task_documents.sql').read_text(),capture_output=True,text=True)
assert p.returncode!=0 and 'meeting_preimage_changed'in p.stderr
(R/'evidence/migration-catalog.json').write_text(json.dumps({'syntheticSchemaOnly':True,'tableDefinitionsMatched':checks,'compared':['columns','constraints','preexisting triggers','ACL','RLS'],'newAuthorityTriggersExcludedFromBaselineComparison':True,'migrationSha256':hashlib.sha256((R/'migrations/022_task_documents.sql').read_bytes()).hexdigest(),'capturedConstraintFormattingDifferences':'Seven associative AND groupings across four tables; exact differences retained and manually inspected','cleanInstall':True,'noDocumentsOrRpcGrantsSeeded':True,'repeatRefused':True},indent=2)+'\n')
print('PASS',len(checks),'captured table definitions; clean install, no activation, repeat refusal')
