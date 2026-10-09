from pathlib import Path
import subprocess,time,json,os,sys
R=Path(__file__).resolve().parents[1];S=R/('verification/private-clean' if '--clean-check' in sys.argv else 'verification/private');S.mkdir(exist_ok='--resume' in sys.argv);S.chmod(0o700)
name='atlas-task-docs-20260922'+('-clean' if '--clean-check' in sys.argv else '');net=name+'-net';rest=name+'-rest'
def run(*args,**kw):return subprocess.run(args,check=True,text=True,capture_output=True,**kw)
def sql(s,user='postgres'):
 r=subprocess.run(['docker','exec','-i',name,'psql','-X','-U',user,'-d','docs','-v','ON_ERROR_STOP=1'],input=s,text=True,capture_output=True)
 with(R/'evidence/db-setup.log').open('a')as f:f.write(r.stdout+r.stderr)
 if r.returncode:raise RuntimeError(r.stderr[-2500:])
if '--resume'not in sys.argv:
 run('docker','network','create',net)
 run('docker','run','--pull=never','-d','--name',name,'--network',net,'--network-alias','pg','-p',('127.0.0.1:55834:5432' if '--clean-check' in sys.argv else '127.0.0.1:55824:5432'),'-e','POSTGRES_PASSWORD=synthetic-docs-only','-e','POSTGRES_DB=docs','public.ecr.aws/supabase/postgres:17.6.1.132')
 (S/'processes.json').write_text(json.dumps({'pg':name,'rest':rest,'network':net}))
 for _ in range(60):
  if subprocess.run(['docker','exec',name,'pg_isready','-U','postgres','-d','docs'],capture_output=True).returncode==0:break
  time.sleep(.5)
for _ in range(60):
 try:
  run('docker','exec',name,'psql','-U','supabase_admin','-d','postgres','-c','alter database docs owner to postgres;');break
 except subprocess.CalledProcessError:time.sleep(.5)
else:raise RuntimeError('Disposable database initialization timeout')
sql("create schema if not exists extensions;create extension if not exists pgcrypto with schema extensions;create extension if not exists citext with schema extensions;create extension if not exists vector with schema extensions;create role atlas_retrieval nologin;grant atlas_retrieval to authenticator;create schema if not exists auth;create table if not exists auth.users(id uuid primary key);create or replace function auth.uid()returns uuid language sql as $$select null::uuid$$;",'supabase_admin')
for owner in ['postgres','supabase_admin']:
 for scope in ['',' in schema public']:
  sql(f'alter default privileges for role {owner}{scope} revoke all on tables from public,anon,authenticated,service_role;alter default privileges for role {owner}{scope} revoke all on functions from public,anon,authenticated,service_role;','supabase_admin')
sql('create role atlas_meeting_nat_web nologin;create role atlas_meeting_rhys_web nologin;create role atlas_meeting_astra_20260911_ingest nologin;','supabase_admin')
sql((R/'verification/captured-hosted-base.sql').read_text().replace('CREATE SCHEMA public;',''),'supabase_admin')
sql("do $$declare r record;begin for r in select n.nspname s,c.relname t,c.relkind k from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname in('public','app_private')and c.relkind in('r','S')loop execute format('alter %s %I.%I owner to postgres',case when r.k='S'then 'sequence'else 'table'end,r.s,r.t);end loop;for r in select p.oid::regprocedure sig from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname in('public','app_private')and p.prokind='f'loop execute format('alter function %s owner to postgres',r.sig);end loop;end$$;alter schema app_private owner to postgres;",'supabase_admin')
# Snapshot is the pre021 full schema. Upgrade only the disposable clone, then compare captured current functions/columns.
sql((R/'verification/021_meeting_task_context.sql').read_text())
current=json.loads((R/'verification/hosted-schema-current.json').read_text())
for f in current['functions']:
 sig=f["schema"]+'.'+f['name']+'('+', '.join(x.strip().split(' ')[-1]for x in f['arguments'].split(',')) +')' if f['arguments'] else f["schema"]+'.'+f['name']+'()'
 # Compare by name/namespace+identity arguments without reconstructing overloaded types.
 query="select md5(pg_get_functiondef(p.oid)) from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='"+f['schema']+"'and p.proname='"+f['name']+"';"
 actual=run('docker','exec',name,'psql','-X','-U','postgres','-d','docs','-At','-c',query).stdout.strip()
 assert actual==f['md5'],(f['name'],actual,f['md5'])
proof=[]
for t in current['tables']:
 cols=run('docker','exec',name,'psql','-X','-U','postgres','-d','docs','-At','-c',"select json_agg(json_build_object('name',a.attname,'type',format_type(a.atttypid,a.atttypmod),'notNull',a.attnotnull)order by a.attnum)from pg_attribute a where a.attrelid='"+t['schema']+'.'+t['name']+"'::regclass and a.attnum>0 and not a.attisdropped;").stdout
 assert json.loads(cols)==t['columns'],t['name'];proof.append(t['schema']+'.'+t['name'])
(R/'evidence/schema-compatibility.json').write_text(json.dumps({'capturedCurrentFunctionsMatched':len(current['functions']),'tableColumnsMatched':proof,'hostedDataCopied':False,'baseline':'Captured schema-only pre021 + exact021 on isolated PostgreSQL17; compared to September22 catalog'},indent=2)+'\n')
sql((R/'migrations/022_task_documents.sql').read_text())
if '--clean-check' in sys.argv:
 print('Final migration applied cleanly; no seed or runtime grants.');sys.exit(0)
run('docker','exec',name,'psql','-U','supabase_admin','-d','docs','-c',"alter role authenticator with login password 'synthetic-docs-only';")
run('docker','run','--pull=never','-d','--name',rest,'--network',net,'-p','127.0.0.1:55825:3000','-e','PGRST_DB_URI=postgres://authenticator:synthetic-docs-only@pg:5432/docs','-e','PGRST_DB_SCHEMAS=public','-e','PGRST_DB_ANON_ROLE=anon','-e','PGRST_JWT_SECRET=task-document-synthetic-only-2026-0000000001','public.ecr.aws/supabase/postgrest:v14.12')
print('Isolated matching schema and migration ready on55824/55825. No hosted writes.')
