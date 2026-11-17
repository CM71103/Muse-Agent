const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=require('node:module').stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../../../scripts/renderer/sandbox-panel.ts'),'utf8'));
class Element {
 id='';hidden=false;disabled=false;className='';src='';value='';attrs:any={};children:any[]=[];listeners:any={};parent:any=null;doc:any;_text='';width=400;height=300;
 set textContent(value:any){this._text=String(value);this.children=[];}
 get textContent():string{return this.children.length?this.children.map(node=>node.textContent).join(''):this._text;}
 append(...nodes:any[]){for(const node of nodes){node.parent=this;this.children.push(node);}}
 insertBefore(node:any,before:any){node.parent=this;this.children.splice(this.children.indexOf(before),0,node);}
 replaceChildren(...nodes:any[]){this.children=[];this.append(...nodes);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter((node:any)=>node!==this);}
 get firstElementChild(){return this.children[0];}
 setAttribute(name:string,value:any){this.attrs[name]=value;}
 removeAttribute(name:string){delete this.attrs[name];if(name==='src')this.src='';}
 addEventListener(name:string,fn:any){(this.listeners[name]??=[]).push(fn);}
 focus(){this.doc.activeElement=this;}
 click(){for(const fn of this.listeners.click||[])fn({target:this,preventDefault(){},stopPropagation(){}});}
 getClientRects(){return [1];}
 getBoundingClientRect(){return{left:0,top:0,width:this.width,height:this.height};}
 querySelectorAll(){return [];}
 querySelector(){return null;}
}
function setup(api:any,busy=()=>false){
 const all:any[]=[];const document:any={activeElement:null,hidden:false,createElement:()=>{const n=new Element();n.doc=document;all.push(n);return n;}};
 document.body=document.createElement('body');const dock=document.createElement('div');document.body.append(dock);document.querySelector=()=>dock;
 const timers=new Map();let timerId=0;const setTimeout=(fn:any,delay:number)=>{const id=++timerId;timers.set(id,{fn,delay});return id;};const clearTimeout=(id:number)=>timers.delete(id);
 const window:any={};vm.runInNewContext(source,{window,document,console,setTimeout,clearTimeout});const panel=window.MuseSandbox.create({api,busy});
 const el=(id:string)=>all.find(node=>node.id===id);
 const fire=(node:any,type:string,event:any={})=>{for(const fn of node.listeners[type]||[])fn({target:node,preventDefault(){},stopPropagation(){},...event});};
 return{panel,el,document,timers,fire,tick:()=>{const entry=timers.entries().next().value;if(!entry)return;timers.delete(entry[0]);entry[1].fn();}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const running=()=>({state:'running',available:true,vmId:'fixture-vm',selected:true,checkpoint:false});
const frame=()=>({ok:true,data:'AQ==',width:800,height:600});

test('sandbox setup is explicit and does not capture or create a VM by loading the panel',async()=>{
 let captures=0,creates=0;const t=setup({sandboxStatus:async()=>({state:'missing_iso',available:true}),sandboxFrame:async()=>{captures++;return frame();},sandboxCreate:async()=>{creates++;}});
 await t.panel.refresh();assert.equal(captures,0);assert.equal(creates,0);assert.equal(t.el('sandbox-create').disabled,true);
 assert.equal(t.el('sandbox-backdrop').hidden,true);assert.equal(t.el('sandbox-frame').hidden,true);
 assert.equal(t.el('sandbox-text').type,'text');assert.match(t.el('sandbox-text').placeholder,/literal text/);assert.match(t.el('sandbox-task-hint').textContent,/ask Muse in the chat box/);
});

test('guest screen polls while open and ignores a screenshot arriving after close',async()=>{
 let captures=0,complete:any;const t=setup({sandboxStatus:async()=>running(),sandboxFrame:()=>{captures++;return new Promise(resolve=>complete=resolve);}});
 t.panel.open();await settle();assert.equal(captures,0);t.tick();await settle();assert.equal(captures,1);
 t.panel.close();complete(frame());await settle();assert.equal(t.el('sandbox-frame').hidden,true);assert.equal(t.timers.size,0);
});

test('reset requires a clean snapshot and a separate inline confirmation',async()=>{
 let resets=0;let checkpoint=false;const t=setup({sandboxStatus:async()=>({...running(),checkpoint}),sandboxCheckpoint:async()=>{checkpoint=true;return {ok:true};},sandboxReset:async()=>{resets++;return{ok:true};}});
 await t.panel.refresh();assert.equal(t.el('sandbox-reset').disabled,true);
 t.fire(t.el('sandbox-reset'),'click');assert.equal(t.el('sandbox-reset-prompt').hidden,true);
 t.fire(t.el('sandbox-checkpoint'),'click');await settle();assert.equal(t.el('sandbox-reset').disabled,false);
 t.fire(t.el('sandbox-reset'),'click');assert.equal(resets,0);assert.equal(t.el('sandbox-reset-prompt').hidden,false);
 t.fire(t.el('sandbox-reset-confirm'),'click');await settle();assert.equal(resets,1);assert.equal(t.el('sandbox-reset-prompt').hidden,true);
});

test('guest input maps screen clicks to guest pixels and rejects unsupported pasted text',async()=>{
 const inputs:any[]=[];const t=setup({sandboxStatus:async()=>running(),sandboxFrame:async()=>frame(),sandboxInput:async(value:any)=>{inputs.push(value);return{ok:true};}});
 t.panel.open();await settle();t.tick();await settle();assert.equal(t.el('sandbox-frame').hidden,false);
 t.fire(t.el('sandbox-frame'),'click',{clientX:100,clientY:75});await settle();assert.deepEqual(JSON.parse(JSON.stringify(inputs[0])),{kind:'click',x:200,y:150,button:'left'});
 t.fire(t.el('sandbox-screen'),'keydown',{key:'Enter',isComposing:false,metaKey:false});await settle();assert.equal(inputs[1].key,'ENTER');
 t.el('sandbox-text').value='open file manager';t.fire(t.el('sandbox-text'),'keydown',{key:'Enter'});await settle();assert.equal(inputs[2].text,'open file manager');
 t.el('sandbox-text').value='non-ASCII λ';t.fire(t.el('sandbox-send-text'),'click');await settle();assert.equal(inputs.length,3);assert.match(t.el('sandbox-error').textContent,/printable ASCII/);
 t.panel.close();
});

test('stop remains available during agent work and F6 releases guest keyboard focus',async()=>{
 let stops=0;const t=setup({sandboxStatus:async()=>running(),sandboxStop:async()=>{stops++;return{ok:true,state:'saved',available:true,vmId:'fixture-vm',selected:true};}},()=>true);
 await t.panel.refresh();assert.equal(t.el('sandbox-stop').disabled,false);assert.equal(t.el('sandbox-checkpoint').disabled,true);
 t.fire(t.el('sandbox-screen'),'keydown',{key:'F6'});assert.equal(t.document.activeElement,t.el('sandbox-close'));
 t.fire(t.el('sandbox-stop'),'click');await settle();assert.equal(stops,1);assert.equal(t.el('sandbox-status').textContent,'Saved');
});

test('selecting host tools leaves the running guest visible and offers reselect sandbox',async()=>{
 const t=setup({sandboxStatus:async()=>running(),sandboxUseHost:async()=>({...running(),selected:false,ok:true}),sandboxStart:async()=>({...running(),ok:true})});
 await t.panel.refresh();t.fire(t.el('sandbox-use-host'),'click');await settle();
 assert.equal(t.el('sandbox-target').textContent,'Agent: host');assert.equal(t.el('sandbox-start').textContent,'Use sandbox');assert.equal(t.el('sandbox-start').disabled,false);
 t.fire(t.el('sandbox-start'),'click');await settle();assert.equal(t.el('sandbox-target').textContent,'Agent: sandbox');
});

test('incomplete owned VM setup offers retry while preserving its selected ISO',async()=>{
 let creates=0;const t=setup({sandboxStatus:async()=>({state:'stopped',available:true,vmId:'owned',iso:'fixture.iso',setupIncomplete:true}),sandboxCreate:async()=>{creates++;return{state:'stopped',available:true,vmId:'owned',iso:'fixture.iso'};},sandboxChooseISO:async()=>({}),sandboxStart:async()=>({})});
 await t.panel.refresh();assert.equal(t.el('sandbox-setup').hidden,false);assert.equal(t.el('sandbox-create').hidden,false);assert.equal(t.el('sandbox-create').textContent,'Retry VM setup');assert.equal(t.el('sandbox-create').disabled,false);assert.equal(t.el('sandbox-choose-iso').disabled,true);assert.equal(t.el('sandbox-start').disabled,true);
 t.fire(t.el('sandbox-create'),'click');await settle();assert.equal(creates,1);assert.equal(t.el('sandbox-setup').hidden,true);
});
