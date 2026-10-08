/** Bound response bytes before JSON allocation. Cancellation does not imply provider termination. */
export async function intakeJSON(response:Response,maxBytes=4_000_000):Promise<unknown>{
 if(!response.ok||!response.body)throw Error('intake_http_refused');
 const reader=response.body.getReader(),chunks:Uint8Array[]=[];let size=0;
 try{for(;;){const {done,value}=await reader.read();if(done)break;size+=value.byteLength;if(size>maxBytes)throw Error('intake_response_cap');chunks.push(value);}const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}return JSON.parse(new TextDecoder().decode(bytes));}
 finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
}
