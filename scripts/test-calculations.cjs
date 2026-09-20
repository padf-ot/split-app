/* eslint-disable @typescript-eslint/no-require-imports */
const fs = require('node:fs');
const vm = require('node:vm');
const ts = require('typescript');
const assert = require('node:assert/strict');
const source = fs.readFileSync('app/split-app.tsx', 'utf8');
const context = vm.createContext({});
const logic = source.slice(source.indexOf('const currencies'), source.indexOf('export default function'));
vm.runInContext(ts.transpile(logic, { target: ts.ScriptTarget.ES2022 }) + ';this.api={calculateSplits,getBalances,getConvertedBalances,settle,draftFromExpense,money,parseAmount,allocate,convertedAmount,expenseIssue,validRate};', context);
const a = context.api;
const friends = ['A','B','C','D'].map(id => ({id,name:id}));
const plain = x => JSON.parse(JSON.stringify(x));
const makeDraft = (method,price,values=[],n=4,currency='SGD') => ({name:'Test',description:'',date:'2026-09-20',payerId:'A',currency,otherCurrency:'',method,price,selected:friends.slice(0,n).map(f=>f.id),values:Object.fromEntries(friends.slice(0,n).map((f,i)=>[f.id,String(values[i]??0)]))});
const split = (...args) => a.calculateSplits(makeDraft(...args), friends);
const amounts = r => plain(r.lines.map(l=>l.amount));
const expense = (draft, result) => ({id:'e',name:'Test',description:'',date:'2026-09-20',price:a.parseAmount(draft.price,draft.currency),currency:draft.currency,payerId:'A',payerName:'A',method:draft.method,splits:result.lines,splitInputs:draft.method==='equal'?undefined:draft.values});
function clears(balances) {
  assert.equal(balances.reduce((s,b)=>s+b.amount,0),0);
  const remaining = new Map(balances.map(b=>[b.name,b.amount]));
  for(const p of a.settle(balances)) {
    assert(Number.isSafeInteger(p.amount) && p.amount>0);
    remaining.set(p.from,remaining.get(p.from)+p.amount);
    remaining.set(p.to,remaining.get(p.to)-p.amount);
  }
  assert([...remaining.values()].every(x=>x===0));
}
assert.deepEqual(amounts(split('equal','10',[],3)),[334,333,333]);
assert.deepEqual(amounts(split('shares','12',[1,2,3],3)),[200,400,600]);
assert.deepEqual(amounts(split('percentage','10',[25,75],2)),[250,750]);
assert.deepEqual(amounts(split('exact','10',[3,7],2)),[300,700]);
assert.deepEqual(amounts(split('shares','.02',[1,1,1,0])),[1,1,0,0]);
assert.deepEqual(amounts(split('percentage','.02',[25,25,25,25])),[1,1,0,0]);
assert.equal(split('exact','.03',[.01,.01],2).valid,false);
for(const method of ['shares','percentage','exact']) assert.equal(split(method,'10',[-1,11],2).valid,false);
for(const bad of ['NaN','Infinity','-1','1e3','1.005','999999999999999999999']) assert.equal(split('equal',bad,[],2).valid,false);
assert.equal(split('percentage','100',[50,49.999],2).valid,false);
assert.equal(split('shares','100',[0,0],2).valid,false);
assert.equal(split('equal','1',[],3,'JPY').valid,true);
assert.deepEqual(amounts(split('equal','1',[],3,'JPY')),[100,0,0]);
assert.equal(split('equal','1.01',[],3,'JPY').valid,false);
assert.equal(split('equal','1',[],3,'KWD').valid,false);
assert.equal(a.money(33,'JPY'),'¥0.33'); // do not hide legacy fractional yen
assert.equal(a.money(100,'JPY'),'¥1');
assert.equal(a.convertedAmount(100,'1.005','SGD'),101);
assert.equal(a.convertedAmount(100,'0.5','JPY'),100);
assert.equal(a.validRate('0'),false);
assert.equal(a.validRate('Infinity'),false);
assert.equal(a.validRate('0.000000000001'),true);
const d=makeDraft('exact','.03',[.01,.01,.01,0],4,'MYR');
const e=expense(d,a.calculateSplits(d,friends));
const converted=a.getConvertedBalances({friends,expenses:[e]},'SGD',{MYR:'.5'});
assert.equal(converted.find(b=>b.id==='D').amount,0);
assert(converted.filter(b=>b.id!=='A').every(b=>b.amount<=0));
clears(converted);
assert.throws(()=>a.getConvertedBalances({friends,expenses:[e]},'SGD',{}));
assert.throws(()=>a.convertedAmount(1e12,'1000000000','SGD'));
assert(a.expenseIssue({...e,currency:'JPY'}));
clears([{id:'A',name:'A',amount:-1},{id:'B',name:'B',amount:1}]);
let seed=123456;
const rand=n=>{seed=(Math.imul(seed,1664525)+1013904223)>>>0;return seed%n;};
let trials=0;
for(let k=0;k<10000;k++) {
  const n=2+rand(3),currency=k%5===0?'JPY':'SGD',unit=currency==='JPY'?100:1,total=(1+rand(10000))*unit;
  const method=['equal','shares','percentage','exact'][k%4];
  let values=Array.from({length:n},()=>rand(10)); if(values.every(x=>x===0))values[0]=1;
  if(method==='percentage'||method==='exact') {
    values=Array(n).fill(0);let left=method==='percentage'?100:total/unit;
    for(let i=0;i<n-1;i++){values[i]=rand(left+1);left-=values[i];}values[n-1]=left;
    if(method==='exact')values=values.map(x=>x*unit/100);
  }
  const draft=makeDraft(method,String(total/100),values,n,currency), result=a.calculateSplits(draft,friends);
  assert(result.valid,JSON.stringify(draft));
  assert.equal(result.lines.reduce((s,l)=>s+l.amount,0),total);
  assert(result.lines.every(l=>l.amount>=0&&Number.isSafeInteger(l.amount)&&l.amount%unit===0));
  if(method!=='equal') result.lines.forEach((l,i)=>{if(values[i]===0)assert.equal(l.amount,0);});
  const e=expense(draft,result),g={friends:friends.slice(0,n),expenses:[e]};
  assert.equal(a.expenseIssue(e),null);
  clears(a.getBalances(g,currency));
  assert.deepEqual(amounts(a.calculateSplits(a.draftFromExpense(e),friends)),amounts(result));
  const snapshot=JSON.stringify(g),target=k%3===0?'JPY':'USD',rate=((1+rand(2000))/1000).toFixed(3);
  const bal=a.getConvertedBalances(g,target,{[currency]:rate});clears(bal);
  assert(bal.filter(b=>b.id!=='A').every(b=>b.amount<=0));
  result.lines.forEach(l=>{if(l.amount===0&&l.friendId!=='A')assert.equal(bal.find(b=>b.id===l.friendId).amount,0);});
  assert.equal(JSON.stringify(g),snapshot);
  trials++;
}
for(let k=0;k<1000;k++) {
 const expenses=Array.from({length:20},(_,i)=>{const draft=makeDraft('equal',String((1+rand(10000))/100),[],4,i%2?'SGD':'MYR'),result=a.calculateSplits(draft,friends),payer=friends[rand(4)];return {...expense(draft,result),id:String(i),payerId:payer.id,payerName:payer.name};});
 const g={friends:friends.slice(0,3),expenses};
 for(const currency of ['SGD','MYR'])clears(a.getBalances(g,currency));
 clears(a.getConvertedBalances(g,'SGD',{MYR:'0.315457413249'}));
}
assert(!source.includes('Minimum payments'));
assert(source.includes('Split with:') && source.includes('<th>Split with</th>'));
assert(source.includes('escapeHtml(line.friendName)'));
let report='';
const reportWindow={
 document:{write:html=>{report=html;},close:()=>{}},
 focus:()=>{},
 print:()=>{}
};
const reportContext=vm.createContext({
 ...a,
 group:{
  name:'Trip',
  friends,
  expenses:[{...e,name:'Dinner',splits:[
   {friendId:'A',friendName:'亦宣 <script>',amount:3},
   {friendId:'B',friendName:'Belle & Co',amount:0}
  ]}]
 },
 currenciesInUse:['MYR'],
 primaryCurrency:'SGD',
 exchangeRates:{MYR:'0.3'},
 conversionCurrencies:['MYR'],
 conversionReady:true,
 dataIssue:null,
 setExporting:()=>{},
 setTimeout:fn=>fn(),
 window:{open:()=>reportWindow}
});
vm.runInContext(ts.transpile(source.slice(source.indexOf('function escapeHtml')), {target:ts.ScriptTarget.ES2022}),reportContext);
const exportCode=source.slice(source.indexOf('  function exportPdf()'),source.indexOf('  const canSave'));
vm.runInContext(ts.transpile(exportCode,{target:ts.ScriptTarget.ES2022})+';exportPdf();',reportContext);
assert(report.includes('Split with'));
assert(report.includes('亦宣 &lt;script&gt;'));
assert(report.includes('Belle &amp; Co'));
assert(report.includes('RM0.03'));
reportContext.group.settleInPrimary=true;
vm.runInContext('exportPdf();',reportContext);
assert(report.includes('Settle up · SGD'));
assert(report.includes('1 MYR = 0.3 SGD'));
assert(report.includes('RM0.03')); // original split amounts remain labelled MYR
console.log(`PASS: regression cases; ${trials} randomized splits, conversions and edit round trips; 1,000 multi-expense groups, removed friends and mixed currencies; report participant escaping.`);
