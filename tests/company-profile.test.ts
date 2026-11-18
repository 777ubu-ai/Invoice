import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadCompanyProfile, companySummary } from '../src/company-profile.js';

test('profile preserves full supplied fields and fails closed for malformed data', async () => {
  const dir = await mkdtemp(join(tmpdir(),'buyer-profile-'));
  try {
    const file = join(dir,'buyer.json');
    await writeFile(file,JSON.stringify({name:'Тестовая компания',fields:[{label:'ИНН',value:'1234567890'},{label:'Адрес',value:'Тестовый адрес'}]}));
    const profile = await loadCompanyProfile(file);
    assert.equal(profile.name,'Тестовая компания');
    assert.equal(profile.fields[0]!.value,'1234567890');
    assert.match(companySummary(profile),/Покупатель \/ получатель/);
    await writeFile(file,JSON.stringify({name:'',fields:[]}));
    await assert.rejects(loadCompanyProfile(file));
    await assert.rejects(loadCompanyProfile(''));
  } finally { await rm(dir,{recursive:true,force:true}); }
});
