#!/usr/bin/env node
'use strict';
// cli.js - headless agent runner. Usage:
//   node app/harness/cli.js "task text"
// Approvals: CLI cannot prompt interactively mid-loop safely, so shell/hands default-deny
// unless --yes (auto-approve) or MUSE_APPROVE=1. Mirrors nanoMuse "no approver = deny".

const path = require('path');
const readline = require('readline');
const { loadConfig,configDir } = require('./config');
const { Agent } = require('./agent');

async function main() {
  const args = process.argv.slice(2);
  const task = args.filter(a => !a.startsWith('--')).join(' ');
  const autoYes = args.includes('--yes') || process.env.MUSE_APPROVE === '1';
  if (!task) {
    console.error('usage: node app/harness/cli.js "task" [--yes]');
    process.exit(1);
  }

  const cfg = loadConfig();
  const approver = autoYes
    ? async () => true
    : await makePromptApprover();

  const agent = new Agent(cfg, {
    approver,
    onEvent: (ev) => {
      switch (ev.type) {
        case 'message': process.stdout.write(`\n[muse] ${ev.text}\n`); break;
        case 'tool_call':
          process.stdout.write(`\n> tool: ${ev.name} ${JSON.stringify(ev.args).slice(0, 200)}\n`); break;
        case 'tool_result':
          if (ev.denied) process.stdout.write(`  denied: ${ev.reason}\n`);
          else process.stdout.write(`  -> ${JSON.stringify(ev.result).slice(0, 200)}\n`);
          break;
        case 'info': process.stdout.write(`\n[i] ${ev.text}\n`); break;
        case 'error': process.stderr.write(`\n[error] ${ev.text}\n`); break;
      }
    },
  });

  if(cfg.memory.enabled) {
    const {MemoryLayer}=require('../memory/layer');
    agent.attachMemory(new MemoryLayer(cfg,{dataDir:path.join(configDir(),'memory'),cwd:process.cwd()}));
  }
  try {
    const res = await agent.run(task);
    await agent.ingestUserTurn(task);
    if(agent.memory)agent.memory.close();
    process.stdout.write(`\n=== done (${res.turns} turns) ===\n`);
    process.exit(0);
  } catch (e) {
    if(agent.memory)agent.memory.close();
    console.error(`agent failed: ${e.message}`);
    process.exit(1);
  }
}

function makePromptApprover() {
  return async (request) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    return await new Promise((resolve) => {
      rl.question(`\nAPPROVE tool "${request.tool}"? ${JSON.stringify(request.args).slice(0, 300)} [y/N] `, (ans) => {
        rl.close();
        resolve(ans.trim().toLowerCase() === 'y');
      });
    });
  };
}

main().catch(e => { console.error(e); process.exit(1); });
