import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parsePackingXlsx } from '../src/packing-xlsx.js';
import { analyseRows, validateSuggestions } from '../src/packing-ai.js';
import { createInvoiceWork, issues, editItem, invoiceWorkbook, reviewWorkbook } from '../src/packing-invoice.js';

test('packing rows survive review and invoice uses only supplied or explicitly edited numbers',async()=>{
  const b=new ExcelJS.Workbook(),s=b.addWorksheet('Packing');
  s.addRow(['Description','Qty','Unit','Amount']);s.addRow(['Кабель','3','pcs','9.99']);s.addRow(['Total','','','9.99']);
  const rows=await parsePackingXlsx(Buffer.from(await b.xlsx.writeBuffer()));
  assert.equal(rows.length,3);
  const raw=rows.map((r,i)=>({sourceId:r.id,kind:i===1?'item':'other',nameColumn:i===1?0:null,quantityColumn:i===1?1:null,unitColumn:i===1?2:null,netColumn:null,grossColumn:null,amountColumn:i===1?3:null,nameRu:i===1?'Кабель':'',suggestedCode:i===1?'1234567890':'',reason:i===1?'':'заголовок или итог'}));
  assert.throws(()=>validateSuggestions({rows:raw.slice(1)},rows),/пропустил/);
  const suggestions=await analyseRows(rows,async()=>validateSuggestions({rows:raw},rows));
  const work=createInvoiceWork(42,'packing.xlsx',{name:'Тест',fields:[]},rows,suggestions);
  assert.equal(work.items[0]!.amount,'9.99');assert.equal(work.items[0]!.net,'');assert.equal(work.omitted.length,2);
  assert.ok(issues(work).length>0);await assert.rejects(invoiceWorkbook(work));
  work.invoiceNumber='INV-1';work.invoiceDate='2026-11-18';work.seller='Продавец, адрес';work.terms='Условия';work.currency='USD';
  editItem(work,1,'qty','3');assert.deepEqual(issues(work),[]);
  const review=new ExcelJS.Workbook();await review.xlsx.load(await reviewWorkbook(work) as never);assert.equal(review.getWorksheet('Прочие строки')!.rowCount,3);
  const result=new ExcelJS.Workbook();await result.xlsx.load(await invoiceWorkbook(work) as never);assert.equal(result.getWorksheet('INVOICE')!.getRow(9).getCell(9).value,'3.33');
});
