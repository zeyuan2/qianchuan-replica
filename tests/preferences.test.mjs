import test from 'node:test';
import assert from 'node:assert/strict';
import {migrateMetricKeys,migratePreferences} from '../dist/preferences.mjs';

test('legacy UI-only metric keys migrate by exact label without losing saved templates',()=>{
 const old={metrics:[{key:'ui-only:cost',label:'成本'},{key:'roi',label:'ROI'}]};
 const live={metrics:[{key:'real_cost',label:'成本'},{key:'roi',label:'ROI'}],frozen:['roi'],minMetricCount:1,maxMetricCount:3};
 assert.deepEqual(migrateMetricKeys(['ui-only:cost','roi'],old,live),['roi','real_cost']);
 const values=new Map([['top:v2',JSON.stringify(['ui-only:cost','roi'])],['top:v2:templates',JSON.stringify([{name:'原模板',keys:['ui-only:cost','roi']}])]]);
 const storage={getItem:k=>values.get(k)||null,setItem:(k,v)=>values.set(k,v)};
 migratePreferences(storage,'top:v3',old,live);
 assert.deepEqual(JSON.parse(values.get('top:v3')),['roi','real_cost']);
 assert.equal(JSON.parse(values.get('top:v3:templates'))[0].name,'原模板');
 assert.ok(values.has('top:v2'));
 values.set('top:v3',JSON.stringify(['roi']));migratePreferences(storage,'top:v3',old,live);
 assert.deepEqual(JSON.parse(values.get('top:v3')),['roi']);
});
