import assert from 'node:assert/strict';
import sharp from 'sharp';
import {colorApi} from './server';
import {cloneIdentityMatrix} from '../src/lib/colorCorrection';
const original=await sharp({create:{width:2,height:2,channels:4,background:{r:100,g:120,b:140,alpha:1}}}).png().toBuffer();
const server=colorApi('x'.repeat(40));await new Promise<void>(r=>server.listen(0,'127.0.0.1',r));const port=(server.address() as {port:number}).port;
try{const url=`http://127.0.0.1:${port}/v1/correct`;assert.equal((await fetch(url,{method:'POST'})).status,401);const response=await fetch(url,{method:'POST',headers:{Authorization:'Bearer '+'x'.repeat(40),'Content-Type':'application/json'},body:JSON.stringify({imageBase64:original.toString('base64'),matrix:cloneIdentityMatrix()})});assert.equal(response.status,200);const out=Buffer.from(await response.arrayBuffer());const pixels=await sharp(out).raw().toBuffer();assert.deepEqual([...pixels.slice(0,4)],[100,120,140,255]);console.log('real PNG HTTP correction and auth tests passed')}finally{server.close()}
