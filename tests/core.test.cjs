const { test } = require('node:test');
const assert = require('node:assert/strict');
const { baseUrl, parseTelemetry, request, selectReadings, toCsv, defaults } = require('../src/core.ts');
const values = { voltage:230,current:1.5,power:330,energy:0.1,relay:true };
test('rejects corrupt telemetry instead of recording false measurements',()=>{
  assert.deepEqual(parseTelemetry(values),values);
  for(const v of [null,{}, {...values,power:NaN},{...values,current:-1},{...values,relay:'invalid'},{...values,energy:'0.1'}]) assert.throws(()=>parseTelemetry(v));
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
test('HTTP reads use local endpoints and errors and malformed responses fail',async()=>{
  const original=global.fetch; let call;
  try {
    global.fetch=async(url,options)=>{ call={url,options}; return {ok:true,json:async()=>url.endsWith('/relay')?{ok:true,state:'on'}:values}; };
    assert.deepEqual(await request({...defaults,token:'secret'},false),values);
    assert.equal(call.url,'http://192.168.4.1/status'); assert.equal(call.options.method,'GET');
    assert.equal(call.options.body,undefined); assert.equal(call.options.headers.Authorization,'Bearer secret');
    await request(defaults); assert.equal(call.options.method,'GET'); assert.equal(call.options.body,undefined);
    global.fetch=async()=>({ok:false,status:401}); await assert.rejects(request(defaults),/401/);
    global.fetch=async()=>({ok:true,json:async()=>({})}); await assert.rejects(request(defaults),/relay/);
  } finally { global.fetch=original; }
});

const { readingSource, validateSettings } = require('../src/core.ts');
test('online requests use API paths and credentials, offline commands stay local',async()=>{
  const original=global.fetch; const calls=[];
  try {
    global.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/relay')?{ok:true,state:'on'}:values};};
    const s={...defaults,demo:false,mode:'online',apiUrl:'https://api.example.test',apiToken:'cloud',token:'board',readingsPath:'/devices/1/readings',relayPath:'/devices/1/relay'};
    await request(s); await request(s,false); await request({...s,mode:'offline'},true);
    assert.equal(calls.length,4);
    assert.equal(calls[0].url,'https://api.example.test/devices/1/relay');
    assert.equal(calls[0].options.headers.Authorization,'Bearer cloud');
    assert.equal(calls[0].options.body,'{"state":"off"}');
    assert.equal(calls[1].url,'http://192.168.4.1/relay');
    assert.equal(calls[1].options.body,'{"state":"on"}');
    assert.equal(calls[1].options.headers.Authorization,'Bearer board');
    assert.notEqual(readingSource(s),readingSource({...s,mode:'offline'}));
  } finally {global.fetch=original;}
});
test('settings migrate defaults and reject missing API and unsafe endpoint paths',()=>{
  assert.equal(validateSettings({...defaults}).mode,'offline');
  assert.throws(()=>validateSettings({...defaults,demo:false,mode:'online',apiUrl:''}),/API address/);
  for(const readingsPath of ['https://other.test','//other.test','/readings?token=x'])
    assert.throws(()=>validateSettings({...defaults,readingsPath}),/Endpoint/);
});

test('Pluggie nested telemetry maps relay and preserves frequency and power factor',()=>{
  const readings={voltage:220.9,current:0,power:0,energy:0.001,frequency:60.1,powerFactor:0};
  assert.deepEqual(parseTelemetry({relayState:'off',readings}),{...readings,relay:false});
  assert.equal(parseTelemetry({relayState:'on',readings}).relay,true);
  assert.throws(()=>parseTelemetry({relayState:'unknown',readings}),/relay/);
  assert.throws(()=>parseTelemetry({relayState:'off',readings:{...readings,powerFactor:2}}),/powerFactor/);
});
test('relay acknowledgement is followed by latest readings and local status supplies relay state',async()=>{
  const original=global.fetch; const calls=[];
  try {
    global.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>url.endsWith('/status')?{ok:true,state:'off'}:url.endsWith('/relay')?{ok:true,state:'off'}:{voltage:220.9,current:0,power:0,energy:0.001}};};
    const result=await request(defaults,false);
    assert.equal(result.relay,false);
    assert.deepEqual(calls.map(c=>new URL(c.url).pathname),['/relay','/readings','/status']);
    assert.equal(calls[0].options.body,'{"state":"off"}');
    global.fetch=async(url)=>({ok:true,json:async()=>url.endsWith('/api/relay')?{ok:true,state:'off'}:{relayState:'off',readings:values}});
    assert.equal((await request({...defaults,mode:'online'},false)).relay,false);
  } finally {global.fetch=original;}
});


