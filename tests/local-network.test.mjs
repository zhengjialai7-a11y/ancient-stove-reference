import assert from 'node:assert/strict';
import {test} from 'node:test';
import {selectProxyEnvironment,networkError,createCloudTransport} from '../local-agent/network.mjs';
import {CaptureClient} from '../local-agent/core.mjs';
import https from 'node:https';
import http from 'node:http';
import net from 'node:net';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import path from 'node:path';

const origin='https://otaokoencpoanxjjuqzv.supabase.co';
const hostname=new URL(origin).hostname;
const nested=(code,message='transport detail')=>new TypeError('fetch failed',{
 cause:new Error(message,{cause:Object.assign(new Error(message),{code})})
});

test('explicit proxy environment keeps case, bypass settings, and excludes unrelated secrets',()=>{
 const env={https_proxy:'http://localhost:7890',HTTPS_PROXY:'http://localhost:9999',HTTP_PROXY:'http://localhost:7890',http_proxy:'http://localhost:7891',NO_PROXY:'localhost,.internal',no_proxy:'127.0.0.1',ACCESS_TOKEN:'do-not-copy',NODE_OPTIONS:'--inspect'};
 const before={...env};
 const result=selectProxyEnvironment({env,route:{origin,proxy:'http://localhost:8080'}});
 assert.equal(result.mode,'environment');
 assert.deepEqual(result.proxyEnv,{https_proxy:env.https_proxy,HTTPS_PROXY:env.HTTPS_PROXY,HTTP_PROXY:env.HTTP_PROXY,http_proxy:env.http_proxy,NO_PROXY:env.NO_PROXY,no_proxy:env.no_proxy});
 assert.deepEqual(env,before);
});

test('uppercase HTTPS_PROXY takes priority over Windows route without changing NO_PROXY',()=>{
 const result=selectProxyEnvironment({env:{HTTPS_PROXY:'https://proxy.example:8443',NO_PROXY:'localhost'},route:{origin,proxy:null}});
 assert.deepEqual(result,{proxyEnv:{HTTPS_PROXY:'https://proxy.example:8443',NO_PROXY:'localhost'},mode:'environment'});
});

test('Windows-resolved proxy applies only that route and excludes stale bypass environment',()=>{
 const result=selectProxyEnvironment({env:{HTTP_PROXY:'http://unused.example:8000',NO_PROXY:hostname,SECRET:'not-an-environment-addition'},route:{origin,proxy:'http://localhost:7890'}});
 assert.deepEqual(result,{proxyEnv:{HTTPS_PROXY:'http://localhost:7890'},mode:'system'});
});

test('a Windows DIRECT route does not inherit an unrelated HTTP proxy',()=>{
 assert.deepEqual(selectProxyEnvironment({env:{HTTP_PROXY:'http://localhost:7890',NO_PROXY:'localhost'},route:{origin,proxy:null}}),{proxyEnv:{},mode:'direct'});
 assert.deepEqual(selectProxyEnvironment({route:{origin,proxy:null}}),{proxyEnv:{},mode:'direct'});
});

test('unsupported proxy schemes fail without reflecting credential-bearing proxy URLs',()=>{
 for(const proxy of ['socks5://private-user:private-password@localhost:1080','ftp://private-user:private-password@localhost:21','not a proxy private-password']){
  assert.throws(()=>selectProxyEnvironment({route:{origin,proxy}}),error=>{
   assert.match(error.message,/代理|地址|协议/);
   assert.equal(error.message.includes(proxy),false);
   assert.equal(error.message.includes('private-password'),false);
   return true;
  });
 }
});

test('DNS errors reveal stage, hostname and nested code without raw transport secrets',()=>{
 const token='eyJ.private-session.jwt';
 const url=origin+'/auth/v1/user?token='+token;
 const result=networkError(nested('ENOTFOUND','Authorization: Bearer '+token+' '+url),'云端登录校验',url);
 assert.ok(result instanceof Error);
 assert.match(result.message,/云端登录校验/);
 assert.ok(result.message.includes(hostname));
 assert.match(result.message,/ENOTFOUND/);
 assert.match(result.message,/DNS|域名/);
 assert.equal(result.message.includes(token),false);
 assert.equal(result.message.includes('Authorization'),false);
 assert.equal(result.message.includes('/auth/v1/user'),false);
});

