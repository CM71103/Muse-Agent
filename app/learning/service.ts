const path=require('node:path'),crypto=require('node:crypto');
const {createLearningWorker}=require('./worker.ts');
function createLearningService(hooks:any){
  const practice=hooks.practice||require('./practice.ts').createPractice({directory:hooks.sandboxDirectory});
  let worker:any;
  const currentScope=()=>String(hooks.getScope());
  async function sourceEvents(){
    const events:any[]=[];const project=hooks.getProjectId?.()||null;
    // Read existing transcripts; do not maintain a second transcript database.
    const sessions=(hooks.sessions?.list?.()||[]).filter((s:any)=>(s.projectId||null)===project).slice(0,3);
    for(const entry of sessions){
      const session=hooks.sessions.load(entry.id);if(!session)continue;
      const history=session.history||[];
      for(let index=Math.max(0,history.length-40);index<history.length;index++){
        const message=history[index];if(!['user','tool'].includes(message.role)||typeof message.content!=='string')continue;
        events.push({source_event_id:`session:${entry.id}:${index}`,text:message.content.slice(0,2000),provenance:message.role==='user'?'user':'tool'});
      }
    }
    const agent=hooks.getAgent?.();events.push(...(agent?._sourceEvents||[]));return events.slice(-100);
  }
  const fingerprint=(lesson:any)=>crypto.createHash('sha256').update(`${lesson.scope}\0${lesson.text.trim()}`).digest('hex');
  async function publish(lessons:any[],scope:string,checkpoint:()=>void){
    checkpoint();const memory=hooks.getAgent?.()?.memory;
    if(currentScope()!==scope)throw Object.assign(Error('Learning scope changed.'),{name:'AbortError'});
    if(!memory?.projectId){for(const lesson of lessons)lesson.memory_status='waiting_for_scope';return;}
    const projectId=memory.projectId;
    const events=lessons.map((lesson:any)=>({source_event_id:'learning:'+fingerprint(lesson),
      text:`Background learning ${lesson.verification==='verified'?'procedure verified by fixed guest tests':lesson.verification==='sourced'?'sourced claim; not independently verified':'observation; not verified success'}:\n${lesson.text}\nEvidence: ${lesson.evidence||''}${lesson.sources?.length?'\nSources: '+lesson.sources.join('\n'):''}`,
      provenance:lesson.verification==='verified'?'tool':'imported',type:lesson.verification==='verified'?'procedure':'fact',channel:'learning',trust_tier:'derived'}));
    // MemoryLayer.ingest inserts the entire batch synchronously before its
    // resolved Promise yields. This check is immediately before acceptance.
    checkpoint();const result=await memory.ingest(events,{projectId});
    for(let i=0;i<lessons.length;i++){
      if(!result[i]?.ok)throw Error('A learning note could not be accepted into memory.');
      lessons[i].memory_id=result[i].id;lessons[i].memory_project_id=projectId;lessons[i].memory_status='stored';
    }
  }
  async function forgetLesson(lesson:any){
    if(!lesson.memory_id)return;
    let memory=hooks.getAgent?.()?.memory,temporary=false;
    if(!memory||memory.projectId!==lesson.memory_project_id){
      const cfg=hooks.getConfig();
      memory=new (require('../memory/layer').MemoryLayer)({...cfg,memory:{...cfg.memory,project_id_strategy:'manual',project_id:lesson.memory_project_id}},
        {dataDir:hooks.memoryDirectory,projectId:lesson.memory_project_id});temporary=true;
    }
    try{const result=memory.deleteMemory(lesson.memory_id,'learning_note_deleted');if(!result.ok&&result.reason!=='not_found')throw Error('The recalled learning note could not be deleted.');}
    finally{if(temporary)await memory.close();}
  }
  async function fetchPage(url:string,signal:AbortSignal){
    const {Sentinel}=require('../harness/sentinel');const sentinel=new Sentinel(hooks.getConfig());sentinel.setMode('auto');
    const verdict=sentinel.decide({tool:'web_fetch',args:{url}});if(verdict.decision==='deny')throw Error('This research source is blocked by a deny rule.');
    const result=await require('../harness/tools').mkWebTool().run({url},{signal,sentinel,tainted:!!hooks.getAgent?.()?.tainted,netPolicy:{allowLocal:false}});
    if(!result.ok)throw Error('The public research source could not be fetched.');
    // Keep evidence in readable source text, never execute page scripts.
    const text=String(result.content||'').replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi,' ').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi,' ').replace(/<[^>]*>/g,' ').replace(/\s+/g,' ').trim();
    return {text};
  }
  const tasks=hooks.tasks||require('./tasks.ts').createLearningTasks({getConfig:()=>worker?.store.data.settings||{},sourceEvents,practice,fetchPage});
  worker=createLearningWorker({directory:hooks.directory,getConfig:hooks.getConfig,getScope:currentScope,busy:hooks.busy,
    systemIdleSeconds:hooks.systemIdleSeconds,emit:hooks.emit,practice,tasks,
    practiceAllowed:async()=>!['running','paused','starting'].includes((await hooks.sandbox.status()).state),
    recallReady:()=>!!hooks.getAgent?.()?.memory?.projectId,publishLessons:publish,forgetLesson});
  const safe=(fn:any)=>async(event:any,...args:any[])=>{hooks.requireTrusted(event);try{return await fn(...args);}catch(e:any){return {ok:false,error:String(e.message||e).slice(0,600)};}};
  const on=(channel:string,fn:any)=>hooks.ipcMain.handle('learning:'+channel,safe(fn));
  on('status',()=>worker.status());on('save',(patch:any)=>worker.save(patch));on('run',(kind:string)=>worker.queue(kind));
  on('pause',()=>worker.pause());on('stop',()=>worker.stop());on('resume',()=>worker.resume());on('delete',(id:string)=>{if(typeof id!=='string'||id.length>80)throw Error('Invalid learning note.');return worker.forget(id);});
  hooks.ipcMain.on('learning:activity',(event:any)=>{try{hooks.requireTrusted(event);worker.touch();}catch{}});
  async function flush(){
    const scope=currentScope(),notes=worker.store.data.jobs.flatMap((job:any)=>job.lessons||[]).filter((v:any)=>v.scope===scope&&!v.memory_id).slice(0,20);
    if(!notes.length||!hooks.getAgent?.()?.memory?.projectId)return;
    await publish(notes,scope,()=>{if(currentScope()!==scope)throw Error('Learning scope changed.');});worker.store.write();
  }
  return {...worker,flush};
}
module.exports={createLearningService};
