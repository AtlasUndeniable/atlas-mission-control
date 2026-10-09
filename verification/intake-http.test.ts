import test from'node:test';import assert from'node:assert/strict';import{intakeJSON}from'../src/lib/meetings/intake-http.ts';
test('bounded JSON accepts a complete response',async()=>assert.deepEqual(await intakeJSON(new Response('{"ok":true}'),100),{ok:true}));
test('oversize response is refused before parsing',async()=>assert.rejects(()=>intakeJSON(new Response('x'.repeat(100)),20),/response_cap/));
test('HTTP refusal and malformed JSON do not become success',async()=>{await assert.rejects(()=>intakeJSON(new Response('{}',{status:503})));await assert.rejects(()=>intakeJSON(new Response('{')))});