test('certificate and timeout errors provide actionable causes rather than raw fetch failed',()=>{
 const certificate=networkError(nested('UNABLE_TO_VERIFY_LEAF_SIGNATURE'),'母图上传',origin+'/storage/v1/upload/resumable');
 assert.match(certificate.message,/UNABLE_TO_VERIFY_LEAF_SIGNATURE/);
 assert.match(certificate.message,/证书/);
 const timeout=networkError(nested('UND_ERR_CONNECT_TIMEOUT'),'母图上传',origin+'/storage/v1/upload/resumable');
 assert.match(timeout.message,/UND_ERR_CONNECT_TIMEOUT/);
 assert.match(timeout.message,/超时/);
 assert.equal(certificate.message.includes('transport detail'),false);
 assert.equal(timeout.message.includes('transport detail'),false);
});

test('AggregateError and circular causes are finite and ignore untrusted code strings',()=>{
 const known=Object.assign(new Error('private-proxy-password'),{code:'ECONNREFUSED'});
 const untrusted=Object.assign(new Error('Bearer private-token'),{code:'Bearer private-token'});
 const aggregate=new AggregateError([known,untrusted],'https://private-user:private-password@proxy.example');
 aggregate.cause=aggregate;
 const result=networkError(aggregate,'云端连接检测',origin+'/?token=private-token');
 assert.match(result.message,/ECONNREFUSED/);
 assert.equal(result.message.includes('private-'),false);
 assert.ok(result.message.length<1000);
});

test('unclassified failures still exclude raw messages and full URLs',()=>{
 const result=networkError(new Error('Bearer private-token; https://name:private-password@proxy.example'),'云端连接检测',origin+'/private/path?token=private-token');
 assert.match(result.message,/云端连接检测/);
 assert.ok(result.message.includes(hostname));
 assert.equal(result.message.includes('private-'),false);
 assert.equal(result.message.includes('proxy.example'),false);
});

test('failed cloud login reports the network stage and leaves account and session unset',async()=>{
 const token='private-access-token';
 const client=new CaptureClient({directory:'unused',stateDirectory:'unused',api:origin,fetchImpl:async()=>{throw nested('ENOTFOUND','Bearer '+token);}});
 await assert.rejects(client.setSession(token),error=>{
  assert.match(error.message,/云端登录校验/);
  assert.match(error.message,/ENOTFOUND/);
  assert.ok(error.message.includes(hostname));
  assert.equal(error.message.includes(token),false);
  return true;
 });
 assert.equal(client.owner,null);
 assert.equal(client.session,null);
});

async function transportFixture(t){
 const dir=await mkdtemp(path.join(tmpdir(),'capture-network-'));
 t.after(()=>rm(dir,{recursive:true,force:true}));
 const keyPath=path.join(dir,'key.pem'),certPath=path.join(dir,'cert.pem');
 await promisify(execFile)('openssl',['req','-x509','-newkey','rsa:2048','-nodes','-keyout',keyPath,'-out',certPath,'-days','1','-subj','/CN=localhost','-addext','subjectAltName=DNS:localhost,IP:127.0.0.1']);
 const [key,cert]=await Promise.all([readFile(keyPath),readFile(certPath)]);
 const sockets=new Set(),connects=[],requests=[];
 const track=socket=>{sockets.add(socket);socket.on('close',()=>sockets.delete(socket));};
 const handler=async(req,res)=>{
  requests.push({method:req.method,path:req.url});
  if(req.url==='/redirect'){res.writeHead(302,{location:'https://foreign.example/should-not-be-requested'});res.end();return;}
  if(req.url==='/head'){res.writeHead(200,{'content-length':'999'});res.end();return;}
  if(req.url==='/empty'){res.writeHead(204);res.end();return;}
  if(req.url==='/slow'){res.writeHead(200);res.flushHeaders();res.write(Buffer.from([0,255,17]));return;}
  const chunks=[];for await(const chunk of req)chunks.push(chunk);
  const bytes=Buffer.concat(chunks);res.writeHead(200,{'content-type':'application/octet-stream','x-request-method':req.method});
  res.write(bytes.subarray(0,17003));setImmediate(()=>res.end(bytes.subarray(17003)));
 };
 const apiServer=https.createServer({key,cert},handler),storageServer=https.createServer({key,cert},handler);
 const proxy=http.createServer((req,res)=>{res.writeHead(500);res.end();});
 proxy.on('connect',(req,client,head)=>{
  connects.push(req.url);track(client);
  const target=new URL('http://'+req.url);
  const upstream=net.connect(Number(target.port),target.hostname,()=>{
   client.write('HTTP/1.1 200 Connection Established\r\n\r\n');
   if(head.length)upstream.write(head);
   client.pipe(upstream);upstream.pipe(client);
  });track(upstream);
  client.on('error',()=>upstream.destroy());upstream.on('error',()=>client.destroy());
 });
 for(const server of [apiServer,storageServer,proxy])server.on('connection',track);
 const listen=server=>new Promise((resolve,reject)=>{server.once('error',reject);server.listen(0,'127.0.0.1',resolve);});
 await Promise.all([listen(apiServer),listen(storageServer),listen(proxy)]);
 const api='https://127.0.0.1:'+apiServer.address().port,storage='https://127.0.0.1:'+storageServer.address().port;
 const proxyUrl='http://127.0.0.1:'+proxy.address().port;
 const resolved=[];
 class TrustedTestAgent extends https.Agent{constructor(options){super({...options,ca:cert});}}
 const transport=createCloudTransport({origins:[api,storage],env:{},platform:'win32',Agent:TrustedTestAgent,resolveRoutes:async origins=>{
  resolved.push([...origins]);return [{origin:api,proxy:proxyUrl},{origin:storage,proxy:null}];
 }});
 t.after(async()=>{
  transport.close();for(const socket of sockets)socket.destroy();
  await Promise.all([apiServer,storageServer,proxy].map(server=>new Promise(resolve=>server.close(resolve))));
 });
 return {transport,api,storage,connects,requests,resolved};
}

