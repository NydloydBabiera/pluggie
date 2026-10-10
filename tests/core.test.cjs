const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseUrl, parseTelemetry, request, selectReadings, toCsv, defaults } = require('../src/core.ts');
const values = { voltage:230,current:1.5,power:330,energy:0.1,relay:true };
test('rejects corrupt telemetry instead of recording false measurements',()=>{
  assert.deepEqual(parseTelemetry(values),values);
  for(const v of [null,{}, {...values,power:NaN},{...values,current:-1},{...values,relay:'on'},{...values,energy:'0.1'}]) assert.throws(()=>parseTelemetry(v));
});
test('validates and normalizes device addresses',()=>{
  assert.equal(baseUrl(' http://192.168.4.1/ '),'http://192.168.4.1');
  for(const u of ['ftp://device','invalid','http://user:pass@device','http://device?token=abc']) assert.throws(()=>baseUrl(u));
});
test('date selection isolates device, includes end of day, rejects impossible dates',()=>{
  const row={...values,id:'1',source:'Demo',timestamp:new Date(`${'2026-10-07'}T23:59:59`).toISOString()};
  assert.equal(selectReadings([row,{...row,source:'Other'}],'Demo','2026-10-07','2026-10-07').length,1);
  assert.equal(selectReadings([row],'Demo','2026-10-08','2026-10-08').length,0);
  for(const [a,b] of [['2026-02-30','2026-03-01'],['2026-10-08','2026-10-07'],['x','x']]) assert.throws(()=>selectReadings([],'Demo',a,b));
});
test('CSV includes all fields and safely escapes quotes',()=>{
  const csv=toCsv([{...values,id:'1',source:'a"b',timestamp:'2026-10-07T00:00:00Z'}]);
  assert.match(csv,/timestamp_utc,device,voltage_V,current_A,power_W,energy_kWh,relay/);
  assert.match(csv,/"a""b"/); assert.match(csv,/"ON"/);
});
test('HTTP commands send boolean state and token; errors and malformed responses fail',async()=>{
  const original=global.fetch; let call;
  try {
    global.fetch=async(url,options)=>{ call={url,options}; return {ok:true,json:async()=>values}; };
    assert.deepEqual(await request({...defaults,token:'secret'},false),values);
    assert.equal(call.url,'http://192.168.4.1/api/relay'); assert.equal(call.options.method,'POST');
    assert.equal(call.options.body,'{"on":false}'); assert.equal(call.options.headers.Authorization,'Bearer secret');
    await request(defaults); assert.equal(call.options.method,'GET'); assert.equal(call.options.body,undefined);
    global.fetch=async()=>({ok:false,status:401}); await assert.rejects(request(defaults),/401/);
    global.fetch=async()=>({ok:true,json:async()=>({})}); await assert.rejects(request(defaults),/relay/);
  } finally { global.fetch=original; }
});
