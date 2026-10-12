import {readFile,writeFile,open,mkdir,unlink} from 'node:fs/promises';
import {unlinkSync,readFileSync} from 'node:fs';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {CaptureClient,Decoder,frame,API,STORAGE} from './core.mjs';
import {createCloudTransport,networkError} from './network.mjs';
const root=path.dirname(fileURLToPath(import.meta.url)),configPath=path.join(root,'config.json');
const config=JSON.parse(await readFile(configPath,'utf8'));
if(!config.allowedOrigins?.includes(process.argv[2]))process.exit(1);
const stateDirectory=path.join(process.env.LOCALAPPDATA||os.homedir(),'ArtCapture','state');await mkdir(stateDirectory,{recursive:true});
const lockPath=path.join(stateDirectory,'host.lock');
try{try{const prior=JSON.parse(await readFile(lockPath,'utf8'));try{process.kill(prior.pid,0);}catch(e){if(e.code==='ESRCH')await unlink(lockPath);}}catch(e){if(e.code!=='ENOENT')throw e;}
 const lock=await open(lockPath,'wx');await lock.writeFile(JSON.stringify({pid:process.pid}));await lock.close();
}catch{process.stdout.write(frame({event:true,error:'另一个浏览器正在运行本机助手。请关闭其采集任务后重试。'}));process.exit(1);}
process.on('exit',()=>{try{if(JSON.parse(readFileSync(lockPath,'utf8')).pid===process.pid)unlinkSync(lockPath);}catch{}});
const send=value=>process.stdout.write(frame(value));
const network=createCloudTransport({origins:[API,STORAGE]});
process.on('exit',()=>network.close());
const client=new CaptureClient({fetchImpl:network.fetch,directory:config.directory,stateDirectory,event:state=>send({event:true,state})});await client.load();
const decoder=new Decoder();
async function handle(message){
 const id=message.id;try{let result;
  switch(message.command){
   case 'hello':{if(client.running){result=client.status();break;}try{await network.refresh();result={...client.status(),network:await client.networkCheck()};}catch(e){result={...client.status(),network:{ok:false,checks:[{label:'Windows 代理设置',ok:false,error:networkError(e,'读取 Windows 代理设置',API).message}]}};}break;}
   case 'status':result=client.status();break;
   case 'session':if(client.running)throw Error('正在上传，不能切换账号或重置网络');try{await network.refresh();}catch(e){throw networkError(e,'读取 Windows 代理设置',API);}result=await client.setSession(message.accessToken);break;
   case 'pause':client.paused=true;result={paused:true};break;
   case 'resume':client.paused=false;result={paused:false};break;
   case 'task':result=await client.completedParts(message.task);break;
   case 'directory':{
    if(client.running)throw Error('正在上传时不能更换下载目录');
    const script="Add-Type -AssemblyName System.Windows.Forms; $dialog=New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description='Select the browser download folder'; if($dialog.ShowDialog() -ne 'OK'){exit 2}; [Console]::OutputEncoding=[System.Text.UTF8Encoding]::new($false); [Console]::Write($dialog.SelectedPath)";
    const {stdout}=await promisify(execFile)('powershell.exe',['-STA','-NoProfile','-Command',script],{windowsHide:false,encoding:'utf8'});
    const directory=stdout.trim();if(!directory)throw Error('未选择下载目录');client.directory=directory;config.directory=directory;await writeFile(configPath,JSON.stringify(config,null,2));result={directory};break;
   }
   case 'file':result=await client.processFile(message.file);break;
   default:throw Error('未知助手命令');
  }send({id,ok:true,result});
 }catch(e){send({id,ok:false,error:String(e.message).slice(0,300),errorInfo:{code:e.code,stage:e.stage,status:e.status,retryable:!!e.retryable,retryAttempts:e.retryAttempts||0}});}
}
process.stdin.on('data',bytes=>{try{for(const message of decoder.push(bytes)){if(!message||typeof message.id!=='string'||message.id.length>80)continue;handle(message);}}catch{process.exit(1);}});
process.stdin.on('end',()=>{client.paused=true;setTimeout(()=>process.exit(0),500);});
