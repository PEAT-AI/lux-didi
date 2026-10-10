import {referenceSource} from './fixture.mjs';
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFileSync, existsSync} from 'node:fs';
import {createRequire} from 'node:module';
import vm from 'node:vm';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const fixture = JSON.parse(readFileSync(new URL('./fixtures/orb-reference.json', import.meta.url)));
const commonNoise = (x,y) => Math.sin(x * 1.7 + y * 0.3) * Math.cos(y * 0.9) * 0.5;
function compile(source, filename, local = {}, globals = {}) {
  const js = ts.transpileModule(source, {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText;
  const module = {exports:{}};
  vm.runInNewContext(js, {module,exports:module.exports,require:name=>local[name] ?? require(name), Math, Sentry:{addBreadcrumb(){}}, performance, ...globals}, {filename});
  return module.exports;
}
const classic = compile(readFileSync(new URL('../src/orb-classic.ts', import.meta.url),'utf8'), 'orb-classic.ts');
const frameModule = existsSync(new URL('../src/orb-frame.ts', import.meta.url))
  ? compile(readFileSync(new URL('../src/orb-frame.ts', import.meta.url),'utf8'), 'orb-frame.ts', {'./orb-classic':classic}) : undefined;
// This shell only supplies the Angular/service boundaries. Methods below are
// verbatim original source, not formulas or pixels produced by the port.
const reference = compile(referenceSource(fixture), 'pinned-vicuna-classic.ts').Reference;
function recordingContext() {
  const calls=[], gradients=new Map(); let nextGradient=0;
  const operand=value=>{
    if(typeof value==='number')assert(Number.isFinite(value),'nonfinite canvas operand');
    return gradients.has(value)?{gradient:gradients.get(value)}:value;
  };
  const ctx=new Proxy({}, {set(target,key,value){calls.push(['set',key,operand(value)]);target[key]=value;return true;},
    get(target,key){if(key in target)return target[key];return (...args)=>{
      const operands=args.map(operand);
      if(String(key).startsWith('create')){
        const id=nextGradient++, gradient={addColorStop:(...stops)=>calls.push(['addColorStop',id,...stops.map(operand)])};
        gradients.set(gradient,id);calls.push([key,...operands,{gradient:id}]);return gradient;
      }
      calls.push([key,...operands]);
    };}});
  return {ctx,calls,reset(){calls.length=0;gradients.clear();nextGradient=0;}};
}
const silence={level:0,low:0,mid:0,high:0,flux:0};
const voice={level:.6,low:.7,mid:.4,high:.2,flux:.9};
const states=['IDLE','DISCONNECTED','LISTENING','SPEAKING','PROCESSING','CONNECTING','CONNECTED','RECONNECTING','ERROR','INTERRUPTED'];
const plain = value => JSON.parse(JSON.stringify(value));

test('complete classic paint order: the old three-layer extract omits eight reachable calls',()=>{
  const expected=fixture.paintOrder;
  assert.equal(expected.length,11);
  const renderer=new classic.ClassicRenderer(recordingContext().ctx,commonNoise);
  const observed=[];
  for(const name of expected)renderer[name]=()=>observed.push(name);
  renderer.draw({size:600,hue:174,time:1,ambientTime:.75,ambientNoiseOffset:{x:0,y:0},activityMultiplier:.5,glowIntensity:.1,flareIntensity:.05,smoothedPlaybackLevel:0,listening:false,speaking:false,processing:false});
  assert.deepEqual(observed,expected,'all eleven original reachable layers must execute in original paint order, not rank order');
});

test('same-input state traces match original state parameters, hue easing and independent clocks',()=>{
  assert(frameModule,'pure frame-state module is missing');
  let temporal=frameModule.initialOrbFrame();
  const oracle=new reference(recordingContext().ctx,commonNoise);
  for(const status of states)for(const audible of [false,true])for(const dt of [1/60,1/30,.1]){
    const audio=audible?voice:silence;
    const expected=oracle.step(dt,status,audio,audible,.45);
    const next=frameModule.stepOrbFrame(temporal,{state:status,audio,audible,microphoneLevel:.45},dt,600);
    for(const key of Object.keys(expected))assert.deepEqual(plain(next[key]),plain(expected[key]),`${status} audible=${audible} dt=${dt} ${key}`);
    temporal=next;
  }
});

test('complete geometry and canvas calls match original methods under common injected noise',()=>{
  assert(frameModule,'pure frame-state module is missing');
  const oracle=new reference(recordingContext().ctx,commonNoise);
  for(const size of [400,600,800])for(const status of states)for(const audible of [false,true]){
    const audio=audible?voice:silence;
    const frame={...oracle.step(1/30,status,audio,audible,.45,size),status,audible};
    const expected=recordingContext();const actual=recordingContext();
    new reference(expected.ctx,commonNoise).draw(frame);
    const renderer=new classic.ClassicRenderer(actual.ctx,commonNoise);
    const before=JSON.stringify(frame);renderer.draw(frame);
    assert.equal(JSON.stringify(frame),before,'painter must not mutate its frame');
    assert.deepEqual(plain(actual.calls),plain(expected.calls),`${size} ${status} audible=${audible}: original geometry/colors/canvas calls`);
    actual.reset(); renderer.draw(frame);
    assert.deepEqual(plain(actual.calls),plain(expected.calls),'same frame does not advance painter clocks');
  }
});

test('recorder discriminates wrong existing gradient assignments and rejects nonfinite operands',()=>{
  const a=recordingContext(),b=recordingContext();
  const gradients=ctx=>[ctx.createRadialGradient(0,0,0,0,0,1),ctx.createRadialGradient(0,0,0,0,0,2)];
  const aa=gradients(a.ctx),bb=gradients(b.ctx);
  a.ctx.fillStyle=aa[0];b.ctx.fillStyle=bb[1];
  assert.notDeepEqual(plain(a.calls),plain(b.calls),'wrong already-created gradient must remain distinguishable');
  assert.throws(()=>a.ctx.arc(NaN,0,1,0,1),/nonfinite/);
  assert.throws(()=>a.ctx.lineWidth=Infinity,/nonfinite/);
});

function lifecycle(state='CONNECTED') {
  let now=0,nextId=0;const raf=new Map(),listeners=new Map(),motionListeners=new Set();
  const document={hidden:false,addEventListener:(name,fn)=>listeners.set(name,fn),removeEventListener:(name,fn)=>{if(listeners.get(name)===fn)listeners.delete(name);}};
  const motion={matches:false,addEventListener:(_,fn)=>motionListeners.add(fn),removeEventListener:(_,fn)=>motionListeners.delete(fn)};
  const observer={active:false,observe(){this.active=true;},disconnect(){this.active=false;}};
  const record=recordingContext(),canvas={dataset:{},clientWidth:600,width:600,height:600,getContext:()=>record.ctx};
  const globals={performance:{now:()=>now},document,devicePixelRatio:2,matchMedia:query=>query.includes('prefers-reduced')?motion:{matches:false},
    ResizeObserver:function(){return observer;},requestAnimationFrame:fn=>{const id=++nextId;raf.set(id,fn);return id;},cancelAnimationFrame:id=>raf.delete(id)};
  const module=compile(readFileSync(new URL('../src/orb.ts',import.meta.url),'utf8'),'orb.ts',{'./orb-classic':classic,'./orb-frame':frameModule},globals);
  const orb=new module.Orb(canvas,state);
  return {orb,canvas,record,raf,listeners,motionListeners,observer,document,motion,
    advance(time){now=time;const current=[...raf.values()];raf.clear();for(const fn of current)fn(time);},
    visibility(hidden){document.hidden=hidden;listeners.get('visibilitychange')?.();},
    reduce(){motion.matches=true;for(const fn of motionListeners)fn();}};
}

test('lifecycle drift scheduler honors source high-tier 60fps without half-refresh cadence loss',()=>{
  const h=lifecycle('SPEAKING');
  const paints=()=>h.record.calls.filter(call=>call[0]==='clearRect').length;
  const before=paints();
  for(let i=1;i<=120;i++){h.advance(i*1000/120);assert(h.raf.size<=1,'one scheduler');}
  const frames=paints()-before;
  assert(frames>=59&&frames<=61,`high-tier 60fps over 1s / 120 refresh attempts: ${frames} paints`);
  h.orb.destroy();
});

test('hidden stops all painting; resume delta is bounded; reduced motion is static; disposal removes work',()=>{
  const h=lifecycle();h.advance(100);const calls=h.record.calls.length;
  h.visibility(true);assert.equal(h.record.calls.length,calls,'hidden transition must not paint');assert.equal(h.raf.size,0);
  h.advance(60000);assert.equal(h.record.calls.length,calls);
  h.visibility(false);h.advance(60016);h.advance(60100);
  const stats=h.canvas.didiFrameStats();assert(stats.lastDelta<=.1,`resume delta ${stats.lastDelta}`);
  h.reduce();const still=h.record.calls.length;h.advance(60200);assert.equal(h.record.calls.length,still);assert.equal(h.raf.size,0);
  h.orb.destroy();assert.equal(h.raf.size,0);assert.equal(h.listeners.size,0);assert.equal(h.motionListeners.size,0);assert.equal(h.observer.active,false);
  const disposed=h.record.calls.length;h.advance(70000);assert.equal(h.record.calls.length,disposed);
});

test('disconnect clears live input; stale audio is silent without manufacturing a voice path',()=>{
  const h=lifecycle('SPEAKING');h.orb.audio.push({...voice,timestamp:0});
  assert.equal(h.orb.audio.read(501).level,0,'500ms stale input');
  h.orb.audio.push({...voice,timestamp:100});assert.equal(h.orb.audio.read(100).level,voice.level,'demonstrably fresh input before disconnect');
  h.orb.setState('DISCONNECTED');assert.equal(h.orb.audio.read(100).level,0,'disconnect must clear even nonstale frames');
  h.orb.destroy();
});


test('idle/connected/disconnected breathing uses the previous independent ambient clock',()=>{
  assert(frameModule);
  for(const status of ['IDLE','CONNECTED','DISCONNECTED']){
    const oracle=new reference(recordingContext().ctx,commonNoise);
    let temporal=frameModule.initialOrbFrame();
    for(let frame=0;frame<3;frame++){
      const expected=oracle.step(1/30,status,silence,false);
      temporal=frameModule.stepOrbFrame(temporal,{state:status,audio:silence,audible:false,microphoneLevel:0},1/30,600);
      assert.equal(temporal.activityMultiplier,expected.activityMultiplier,`${status} ambient breathing frame${frame}`);
    }
  }
});

test('known host pulses/resting and neutral/disabled semantics retain original source CSS',()=>{
  const css=readFileSync(new URL('../src/style.css',import.meta.url),'utf8');
  const keyframe=(source,name)=>{
    const start=source.indexOf(`@keyframes ${name}`);assert(start>=0,`missing ${name}`);
    const open=source.indexOf('{',start);let depth=1,index=open+1;
    while(depth&&index<source.length){if(source[index]==='{')depth++;if(source[index]==='}')depth--;index++;}
    assert.equal(depth,0);return source.slice(open,index).replace(/\s+/g,'').replace(/0\./g,'.').replace(/;}/g,'}');
  };
  for(const [original,port] of [['breathe','orb-breathe'],['speak-pulse','orb-speak-pulse'],['pulse-slow','orb-pulse-slow'],['rest-breathe','orb-rest-breathe']])
    assert.equal(keyframe(css,port),keyframe(fixture.wrapperCSS,original),`original ${original} compositor motion`);
  const h=lifecycle('CONNECTED');
  for(const state of ['IDLE','DISCONNECTED','CONNECTING','PROCESSING','RECONNECTING','SPEAKING']){
    h.orb.setState(state);
    assert.equal(h.canvas.dataset.disabled,String(['IDLE','DISCONNECTED','CONNECTING'].includes(state)),`${state} known disabled predicate`);
  }
  h.orb.destroy();
});
