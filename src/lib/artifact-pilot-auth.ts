type Env=Record<string,string|undefined>;
export function pilotCredential(env:Env):{user:string;password:string}|null {
 const user=env.MISSION_CONTROL_DANTE_PILOT_USER,password=env.MISSION_CONTROL_DANTE_PILOT_PASSWORD;
 if(!user||!password||user.includes(':'))return null;
 try {
  const named:unknown=JSON.parse(env.MISSION_CONTROL_NAMED_CREDENTIALS||'[]');if(!Array.isArray(named))return null;
  const others=[{user:env.MISSION_CONTROL_RHYS_USER,password:env.MISSION_CONTROL_RHYS_PASSWORD},{user:env.MISSION_CONTROL_AUTH_USER,password:env.MISSION_CONTROL_AUTH_PASSWORD},...named];
  if(others.some(c=>c&&(c.user===user||c.password===password)))return null;
  return {user,password};
 } catch{return null;}
}
export function isPilotLogin(header:string|null,env:Env):boolean {
 const c=pilotCredential(env);if(!c||!header)return false;
 const expected='Basic '+btoa(c.user+':'+c.password);let diff=header.length^expected.length;
 for(let i=0;i<Math.max(header.length,expected.length);i++)diff|=(header.charCodeAt(i)||0)^(expected.charCodeAt(i)||0);
 return diff===0;
}
