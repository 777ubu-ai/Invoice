import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {historicalExample,matchesReference} from '../src/historical-example.js';
import type {InvoiceWork} from '../src/packing-invoice.js';
const item={sourceId:'s0r1',sheet:'p',sourceRow:1,original:'товар',name:'товар',code:'',quantity:'2',unit:'pcs',net:'1.20',gross:'2',amount:'10',packages:'1',unitPrice:'5'};
const reference={items:[{name:'товар',quantity:'2.0',unit:'pcs',net:'1.2',gross:'2',amount:'10',packages:'1',unitPrice:'5.00',code:'1234567890'}]};
const make=():InvoiceWork=>({id:'x',owner:42,filename:'test.xlsx',buyer:{name:'test',fields:[]},items:[{...item}],omitted:[],invoiceNumber:'',invoiceDate:'',seller:'',terms:'',currency:'USD'});
test('historical report requires an exact matching packing and fails closed after any material edit',async()=>{
 const d=await mkdtemp(join(tmpdir(),'invoice-history-'));try{
  await writeFile(join(d,'example15.json'),JSON.stringify(reference));await writeFile(join(d,'invoice15-calc.b64'),Buffer.from('PKreport').toString('base64'));
  const w=make();assert.equal(matchesReference(w,reference),true);assert.equal((await historicalExample(w,d))?.toString(),'PKreport');
  w.items[0]!.code='1111111111';assert.equal(await historicalExample(w,d),null);w.items[0]!.code='';w.items[0]!.quantity='3';assert.equal(await historicalExample(w,d),null);
  w.items[0]!.quantity='2';w.items[0]!.maker='other';assert.equal(await historicalExample(w,d),null);w.items[0]!.maker='';w.currency='RUB';assert.equal(await historicalExample(w,d),null);
 }finally{await rm(d,{recursive:true,force:true});}
});
