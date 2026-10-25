'use strict';
const fs=require('fs');
const path=require('path');
const {randomUUID}=require('crypto');
const {configDir}=require('./config');
function file(){return path.join(configDir(),'projects.json');}
function list(){if(!fs.existsSync(file()))return [];const rows=JSON.parse(fs.readFileSync(file(),'utf8'));if(!Array.isArray(rows))throw Error('Invalid project store');return rows.map(p=>({description:'',instructions:'',archived:false,...p}));}
function get(id){return list().find(p=>p.id===id)||null;}
function write(rows){fs.mkdirSync(path.dirname(file()),{recursive:true});fs.writeFileSync(file()+'.tmp',JSON.stringify(rows,null,2));fs.renameSync(file()+'.tmp',file());}
function validName(name){name=String(name||'').trim();if(!name||name.length>100)throw Error('Project name must contain 1–100 characters');return name;}
function create(name,folder=null){const rows=list();const now=new Date().toISOString();const p={id:randomUUID(),name:validName(name),description:'',instructions:'',archived:false,folder:folder?path.resolve(folder):null,created:now,updatedAt:now};rows.push(p);write(rows);return p;}
function update(id,patch){const rows=list();const p=rows.find(p=>p.id===id);if(!p)throw Error('Project not found');if('name' in patch)p.name=validName(patch.name);for(const [key,max] of [['description',1000],['instructions',12000]])if(key in patch){if(typeof patch[key]!=='string'||patch[key].length>max)throw Error(`${key} must be text up to ${max} characters`);p[key]=patch[key];}if('archived' in patch){if(typeof patch.archived!=='boolean')throw Error('Invalid archived flag');p.archived=patch.archived;}p.updatedAt=new Date().toISOString();write(rows);return p;}
function setFolder(id,folder){const rows=list();const p=rows.find(p=>p.id===id);if(!p)throw Error('Project not found');p.folder=folder?path.resolve(folder):null;p.updatedAt=new Date().toISOString();write(rows);return p;}
module.exports={list,get,create,update,setFolder};
