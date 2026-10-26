'use strict';
// policy.test.js - regression tests for the approved security model:
// side effects always ask, reads follow scope grants, live hands revocation,
// credential origin binding, deny-by-default for unknown tools.
const {test}=require('node:test');
const assert=require('node:assert/strict');
const { Sentinel } = require('../sentinel');
const { isPrivateHost, buildTools } = require('../tools');
const { fetchModels, originOf } = require('../models');

function cfg(over={}) {
  return {
    sentinel: { mode:'ask', deny_rules:[], egress_allowlist:[] },
    agent: { always_ask_tools:['shell'], approval_timeout_s:1 },
    ...over,
  };
}

test('ask mode: side-effect tools always ask', () => {
  const s = new Sentinel(cfg());
  for (const tool of ['write_file','web_fetch','shell','hands']) {
    assert.equal(s.decide({tool,args:{}}).decision,'ask',tool);
  }
});

test('mode engine: invalid modes rejected, valid accepted, bad config falls back to ask', () => {
  const s = new Sentinel(cfg());
  assert.equal(s.mode,'ask');
  assert.equal(s.setMode('yolo'),false);
  assert.equal(s.setMode('plan'),true);
  assert.equal(s.mode,'plan');
  const bad = new Sentinel(cfg({sentinel:{mode:'not-a-mode',deny_rules:[],egress_allowlist:[]}}));
  assert.equal(bad.mode,'ask');
});

test('accept_edits: writes inside scope auto-approve, outside ask; shell still asks', () => {
  const s = new Sentinel(cfg({sentinel:{mode:'accept_edits',deny_rules:[],egress_allowlist:[]}}));
  const root = process.platform==='win32' ? 'C:\\proj' : '/proj';
  const inside = process.platform==='win32' ? 'C:\\proj\\a.js' : '/proj/a.js';
  const outside = process.platform==='win32' ? 'C:\\other\\a.js' : '/other/a.js';
  s.addGrant(root);
  assert.equal(s.decide({tool:'write_file',args:{},resolvedPath:inside}).decision,'allow');
  assert.equal(s.decide({tool:'write_file',args:{},resolvedPath:outside}).decision,'ask');
  assert.equal(s.decide({tool:'shell',args:{}}).decision,'ask');
  assert.equal(s.decide({tool:'web_fetch',args:{}}).decision,'ask');
  assert.equal(s.decide({tool:'hands',args:{}}).decision,'ask');
});

test('plan mode: every side effect denied outright; reads keep scope policy', () => {
  const s = new Sentinel(cfg({sentinel:{mode:'plan',deny_rules:[],egress_allowlist:[]}}));
  const root = process.platform==='win32' ? 'C:\\proj' : '/proj';
  const inside = process.platform==='win32' ? 'C:\\proj\\a.js' : '/proj/a.js';
  s.addGrant(root);
  for (const tool of ['write_file','web_fetch','shell','hands']) {
    const d = s.decide({tool,args:{}});
    assert.equal(d.decision,'deny',tool);
    assert.match(d.reason,/plan mode/i);
  }
  assert.equal(s.decide({tool:'read_file',args:{},resolvedPath:inside}).decision,'allow');
  assert.equal(s.decide({tool:'read_file',args:{},resolvedPath:'/etc/passwd'}).decision,'ask');
});

test('auto mode: side effects auto-approve but shell + hands keep asking', () => {
  const s = new Sentinel(cfg({sentinel:{mode:'auto',deny_rules:[],egress_allowlist:[]}}));
  for (const tool of ['write_file','web_fetch']) {
    assert.equal(s.decide({tool,args:{}}).decision,'allow',tool);
  }
  assert.equal(s.decide({tool:'shell',args:{}}).decision,'ask');   // always_ask_tools default
  assert.equal(s.decide({tool:'hands',args:{}}).decision,'ask');
});

test('auto mode honors custom always_ask_tools', () => {
  const s = new Sentinel(cfg({sentinel:{mode:'auto',deny_rules:[],egress_allowlist:[]},agent:{always_ask_tools:['web_fetch'],approval_timeout_s:1}}));
  assert.equal(s.decide({tool:'web_fetch',args:{}}).decision,'ask');
  assert.equal(s.decide({tool:'shell',args:{}}).decision,'allow');
});

