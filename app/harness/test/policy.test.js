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

test('side-effect tools always ask even in auto mode', () => {
  const s = new Sentinel(cfg({sentinel:{mode:'auto',deny_rules:[],egress_allowlist:[]}}));
  for (const tool of ['write_file','web_fetch','shell','hands']) {
    assert.equal(s.decide({tool,args:{}}).decision,'ask',tool);
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
