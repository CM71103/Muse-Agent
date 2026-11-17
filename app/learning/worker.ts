const {randomUUID}=require('node:crypto');
const {createLearningStore}=require('./store.ts');
const {LlmClient}=require('../harness/llm');
const FAILURE_BACKOFF_LIMIT=3;
function createLearningWorker(options:any){
  const store=options.store||createLearningStore(options.directory),now=options.now||Date.now;
  let touched=now(),nextRun=now(),queued:string|null=null,active:any=null,closing=false,timer:any=null,rotation=0;
  let ready:any={ready:null,detail:'Practice prerequisites are checked before a session.'},lastError='';
  let consecutiveFailures=0,circuitPaused=false;
  function recordFailure(reason=lastError){
    consecutiveFailures++;
    if(consecutiveFailures>=FAILURE_BACKOFF_LIMIT && !circuitPaused){
      circuitPaused=true;
      try{store.save({enabled:false});}catch{}
      lastError=`Learning paused after ${consecutiveFailures} consecutive failures${reason?': '+reason:''}. Correct the cause, then use Resume learning.`;
      try{emit();}catch{}
      return true;
    }
    return false;
  }
  function clearFailures(){consecutiveFailures=0;circuitPaused=false;}
  const emit=()=>{try{options.emit?.(status());}catch{}};
  const scope=()=>String(options.getScope?.()||'personal');
  const idle=()=>Math.min((now()-touched)/1000,Math.max(0,options.systemIdleSeconds?.()??Infinity));
  function scheduleSummary(minutesIdle:number,minutesInterval:number){
    return `After ${minutesIdle} minute${minutesIdle===1?'':'s'} idle, runs about every ${minutesInterval} minute${minutesInterval===1?'':'s'} while enabled.`;
  }
  function status(){
    const s=store.data.settings,used=store.used(now());
    const state=!store.available()?'error':circuitPaused?'error':!s.enabled?'disabled':active?'running':options.recallReady&&!options.recallReady()?'waiting_for_memory_scope':used>=s.daily_token_cap?'budget_exhausted':options.busy?.()||idle()<s.idle_minutes*60?'waiting_for_idle':'idle';
    return {settings:{...s},state,scope:scope(),schedule_summary:scheduleSummary(s.idle_minutes,s.interval_minutes),
      active:active?{id:active.id,kind:active.kind,started:active.started}:null,
      can_resume:store.available()&&!s.enabled&&!store.error()&&!circuitPaused,
      queued_kind:queued,used_tokens:used,reserved_tokens:active?.reserved||0,next_run:new Date(Math.max(nextRun,touched+s.idle_minutes*60000)).toISOString(),
      jobs:store.data.jobs.slice(-30).toReversed(),practiceReady:ready.ready,practiceDetail:ready.detail,
      recallReady:!!options.recallReady?.(),error:store.error()||lastError};
  }
  function checkpoint(job:any){
    job.controller.signal.throwIfAborted();
    if(closing||!store.data.settings.enabled||options.busy?.()||scope()!==job.scope||idle()<store.data.settings.idle_minutes*60)throw Object.assign(Error('Learning paused for foreground activity.'),{name:'AbortError'});
  }
  function touch(){touched=now();if(active){active.controller.abort();emit();}}
  async function refreshReadiness(){
    try{ready=await options.practice?.ready?.()||{ready:false,detail:'Practice is not configured.'};}catch{ready={ready:false,detail:'The Ubuntu practice prerequisites could not be checked.'};}emit();return ready;
  }
  async function chat(job:any,messages:any[],maxOutput:number){
    checkpoint(job);if(++job.calls>2)throw Error('Learning session reached its two-request limit.');
    if(!Array.isArray(messages)||messages.some(m=>!['system','user'].includes(m.role)||typeof m.content!=='string')||!Number.isSafeInteger(maxOutput)||maxOutput<1||maxOutput>2048)throw Error('Invalid learning model request.');
    const bytes=Buffer.byteLength(JSON.stringify(messages),'utf8');
    if(bytes>30000)throw Error('Learning input exceeded its size limit.');
    const cfg=options.getConfig();
    if(!cfg.llm?.base_url||!cfg.llm?.model)throw Error('Configure a chat model before enabling learning.');
    if(cfg.llm.key_origin&&new URL(cfg.llm.base_url).origin.toLowerCase()!==cfg.llm.key_origin.toLowerCase())throw Error('Re-save the chat connection key for this provider before learning.');
    const reserve=bytes+maxOutput+256,key=store.charge(now(),reserve);job.reserved+=reserve;job.tokens+=reserve;emit();
    // One request only; failed or canceled requests keep their reservation.
    const requestCfg={...cfg,llm:{...cfg.llm,max_tokens:maxOutput,temperature:0.1,retry_attempts:1,timeout_s:45}};
    const client=options.client?.(requestCfg)||new LlmClient(requestCfg);
    const result=await client.chat(messages,null,{signal:job.controller.signal});
    const u=result?.usage,actual=Number(u?.total_tokens)||Number(u?.prompt_tokens)+Number(u?.completion_tokens);
    store.settle(key,reserve,actual);if(Number.isFinite(actual)&&actual>0)job.tokens+=Math.ceil(actual)-reserve;
    job.reserved-=reserve;checkpoint(job);emit();return result;
  }
  async function run(kind:string){
    const job:any={id:randomUUID(),kind,scope:scope(),started:new Date(now()).toISOString(),status:'running',tokens:0,reserved:0,calls:0,lessons:[],controller:new AbortController()};
    active=job;store.data.jobs.push({id:job.id,kind,scope:job.scope,started:job.started,status:'running',tokens:0,lessons:[]});store.data.jobs=store.data.jobs.slice(-80);
    const record=store.data.jobs.at(-1);const deadline=setTimeout(()=>job.controller.abort(),kind==='practice'?600000:120000);
    try{
      store.write();emit();
      checkpoint(job);
      if(kind==='practice'){
        const availability=await refreshReadiness();checkpoint(job);if(!availability.ready)throw Error(availability.detail||'Practice is not ready.');
        if(options.practiceAllowed && !await options.practiceAllowed())throw Error('Practice waits until your interactive Ubuntu sandbox is stopped or saved.');
      }
      const result=await options.tasks.run(kind,{signal:job.controller.signal,settings:{...store.data.settings},checkpoint:()=>checkpoint(job),chat:(messages:any[],limit:number)=>chat(job,messages,limit)});
      checkpoint(job);
      const lessons=(result.lessons||[]).slice(0,5).map((lesson:any)=>({...lesson,id:randomUUID(),scope:job.scope,created:new Date(now()).toISOString()}));
      // Canonical memory remains the only source used for future recall.
      if(options.publishLessons)await options.publishLessons(lessons,job.scope,()=>checkpoint(job));
      checkpoint(job);Object.assign(record,{status:'completed',summary:String(result.summary||'Learning session completed.').slice(0,600),lessons});clearFailures();lastError='';
    }catch(error:any){
      const aborted=job.controller.signal.aborted||error.name==='AbortError';
      Object.assign(record,{status:aborted?'paused':'failed',summary:aborted?'Paused when you returned. No lessons were accepted.':'No lessons were accepted.',error:aborted?'':String(error.message||error).slice(0,600),lessons:[]});
      if(!aborted)lastError=record.error;
    }finally{
      clearTimeout(deadline);Object.assign(record,{finished:new Date(now()).toISOString(),tokens:job.tokens});active=null;nextRun=now()+store.data.settings.interval_minutes*60000;
      let failureReason:any=null;
      try{store.write();}catch(e:any){failureReason=String(e.message||e||'The learning result could not be saved.');lastError=failureReason;}
      if(record.status==='failed'||failureReason){
        const reason=failureReason||record.error||lastError;
        if(reason)recordFailure(reason);
      }
      emit();
    }
  }
  let pending:Promise<any>|null=null;
  async function tick(){
    if(active && (options.busy?.()||idle()<store.data.settings.idle_minutes*60)){active.controller.abort();return;}
    const s=store.data.settings;
    if(closing||active||!store.available()||!s.enabled||options.recallReady&&!options.recallReady()||options.busy?.()||idle()<s.idle_minutes*60||store.used(now())>=s.daily_token_cap||(!queued&&now()<nextRun))return;
    const kinds=['review','practice','research'].filter(k=>s[k]);if(!kinds.length)return;
    const kind=queued||kinds[rotation++%kinds.length];queued=null;
    if(kind==='research'&&(!s.topics.length||!s.sources.length)){nextRun=now()+s.interval_minutes*60000;emit();return;}
    pending=run(kind).catch((error:any)=>{if(!recordFailure(String(error.message||error)))lastError=String(error.message||error).slice(0,600);}).finally(()=>{pending=null;});await pending;
  }
  function start(){if(timer)return;refreshReadiness().catch(()=>{});timer=setInterval(()=>tick().catch((e:any)=>{lastError=String(e.message||e).slice(0,600);emit();}),10000);timer.unref?.();}
  async function save(patch:any){touch();clearFailures();store.save(patch);lastError='';nextRun=now();emit();return status();}
  async function pause(){touch();queued=null;store.save({enabled:false});emit();return status();}
  async function stop(){touch();queued=null;if(active){active.controller.abort();active=null;}emit();return status();}
  async function resume(){return save({enabled:true});}
  async function queue(kind:string){if(!['review','practice','research'].includes(kind)||!store.data.settings[kind]||!store.data.settings.enabled)throw Error('Enable this learning activity first.');if(kind==='research'&&(!store.data.settings.topics.length||!store.data.settings.sources.length))throw Error('Choose research topics and HTTPS source pages first.');queued=kind;touched=now();emit();return status();}
  async function forget(id:string){
    touch();let found:any=null;
    for(const job of store.data.jobs){const lesson=job.lessons?.find((v:any)=>v.id===id);if(lesson){found=lesson;break;}}
    if(!found)throw Error('This learning note is unavailable.');
    await options.forgetLesson?.(found);
    for(const job of store.data.jobs)job.lessons=(job.lessons||[]).filter((lesson:any)=>lesson.id!==id);
    store.write();emit();return status();
  }
  async function close(){closing=true;if(timer)clearInterval(timer);timer=null;active?.controller.abort();try{await pending;}finally{store.close();}}
  return {status,start,tick,touch,save,pause,stop,resume,queue,forget,close,refreshReadiness,settled:()=>pending||Promise.resolve(),store};
}
module.exports={createLearningWorker};