test('real HTTPS transport uses the Windows CONNECT route and preserves original binary transfer',async t=>{
 const s=await transportFixture(t);
 const untrusted=createCloudTransport({origins:[s.api],env:{},platform:'linux'});
 try{await assert.rejects(untrusted.fetch(s.api+'/echo'),error=>error.code==='DEPTH_ZERO_SELF_SIGNED_CERT');}
 finally{untrusted.close();}
 const original=Buffer.alloc(131093);for(let i=0;i<original.length;i++)original[i]=i%256;
 const response=await s.transport.fetch(s.api+'/echo',{method:'PATCH',headers:{'content-type':'application/offset+octet-stream','upload-offset':'6291456'},body:original});
 assert.equal(response.status,200);assert.equal(response.headers.get('x-request-method'),'PATCH');
 assert.deepEqual(Buffer.from(await response.arrayBuffer()),original);
 assert.deepEqual(s.resolved,[[s.api,s.storage]]);
 assert.equal(s.transport.mode(s.api),'system');assert.equal(s.transport.mode(s.storage),'direct');
 assert.deepEqual(s.connects,[new URL(s.api).host]);
 const direct=await s.transport.fetch(s.storage+'/echo',{method:'POST',body:Buffer.from([0,255,127,128])});
 assert.deepEqual(Buffer.from(await direct.arrayBuffer()),Buffer.from([0,255,127,128]));
 assert.deepEqual(s.connects,[new URL(s.api).host]);
});

test('real HTTPS transport handles empty responses and denies foreign and redirect destinations',async t=>{
 const s=await transportFixture(t);
 const head=await s.transport.fetch(s.api+'/head',{method:'HEAD'});
 assert.equal(head.status,200);assert.equal(head.body,null);assert.equal((await head.arrayBuffer()).byteLength,0);
 const empty=await s.transport.fetch(s.api+'/empty',{method:'POST'});
 assert.equal(empty.status,204);assert.equal(empty.body,null);
 const before=s.requests.length;
 await assert.rejects(s.transport.fetch('https://foreign.example/path'),/非项目/);
 await assert.rejects(s.transport.fetch(s.api.replace('https://','https://name:password@')+'/echo'),/非项目/);
 assert.equal(s.requests.length,before);
 await assert.rejects(s.transport.fetch(s.api+'/redirect'),/重定向/);
 assert.equal(s.requests.length,before+1);
 assert.equal(s.requests.at(-1).path,'/redirect');
});

test('real HTTPS response stream stops when its request deadline expires',{timeout:10000},async t=>{
 const s=await transportFixture(t);
 const response=await s.transport.fetch(s.api+'/slow',{signal:AbortSignal.timeout(150)});
 await assert.rejects(response.arrayBuffer());
});
