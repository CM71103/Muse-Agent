'use strict';
// Offline diagnostic. Never calls providers. Close Muse first: owner lock enforced.
const path=require('path');
const {loadConfig,configDir}=require('./app/harness/config');
const {MemoryLayer}=require('./app/memory/layer');
let mem;
try {
  const cfg=loadConfig();
  console.log('Config:',cfg._configFile,'Scope strategy:',cfg.memory.project_id_strategy);
  mem=new MemoryLayer(cfg,{dataDir:path.join(configDir(),'memory'),cwd:process.cwd()});
  console.log('Selected scope:',mem.projectId,'Store:',mem.store.file);
  console.log('Status counts:',JSON.stringify(mem.healthMetrics()));
  console.log('Selected scope records:',mem.listMemories().length);
  console.log('Other valid scopes remain isolated; this launch cwd does not establish app scope failure.');
} catch(e) {console.error(e.message);process.exitCode=1;}
finally {if(mem)mem.close();}