test('mode invariants: deny rules + hands revocation + fail-closed hold in EVERY mode', () => {
  for (const mode of ['ask','accept_edits','plan','auto']) {
    const s = new Sentinel(cfg({sentinel:{mode,deny_rules:['*nuclear*'],egress_allowlist:[]}}));
    // deny rule beats even auto
    assert.equal(s.decide({tool:'shell',args:{command:'launch nuclear missiles'}}).decision,'deny',mode);
    // hands revocation denies in every mode
    s.revokeHands();
    assert.equal(s.decide({tool:'hands',args:{}}).decision,'deny',mode);
    // unknown tools fail closed in every mode
    assert.equal(s.decide({tool:'mystery',args:{}}).decision,'deny',mode);
    // reads outside scope still ask in every mode
    assert.equal(s.decide({tool:'read_file',args:{},resolvedPath:'/outside/x'}).decision,'ask',mode);
  }
});

test('read tools allowed only inside granted scope', () => {
  const s = new Sentinel(cfg());
  // grant must use the same platform shape as the resolved paths below
  const root = process.platform==='win32' ? 'C:\\home\\user\\project' : '/home/user/project';
  s.addGrant(root);
  const inside = process.platform==='win32' ? 'C:\\home\\user\\project\\a.txt' : '/home/user/project/a.txt';
  const outside = process.platform==='win32' ? 'C:\\windows\\system32\\x' : '/etc/passwd';
  // normalize like tools do (win grant lowercased containment)
  assert.equal(s.decide({tool:'read_file',args:{},resolvedPath:inside}).decision,'allow');
  assert.equal(s.decide({tool:'read_file',args:{},resolvedPath:outside}).decision,'ask');
  assert.equal(s.decide({tool:'list_dir',args:{},resolvedPath:outside}).decision,'ask');
  assert.equal(s.decide({tool:'list_dir',args:{},resolvedPath:inside}).decision,'allow');
});

test('no-project mode: reads ask, chat unaffected', () => {
  const s = new Sentinel(cfg());
  assert.equal(s.decide({tool:'read_file',args:{},resolvedPath:'/any/where'}).decision,'ask');
  s.setProjectScope && s.setProjectScope();
});

test('hands revocation denies immediately, even after approval would be granted', () => {
  const s = new Sentinel(cfg());
  assert.equal(s.decide({tool:'hands',args:{}}).decision,'ask');
  s.revokeHands();
  const d = s.decide({tool:'hands',args:{}});
  assert.equal(d.decision,'deny');
  assert.match(d.reason,/revoked/);
});

test('unknown tools fail closed', () => {
  const s = new Sentinel(cfg());
  assert.equal(s.decide({tool:'mystery_tool',args:{}}).decision,'deny');
});

test('deny rules win over grants', () => {
  const s = new Sentinel(cfg({sentinel:{mode:'ask',deny_rules:['*secret*'],egress_allowlist:[]}}));
  s.addGrant('/p');
  const p = process.platform==='win32' ? 'C:\\p\\secret.txt' : '/p/secret.txt';
  assert.equal(s.decide({tool:'read_file',args:{path:'secret.txt'},resolvedPath:p}).decision,'deny');
});

test('approval timeout fires expiry listeners', async () => {
  const s = new Sentinel(cfg());
  s.approver = () => new Promise(() => {});   // never resolves -> timeout path
  let fired=false;
  s.onExpiry(()=>{fired=true;});
  const res = await s.gate({tool:'shell',args:{}});
  assert.equal(res.decision,'deny');
  assert.equal(fired,true);
});

test('isPrivateHost blocks loopback/private/link-local', () => {
  for (const h of ['localhost','127.0.0.1','10.0.0.5','192.168.1.1','172.16.0.1','169.254.1.1','::1','fe80::1','fc00::1','100.64.0.1','0.0.0.0']) {
    assert.equal(isPrivateHost(h),true,h);
  }
  for (const h of ['example.com','8.8.8.8','1.1.1.1']) {
    assert.equal(isPrivateHost(h),false,h);
  }
});

test('origin binding: saved key refused for different origin', async () => {
  assert.equal(originOf('https://api.example.com/v1'),'https://api.example.com');
  await assert.rejects(
    () => fetchModels('https://evil.example.com/v1','sk-saved',{expectedOrigin:'https://api.provider.com',keyIsExplicit:false}),
    /refusing to reuse/
  );
});

test('plain http non-loopback refused', async () => {
  await assert.rejects(() => fetchModels('http://evil.example.com/v1','k',{keyIsExplicit:true}), /plain HTTP/);
});

test('write_file requires approval (gate integration)', async () => {
  const s = new Sentinel(cfg());   // no approver connected
  const res = await s.gate({tool:'write_file',args:{path:'x'}});
  assert.equal(res.decision,'deny');
  assert.match(res.reason,/no approver/);
});

test('tool registry keeps central policy (no alwaysAsk drift)', () => {
  const { tools } = buildTools(cfg());
  const names = tools.map(t=>t.name);
  assert.deepEqual(names.sort(),['hands','list_dir','read_file','shell','spawn_agent','web_fetch','write_file'].sort());
});
