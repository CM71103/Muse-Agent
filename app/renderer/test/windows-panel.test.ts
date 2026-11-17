const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const source=require('node:module').stripTypeScriptTypes(fs.readFileSync(path.join(__dirname,'../../../scripts/renderer/windows-panel.ts'),'utf8'));
class Element {
 id='';hidden=false;disabled=false;className='';src='';attrs:any={};children:any[]=[];listeners:any={};parent:any=null;doc:any;_text='';
 set textContent(value:any){this._text=String(value);this.children=[];}
 get textContent():string{return this.children.length?this.children.map(node=>node.textContent).join(''):this._text;}
 append(...nodes:any[]){for(const node of nodes){node.parent=this;this.children.push(node);}}
 replaceChildren(...nodes:any[]){this.children=[];this.append(...nodes);}
 remove(){if(this.parent)this.parent.children=this.parent.children.filter((node:any)=>node!==this);}
 get firstElementChild(){return this.children[0];}
 setAttribute(name:string,value:any){this.attrs[name]=value;}
 removeAttribute(name:string){delete this.attrs[name];if(name==='src')this.src='';}
 addEventListener(name:string,fn:any){(this.listeners[name]??=[]).push(fn);}
 focus(){this.doc.activeElement=this;}
 getClientRects(){return [1];}
 querySelectorAll(){return [];}
}
function setup(api:any,busy=()=>false){
 const all:any[]=[];const document:any={activeElement:null,createElement:()=>{const node=new Element();node.doc=document;all.push(node);return node;}};
 document.body=document.createElement('body');const composer=document.createElement('div');document.body.append(composer);
 document.querySelector=()=>composer;
 const window:any={};vm.runInNewContext(source,{window,document,console});const panel=window.MuseWindows.create({api,busy});
 const el=(id:string)=>all.find(node=>node.id===id);const click=(node:any)=>{for(const fn of node.listeners.click||[])fn({target:node});};
 return {panel,el,click};
}
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const target={id:'opaque-target',title:'Fixture notes',processName:'notepad',pid:42,width:500,height:400};

test('Windows panel creates themed controls but never selects or captures a window on its own',async()=>{
 let selections=0;const t=setup({windowsList:async()=>({windows:[target]}),windowsStatus:async()=>({state:'unselected',selected:null,revision:0}),windowsSelect:async()=>{selections++;}});
 assert.equal(t.el('windows-desktop-backdrop').hidden,true);await t.panel.refresh();
 assert.equal(t.el('windows-window-list').children.length,1);assert.equal(selections,0);
 assert.equal(t.el('windows-panel-status').textContent,'No window selected');assert.equal(t.el('windows-preview-image').hidden,true);
});

test('selected window accepts newer screenshots, rejects older revisions and release clears the preview',async()=>{
 const t=setup({windowsList:async()=>({windows:[target]}),windowsStatus:async()=>({selected:null,revision:0}),
 windowsSelect:async()=>({state:'selected',selected:target,revision:1}),windowsRelease:async()=>({state:'unselected',selected:null,revision:2})});
 await t.panel.refresh();t.click(t.el('windows-window-list').children[0]);await settle();
 assert.equal(t.el('windows-panel-status').textContent,'Window selected');
 const result={ok:true,revision:0,images:[{mimeType:'image/png',data:'AQ=='}]};t.panel.event({name:'windows_screenshot',type:'tool_result',result});
 assert.equal(t.el('windows-preview-image').hidden,true);
 result.revision=2;t.panel.event({name:'windows_screenshot',type:'tool_result',result});assert.equal(t.el('windows-preview-image').hidden,false);
 result.revision=1;result.images[0].data='Ag==';t.panel.event({name:'windows_screenshot',type:'tool_result',result});assert.equal(t.el('windows-preview-image').src,'data:image/png;base64,AQ==');
 t.click(t.el('windows-panel-release'));await settle();assert.equal(t.el('windows-preview-image').hidden,true);assert.equal(t.el('windows-preview-image').src,'');
 t.panel.event({name:'windows_screenshot',type:'tool_result',result});assert.equal(t.el('windows-preview-image').hidden,true);
});

test('busy work blocks target changes but keeps explicit release available',async()=>{
 let selecting=0,releasing=0;const t=setup({windowsList:async()=>({windows:[target]}),windowsStatus:async()=>({selected:target,revision:1}),
 windowsSelect:async()=>{selecting++;},windowsRelease:async()=>{releasing++;return {selected:null,revision:2};}},()=>true);
 await t.panel.refresh();const choice=t.el('windows-window-list').children[0];assert.equal(choice.disabled,true);
 t.click(choice);await settle();assert.equal(selecting,0);assert.equal(t.el('windows-panel-release').disabled,false);
 t.click(t.el('windows-panel-release'));await settle();assert.equal(releasing,1);
});

test('Windows listing errors are visible and unrelated tool activity is ignored',async()=>{
 const t=setup({windowsList:async()=>{throw Error('Windows automation is unavailable');},windowsStatus:async()=>({selected:null})});
 await t.panel.refresh();assert.match(t.el('windows-panel-error').textContent,/unavailable/);
 assert.equal(t.panel.event({name:'shell',type:'tool_call'}),false);
 for(let i=0;i<30;i++)t.panel.event({name:'windows_click',type:'tool_call'});
 assert.equal(t.el('windows-activity-list').children.length,25);
});
