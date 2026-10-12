import https from 'node:https';
import {Readable} from 'node:stream';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';

const ENV_KEYS=['HTTP_PROXY','http_proxy','HTTPS_PROXY','https_proxy','NO_PROXY','no_proxy'];
const CODES=new Set(['ENOTFOUND','EAI_AGAIN','ETIMEDOUT','ECONNREFUSED','ECONNRESET','EHOSTUNREACH','ENETUNREACH','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','CERT_HAS_EXPIRED','UNABLE_TO_VERIFY_LEAF_SIGNATURE','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT','ERR_TLS_CERT_ALTNAME_INVALID','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','ABORT_ERR']);
export function selectProxyEnvironment({env={},route}){
 const explicit=env.https_proxy||env.HTTPS_PROXY;
 if(explicit){validateProxy(explicit);return {proxyEnv:Object.fromEntries(ENV_KEYS.filter(k=>env[k]!==undefined).map(k=>[k,env[k]])),mode:'environment'};}
 if(route?.proxy){validateProxy(route.proxy);return {proxyEnv:{HTTPS_PROXY:route.proxy},mode:'system'};}
 return {proxyEnv:{},mode:'direct'};
}
function validateProxy(value){try{const u=new URL(value);if(!['http:','https:'].includes(u.protocol))throw Error();}catch{throw Error('代理地址无效，仅支持 HTTP / HTTPS 代理');}}
export function networkError(error,stage,url){
 const found=new Set(),seen=new Set(),todo=[error];let timeout=false;
 while(todo.length&&seen.size<40){const e=todo.pop();if(!e||typeof e!=='object'||seen.has(e))continue;seen.add(e);if(CODES.has(e.code))found.add(e.code);if(e.name==='TimeoutError'||e.name==='AbortError')timeout=true;if(e.cause)todo.push(e.cause);if(Array.isArray(e.errors))todo.push(...e.errors.slice(0,10));}
 const codes=[...found];if(!codes.length&&timeout)codes.push('ETIMEDOUT');
 let hint='请确认本机网络和代理可访问该云端域名，再点击检测本机助手。';
 if(codes.some(c=>/CERT|SIGNATURE|ISSUER/.test(c)))hint='系统证书校验失败，请检查 Windows 时间和受信证书；助手保持证书校验开启。';
 else if(codes.some(c=>['ENOTFOUND','EAI_AGAIN'].includes(c)))hint='域名解析失败，请检查 Windows DNS 或代理设置。';
 else if(codes.some(c=>/TIMEOUT/.test(c)))hint='连接超时，请检查系统代理是否开启、代理端口是否可用。';
 else if(codes.includes('ECONNREFUSED'))hint='连接被拒绝，请检查代理程序和端口是否运行。';
 else if(codes.includes('ECONNRESET')||codes.includes('UND_ERR_SOCKET'))hint='连接中断，保留已有进度，恢复网络后重试。';
 let hostname='云端服务';try{hostname=new URL(url).hostname;}catch{}
 const result=Error(`${stage}失败：${hostname}（${codes.join(', ')||'NETWORK_ERROR'}）。${hint}`);result.code='ART_NETWORK';result.stage=stage;result.retryable=timeout||codes.some(c=>['EAI_AGAIN','ETIMEDOUT','ECONNRESET','UND_ERR_CONNECT_TIMEOUT','UND_ERR_HEADERS_TIMEOUT','UND_ERR_SOCKET','ABORT_ERR'].includes(c));return result;
}
export async function windowsProxyRoutes(origins){
 // Fixed cloud origins only. Credentials and proxy URLs remain in memory.
 const script="$ErrorActionPreference='Stop'; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); $p=[System.Net.WebRequest]::GetSystemWebProxy(); $urls="+JSON.stringify(origins).replace(/^\[/,'@(').replace(/\]$/,')')+"; $r=@(); foreach($s in $urls){$u=[Uri]$s; $v=$p.GetProxy($u); $proxy=$null; if(!$p.IsBypassed($u) -and $v -and $v.AbsoluteUri -ne $u.AbsoluteUri){$proxy=$v.AbsoluteUri}; $r+=@{origin=$u.GetLeftPart([UriPartial]::Authority);proxy=$proxy}}; ConvertTo-Json -InputObject $r -Compress";
 const {stdout}=await promisify(execFile)('powershell.exe',['-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(script,'utf16le').toString('base64')],{encoding:'utf8',windowsHide:true,timeout:30000,maxBuffer:65536});
 const routes=JSON.parse(stdout.replace(/^\uFEFF/,''));if(!Array.isArray(routes)||routes.length!==origins.length)throw Error('Windows 代理解析结果无效');return routes;
}
export function createCloudTransport({origins,env=process.env,platform=process.platform,resolveRoutes=windowsProxyRoutes,requestImpl=https.request,Agent=https.Agent}={}){
 const allowed=new Set(origins);let agents=new Map(),modes=new Map(),ready=null;
 async function refresh(){
  const routes=platform==='win32'&&!(env.https_proxy||env.HTTPS_PROXY)?await resolveRoutes(origins):origins.map(origin=>({origin,proxy:null}));
  const next=new Map(),nextModes=new Map();
  for(const origin of origins){const route=routes.find(r=>r.origin===origin);if(!route)throw Error('Windows 代理解析结果缺少云端域名');const {proxyEnv,mode}=selectProxyEnvironment({env,route});next.set(origin,new Agent({keepAlive:true,maxSockets:2,proxyEnv}));nextModes.set(origin,mode);}
  for(const agent of agents.values())agent.destroy();agents=next;modes=nextModes;
 }
 const initialize=()=>ready||(ready=refresh().catch(e=>{ready=null;throw e;}));
 async function cloudFetch(input,options={}){
  const url=new URL(input);if(!allowed.has(url.origin)||url.username||url.password)throw Error('本机助手拒绝向非项目云端地址发送请求');
  await initialize();
  return new Promise((resolve,reject)=>{
   const req=requestImpl(url,{method:options.method||'GET',headers:options.headers,agent:agents.get(url.origin),signal:options.signal},res=>{
    const status=res.statusCode;
    if(status>=300&&status<400){res.resume();reject(Object.assign(Error('云端请求发生重定向，已停止'),{code:'ART_REDIRECT'}));return;}
    const headers=new Headers();for(const [k,v] of Object.entries(res.headers))if(v!==undefined)headers.set(k,Array.isArray(v)?v.join(', '):v);
    const noBody=options.method==='HEAD'||[204,205,304].includes(status);if(noBody)res.resume();
    resolve(new Response(noBody?null:Readable.toWeb(res),{status,headers}));
   });req.on('error',reject);req.end(options.body);
  });
 }
 return {fetch:cloudFetch,async refresh(){await (ready=refresh().catch(e=>{ready=null;throw e;}));},mode(origin){return modes.get(origin)||'unknown';},close(){for(const agent of agents.values())agent.destroy();}};
}
