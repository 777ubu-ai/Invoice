import test from 'node:test';
import assert from 'node:assert/strict';
import ExcelJS from 'exceljs';
import { parsePackingXlsx } from '../src/packing-xlsx.js';
import { analyseRows, validateSuggestions } from '../src/packing-ai.js';
import { standardPacking } from '../src/packing-standard.js';
import { specificationWorkbook } from '../src/specification.js';
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
  work.contract='TEST 1';work.invoiceNumber='INV-1';work.invoiceDate='2026-11-18';work.seller='Продавец, адрес';work.terms='Условия';work.currency='USD';
  editItem(work,1,'qty','3');work.items[0]!.net='1';work.items[0]!.gross='2';work.items[0]!.packages='1';work.items[0]!.maker='тест';work.items[0]!.origin='тест';work.items[0]!.packaging='тест';assert.deepEqual(issues(work),[]);
  const review=new ExcelJS.Workbook();await review.xlsx.load(await reviewWorkbook(work) as never);assert.equal(review.getWorksheet('Прочие строки')!.rowCount,3);
  const result=new ExcelJS.Workbook();await result.xlsx.load(await invoiceWorkbook(work) as never);assert.equal(result.getWorksheet('Specification')!.getRow(15).getCell(13).value,3.33);
});


test('standard 15-line packing preserves amounts and renders the agreed specification',async()=>{
 const b=new ExcelJS.Workbook(),s=b.addWorksheet('Packing');
 s.addRow([]);s.addRow(['№','Description','Weight netto (kg)','Gross weight (kg)','Quantity','PRICE PER 100','','Amount, USD','Package']);s.addRow(['','','','','','USD','pcs, set']);
 for(let i=1;i<=15;i++)s.addRow([i,`Товар ${i}`,10.125,11.250,100,250,'pcs',250,i]);
 s.addRow(['TOTAL','','','','','','',3750]);
 const rows=await parsePackingXlsx(Buffer.from(await b.xlsx.writeBuffer()));
 const work=standardPacking(42,'packing.xlsx',{name:'Тест',fields:[{label:'ИНН',value:'123'}]},rows)!;
 assert.equal(work.items.length,15);assert.equal(work.items[0]!.unitPrice,'2.5000');assert.equal(work.items[0]!.priceMismatch,false);assert.equal(work.items[0]!.packages,'1');
 const result=new ExcelJS.Workbook();await result.xlsx.load(await specificationWorkbook(work) as never);
 const spec=result.getWorksheet('Specification')!;assert.equal(spec.getCell('B15').value,'Товар 1');assert.equal(spec.getCell('B29').value,'Товар 15');assert.equal(spec.getCell('M15').value,2.5);assert.equal(spec.getCell('O30').result,3750);assert.equal(spec.getCell('L30').result,151.875);assert.match(String(spec.getCell('B2').value),/ДЛЯ ПРОВЕРКИ/);
 assert.ok(result.getWorksheet('Прочие строки'));assert.ok(result.getWorksheet('Участники'));
});
