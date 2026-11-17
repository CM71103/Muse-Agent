const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const {stripTypeScriptTypes}=require('node:module');
const source=stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../../../scripts/renderer/box-panel.ts'),'utf8'));
class Element {
  id='';hidden=false;disabled=false;textContent='';src='';alt='';title='';className='';parent:any=null;children:any[]=[];attrs:any={};listeners:any={};doc:any;
  append(...nodes:any[]){for(const node of nodes){node.parent=this;this.children.push(node);}}
  replaceChildren(...nodes:any[]){this.children=[];this.append(...nodes);}
  remove(){if(this.parent)this.parent.children=this.parent.children.filter((node:any)=>node!==this);}
  get firstElementChild(){return this.children[0];}
  setAttribute(key:string,value:any){this.attrs[key]=value;}
  removeAttribute(key:string){delete this.attrs[key];if(key==='src')this.src='';}
  addEventListener(key:string,fn:any){(this.listeners[key]??=[]).push(fn);}
  focus(){this.doc.activeElement=this;}
  querySelectorAll(){return this.children;}
  getClientRects(){return [1];}
}
function setup(api:any={},busy=()=>false){
  const nodes=new Map();const document:any={activeElement:null,createElement:()=>{const n=new Element();n.doc=document;return n;},getElementById:(id:string)=>{if(!nodes.has(id)){const n=new Element();n.id=id;n.doc=document;nodes.set(id,n);}return nodes.get(id);}};
  const window:any={muse:api};const context=vm.createContext({window,document,console});vm.runInContext(source,context);
  const panel=window.MuseBox.create({busy});return {panel,nodes,click:(id:string)=>{for(const fn of nodes.get(id).listeners.click||[])fn({target:nodes.get(id)});}};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));

test('Box UI never starts authentication just by loading or checking status',async()=>{
 let connects=0;const t=setup({boxConnect:async()=>{connects++;},boxStatus:async()=>({state:'disconnected'})});
 await t.panel.refresh();assert.equal(connects,0);assert.equal(t.nodes.get('box-settings-status').textContent,'Disconnected');
 assert.equal(t.nodes.get('box-panel-open').disabled,true);assert.equal(t.nodes.get('box-preview-image').hidden,true);
});

test('Box sign-in progress follows backend status and enables desktop controls only after connection',async()=>{
 let complete:any;let onStatus:any;let opens=0;
 const t=setup({boxStatus:async()=>({state:'connected',tools:4}),boxConnect:()=>new Promise(resolve=>complete=resolve),
 onBoxStatus:(fn:any)=>{onStatus=fn;return()=>{};},boxOpenDesktop:async()=>{opens++;return{ok:true};}});
 t.click('box-settings-connect');assert.equal(t.nodes.get('box-panel-status').textContent,'Connecting');
 assert.equal(t.nodes.get('box-panel-cancel').hidden,false);onStatus({state:'authorizing'});
 assert.equal(t.nodes.get('box-panel-status').textContent,'Waiting for sign-in');
 complete({ok:true,state:'connected',tools:4});await settle();
 assert.equal(t.nodes.get('box-panel-status').textContent,'Connected');assert.match(t.nodes.get('box-panel-detail').textContent,/4 cloud desktop tools/);
 assert.equal(t.nodes.get('box-panel-open').disabled,false);t.click('box-panel-open');await settle();assert.equal(opens,1);
});

test('busy agent blocks connection changes and connector errors redact credentials',async()=>{
 let connects=0;const t=setup({boxConnect:async()=>{connects++;throw Error('Bearer secret-value cb_privatekey123 ?access_token=private');}},()=>true);
 t.click('box-settings-connect');await settle();assert.equal(connects,0);
 const other=setup({boxConnect:async()=>{throw Error('Bearer secret-value cb_privatekey123 ?access_token=private');}});
 other.click('box-settings-connect');await settle();const message=other.nodes.get('box-panel-error').textContent;
 assert.doesNotMatch(message,/secret-value|privatekey123|=private/);assert.equal(other.nodes.get('box-settings-status').textContent,'Connection problem');
});

test('Box screenshots reject unsupported or oversized content and clear on disconnect',()=>{
 const t=setup();const image={mimeType:'image/png',data:'AQ=='};
 assert.equal(t.panel.handleImage(image),false,'Disconnected connector cannot show a late screenshot');
 t.panel.status({state:'connected'});assert.equal(t.panel.handleImage({...image,mimeType:'image/svg+xml'}),false);
 assert.equal(t.panel.handleImage({...image,data:'a'.repeat(12*1024*1024)}),false);
 assert.equal(t.panel.handleImage(image),true);assert.match(t.nodes.get('box-preview-image').src,/^data:image\/png;base64,/);
 t.panel.status({state:'disconnected'});assert.equal(t.nodes.get('box-preview-image').hidden,true);assert.equal(t.nodes.get('box-preview-image').src,'');
});

test('Box activity contains only its own tool labels and is bounded',()=>{
 const t=setup();assert.equal(t.panel.event({name:'shell',type:'tool_call'}),false);
 for(let i=0;i<40;i++)t.panel.event({name:'mcp__box__shell',type:'tool_call'});
 assert.equal(t.nodes.get('box-activity-list').children.length,30);
 t.panel.event({name:'mcp__box__shell',type:'tool_result',denied:true});
 assert.equal(t.nodes.get('box-activity-list').children.at(-1).textContent,'Denied · shell');
});
