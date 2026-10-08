/** One read at a time; invalidated/unmounted responses cannot publish. No writes/retries. */
export function createBoardReader<T>(read:(signal:AbortSignal)=>Promise<T>,publish:(value:T)=>void,fail:(error:unknown)=>void,loading:(value:boolean)=>void,timeoutMs=35000){
 let epoch=0,active:{controller:AbortController;promise:Promise<void>}|null=null;
 function invalidate(){epoch++;active?.controller.abort();active=null;loading(false)}
 function refresh():Promise<void>{
  if(active)return active.promise;
  const current=++epoch,controller=new AbortController();loading(true);
  const timer=setTimeout(()=>controller.abort(new Error('Board check timed out.')),timeoutMs);
  const promise=Promise.resolve().then(()=>read(controller.signal)).then(value=>{if(current===epoch)publish(value)},error=>{if(current===epoch)fail(error)}).finally(()=>{clearTimeout(timer);if(current===epoch){active=null;loading(false)}});
  active={controller,promise};return promise;
 }
 return {refresh,invalidate};
}
