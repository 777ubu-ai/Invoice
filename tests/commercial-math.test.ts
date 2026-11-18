import test from 'node:test';import assert from 'node:assert/strict';
import {allocate,amountByWeight,lineAmount,priceForAmount} from '../src/commercial-math.js';

test('allocation conserves every cent, has stable ties and rejects missing weights',()=>{
 assert.deepEqual(allocate('25000.00',['1','1','1']),['8333.34','8333.33','8333.33']);
 assert.deepEqual(allocate('0.05',['1','2','3']),['0.01','0.02','0.02']);
 assert.throws(()=>allocate('12',['0','0']),/нужны/);assert.throws(()=>allocate('12.001',['1']),/знаков/);
});
test('line totals, target-derived prices and per-kilogram totals use exact decimals',()=>{
 assert.equal(lineAmount('327','9.3958'),'3072.43');assert.equal(priceForAmount('3','1.00'),'0.333');
 assert.equal(amountByWeight('2',['10000','2500']),'25000.00');assert.throws(()=>priceForAmount('100000000000','100.01'),/Невозможно/);
});
