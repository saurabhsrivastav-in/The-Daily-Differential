// Offline self-check for the bookmark system. Run from the repo root:  node scripts/test_bookmarks.mjs
const mem = new Map();
globalThis.window = { localStorage: { getItem:k=>mem.get(k)??null, setItem:(k,v)=>mem.set(k,String(v)), removeItem:k=>mem.delete(k) }, addEventListener(){} };
const { BookmarkStore } = await import('../docs/assets/bookmarks.js');
const assert = (c,m)=>{ if(!c){ console.error('FAIL',m); process.exit(1);} else console.log('ok  ',m); };

const s = new BookmarkStore();
assert(s.active===null && s.count()===0, 'starts with no profile');
assert(s.add({id:'x',title:'T',url:'https://a.b'})===false, 'cannot save without a profile');
assert(s.createProfile('  Asha  ').ok && s.active==='Asha', 'create profile (trimmed)');
assert(!s.createProfile('').ok, 'empty name rejected');
assert(s.createProfile('asha').switched===true && s.profileNames().length===1, 'same name (case-insensitive) switches, no duplicate');
assert(s.add({id:'a1',title:'Tax [update]',url:'https://x.org/1',source:'S',summary:'sum',published:'2026-11-14T01:00:00+00:00'},'Tax News'), 'add article');
assert(s.add({id:'bad',title:'Evil',url:'javascript:alert(1)'})===false, 'javascript: URL rejected');
assert(s.has('a1') && s.count()===1, 'has/count');
assert(s.list('tax').length===1 && s.list('zzz').length===0, 'search works');
const md = s.exportMarkdown(); assert(md.includes('## Tax News') && md.includes('[Tax \\[update\\]](https://x.org/1)'), 'markdown export escapes brackets');
const json = s.exportJSON();
s.createProfile('Ravi'); assert(s.count()===0, 'profiles are separate');
const r = s.importJSON(json); assert(r.ok && r.added===1 && s.active==='Asha', 'import merges back into the named profile');
assert(!s.importJSON('not json').ok && !s.importJSON('{"app":"other","bookmarks":[]}').ok, 'bad imports rejected');
const evil = JSON.stringify({app:'daily-differential',profile:'__proto__',bookmarks:[]}); assert(!s.importJSON(evil).ok, '__proto__ profile name rejected');
s.remove('a1'); assert(s.count()===0, 'remove');
const s2 = new BookmarkStore(); assert(s2.active==='Asha', 'persists across reloads');
s2.deleteProfile('Asha'); assert(!s2.profileNames().includes('Asha'), 'delete profile');
console.log('ALL BOOKMARK TESTS PASSED');
