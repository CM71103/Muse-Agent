'use strict';
const {test}=require('node:test');const assert=require('node:assert/strict');const fs=require('fs');const os=require('os');const path=require('path');
test('projects and session membership survive store reload, old chats stay unassigned',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'muse-project-store-'));const old=process.env.MUSE_HOME;process.env.MUSE_HOME=home;
 try{
 const p=require('../projects'),s=require('../session');const project=p.create('Github');p.setFolder(project.id,home);
 const one=s.save({projectId:project.id,title:'Project chat',history:[]});const normal=s.save({title:'Normal',history:[]});
 delete require.cache[require.resolve('../projects')];assert.equal(require('../projects').get(project.id).folder,home);
 assert.equal(s.load(one.id).projectId,project.id);assert.equal(s.load(normal.id).projectId,null);
 assert.equal(s.list().filter(x=>x.projectId===project.id).length,1);
 s.save({id:one.id,history:[{role:'user',content:'hello'}]});assert.equal(s.load(one.id).projectId,project.id);
 }finally{if(old===undefined)delete process.env.MUSE_HOME;else process.env.MUSE_HOME=old;fs.rmSync(home,{recursive:true,force:true});}
});
test('project settings persist and archive preserves session history',()=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),'muse-project-settings-'));const old=process.env.MUSE_HOME;process.env.MUSE_HOME=home;
 try{const p=require('../projects'),s=require('../session');const project=p.create('Draft');const chat=s.save({projectId:project.id,title:'Keep me',history:[{role:'user',content:'notes'}]});p.update(project.id,{name:'Release',description:'Shipping work',instructions:'Use small changes',archived:true});const archived=p.get(project.id);assert.equal(archived.name,'Release');assert.equal(archived.instructions,'Use small changes');assert.equal(archived.archived,true);assert.equal(s.load(chat.id).history.length,1);p.update(project.id,{archived:false});assert.equal(p.get(project.id).archived,false);assert.throws(()=>p.update(project.id,{name:''}));}finally{if(old===undefined)delete process.env.MUSE_HOME;else process.env.MUSE_HOME=old;fs.rmSync(home,{recursive:true,force:true});}
});
