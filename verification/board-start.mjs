// Starts the disposable fixture RPC plus two production app instances:
//  :55941 with drafting enabled (Lane C's path reachable)
//  :55942 with drafting absent  (the installed default: Start must be
//                                disabled and say why)
import {spawn} from 'node:child_process';
const common={PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',
 MISSION_CONTROL_AUTH_USER:'operator',MISSION_CONTROL_AUTH_PASSWORD:'synthetic-operator',
 MISSION_CONTROL_RHYS_USER:'rhys',MISSION_CONTROL_RHYS_PASSWORD:'synthetic-rhys',
 MISSION_CONTROL_NAMED_CREDENTIALS:JSON.stringify([{name:'nat',user:'nat',password:'synthetic-nat'},{name:'pat',user:'pat',password:'synthetic-pat'}]),
 ATLAS_MEETING_QUEUE:'1',ATLAS_MEETING_INTAKE_VIEW:'1',
 ATLAS_MEETING_TRANSPORT:JSON.stringify({url:'http://127.0.0.1:55940',principals:{rhys:'synthetic-rhys',pat:'synthetic-pat',nat:'synthetic-nat'}})};
const rpc=spawn(process.execPath,['verification/board-fixture.mjs'],{env:{...common,ATLAS_BOARD_FIXTURE_PORT:'55940'},stdio:'inherit'});
const withDrafting=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','55941'],{env:{...common,ATLAS_TASK_DOCUMENTS:'1'},stdio:'inherit'});
const withoutDrafting=spawn(process.execPath,['node_modules/next/dist/bin/next','start','-H','127.0.0.1','-p','55942'],{env:common,stdio:'inherit'});
const stop=()=>{rpc.kill();withDrafting.kill();withoutDrafting.kill()};
process.on('SIGTERM',stop);process.on('SIGINT',stop);
for(const p of [withDrafting,withoutDrafting])p.on('exit',()=>{stop();process.exit()});
