const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const DEFAULTS={enabled:false,review:true,practice:true,research:true,idle_minutes:5,interval_minutes:30,daily_token_cap:20000,topics:[],sources:[]};
function settings(input:any,previous:any=DEFAULTS){
  if(!input||typeof input!=='object'||Array.isArray(input))throw Error('Invalid learning settings.');
  if(Object.keys(input).some(key=>!Object.hasOwn(DEFAULTS,key)))throw Error('Unknown learning setting.');
  const result:any={...previous,...input};
  for(const key of ['enabled','review','practice','research'])if(typeof result[key]!=='boolean')throw Error('Invalid learning switch.');
  for(const [key,min,max] of [['idle_minutes',1,120],['interval_minutes',5,1440],['daily_token_cap',2000,200000]] as any){
    if(!Number.isSafeInteger(result[key])||result[key]<min||result[key]>max)throw Error(`Invalid ${key}: use ${min}–${max}.`);
  }
  for(const key of ['topics','sources']){
    if(!Array.isArray(result[key])||result[key].length>10||result[key].some((v:any)=>typeof v!=='string'||!v.trim()||v.length>(key==='topics'?300:2048)))throw Error(`Use up to ten learning ${key}.`);
    result[key]=[...new Set(result[key].map((v:string)=>v.trim()))];
  }
  for(const source of result.sources){const url=new URL(source);if(url.protocol!=='https:'||url.username||url.password||/\b(?:key|token|password|secret|auth)=/i.test(url.search))throw Error('Use public HTTPS source URLs without credentials.');}
  if(result.enabled&&!['review','practice','research'].some(key=>result[key]))throw Error('Choose at least one learning activity.');
  return result;
}
function createLearningStore(directory:string){
  fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'learning.json'),lock=path.join(directory,'worker.lock');
  const nonce=crypto.randomUUID();let owned=false,error='',guarded=false;
  const guard=path.join(directory,'worker.guard');
  try{fs.mkdirSync(guard);guarded=true;}catch{error='Another learning worker is starting. Restart Muse after it finishes.';}
  for(let attempt=0;attempt<2&&!owned&&guarded;attempt++){
    try{const fd=fs.openSync(lock,'wx');try{fs.writeFileSync(fd,JSON.stringify({pid:process.pid,nonce}));}finally{fs.closeSync(fd);}owned=true;}
    catch(e:any){
      if(e.code!=='EEXIST'){error='The learning data directory is not writable.';break;}
      try{const old=JSON.parse(fs.readFileSync(lock,'utf8'));if(!Number.isSafeInteger(old.pid)||old.pid<1)throw Error('Invalid worker lock');
        try{process.kill(old.pid,0);error='Learning is managed by another Muse window. Close that instance first.';break;}catch(probe:any){if(probe.code!=='ESRCH')throw probe;}
        // Every contender holds the exclusive guard while checking/replacing
        // a dead PID's lease, so it cannot unlink a newly acquired lease.
        fs.unlinkSync(lock);
      }catch{error='The learning worker lock could not be verified.';break;}
    }
  }
  if(guarded)fs.rmdirSync(guard);
  let data:any={version:1,settings:{...DEFAULTS},usage:{},jobs:[],sources:[]};
  try{
    if(fs.statSync(file).size>2*1024*1024)throw Error('Learning history exceeds its limit');
    const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    data={...data,...saved,settings:settings(saved.settings),jobs:Array.isArray(saved.jobs)?saved.jobs.slice(-80):[],sources:Array.isArray(saved.sources)?saved.sources.slice(-200):[],usage:saved.usage||{}};
    for(const job of data.jobs)if(job.status==='running'){job.status='interrupted';job.finished=new Date().toISOString();job.error='The previous Muse session ended during this job.';}
  }catch(e:any){if(e.code!=='ENOENT')error='Learning history could not be loaded. Learning stays disabled.';data.settings={...DEFAULTS};}
  function write(){if(!owned||error)throw Error(error||'Learning worker is unavailable.');
    fs.writeFileSync(file+'.tmp',JSON.stringify(data,null,2));fs.renameSync(file+'.tmp',file);
  }
  function close(){if(!owned)return;try{if(JSON.parse(fs.readFileSync(lock,'utf8')).nonce===nonce)fs.unlinkSync(lock);}catch{}owned=false;}
  const day=(now:number)=>new Date(now).toISOString().slice(0,10);
  function charge(now:number,n:number){
    if(!Number.isSafeInteger(n)||n<0)throw Error('Invalid learning budget reservation.');
    const key=day(now),used=Number(data.usage[key]||0);
    if(!Number.isFinite(used)||used<0||used+n>data.settings.daily_token_cap)throw Object.assign(Error('Daily learning token budget is exhausted.'),{code:'LEARNING_BUDGET'});
    data.usage[key]=used+n;
    for(const old of Object.keys(data.usage))if(old<day(now-31*86400000))delete data.usage[old];
    write();return key;
  }
  function settle(key:string,reserved:number,actual:number){
    if(!Number.isFinite(actual)||actual<=0)return;
    data.usage[key]=Math.max(0,Number(data.usage[key]||0)-reserved+Math.ceil(actual));write();
  }
  return {data,write,close,charge,settle,used:(now:number)=>Number(data.usage[day(now)]||0),error:()=>error,available:()=>owned&&!error,
    save:(patch:any)=>{const next=settings(patch,data.settings);data.settings=next;write();return next;}};
}
module.exports={createLearningStore,validateSettings:settings,DEFAULTS};