const { parseRelayResponse }=require('../src/core.ts');
test('relay response validates success and maps on/off without requiring sensor values',()=>{
  assert.equal(parseRelayResponse({ok:true,state:'off'}),false);
  assert.equal(parseRelayResponse({ok:true,state:'on'}),true);
  for(const payload of [null,{}, {ok:false,state:'off'},{ok:true,state:'invalid'},{ok:true,state:false}]) assert.throws(()=>parseRelayResponse(payload));
});
test('online commands return relay state without requesting readings',async()=>{
  const original=global.fetch;
  try {
    global.fetch=async(url)=>({ok:true,json:async()=>url.endsWith('/relay')?{ok:true,state:'off'}:{readings:{voltage:220,current:0,power:0,energy:0.001}}});
    assert.equal((await request({...defaults,mode:'online'},false)).relay,false);
    global.fetch=async()=>({ok:true,json:async()=>({ok:false,state:'off'})});
    await assert.rejects(request({...defaults,mode:'online'},false),/not successful/);
  } finally {global.fetch=original;}
});

test('online reads never fetch; online relay commands only POST once',async()=>{
  const original=global.fetch; const calls=[];
  try {
    global.fetch=async(url,options)=>{calls.push({url,options});return {ok:true,json:async()=>({ok:true,state:'off'})};};
    const settings={...defaults,mode:'online'};
    assert.equal(await request(settings),undefined);
    assert.equal(calls.length,0);
    assert.deepEqual(await request(settings,false),{relay:false});
    assert.equal(calls.length,1);
    assert.equal(calls[0].options.method,'POST');
    assert.equal(calls[0].url,defaults.apiUrl+'/api/relay');
  } finally {global.fetch=original;}
});

test('missing metrics render as unavailable instead of throwing or displaying zero',()=>{
  const {formatReading}=require('../src/core.ts');
  for(const value of [undefined,null,NaN,Infinity,'220']) assert.equal(formatReading(value,1),String.fromCharCode(8212));
  assert.equal(formatReading(0,1),'0.0');
  assert.equal(formatReading(220.91,1),'220.9');
});
test('saved history excludes incomplete relay-only rows and preserves valid measurements',()=>{
  const {restoreReadings}=require('../src/core.ts');
  const metadata={id:'saved',source:'Demo',timestamp:'2026-10-21T00:00:00Z'};
  const valid={...metadata,...values};
  assert.deepEqual(restoreReadings([valid,{...metadata,relay:false},null,{...valid,power:null}]),[valid]);
});

test('live API readings and relay events are independent',()=>{
  const {parseSocketReading,parseSocketRelay,restoreReadings}=require('../src/core.ts');
  const payload={voltage:209.7,current:0,power:0,energy:0.001,frequency:60,powerFactor:0};
  assert.equal(parseSocketReading(payload).voltage,209.7);
  assert.equal(parseSocketReading(payload).relay,undefined);
  assert.equal(parseSocketReading(payload,parseSocketRelay({state:'off'})).relay,false);
  assert.equal(parseSocketReading(payload,parseSocketRelay({state:'on'})).relay,true);
  assert.throws(()=>parseSocketReading({...payload,power:undefined}),/power/);
  assert.throws(()=>parseSocketRelay({state:'invalid'}),/relay/);
  const saved={...parseSocketReading(payload),id:'1',source:'Online',timestamp:'2026-10-21T00:00:00Z'};
  assert.deepEqual(restoreReadings([saved]),[saved]);
});
