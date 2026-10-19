import {chromium} from 'playwright';
import ts from 'typescript';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {readFile,writeFile,mkdir} from 'node:fs/promises';
import {join} from 'node:path';
const artifacts=process.env.DIDI_WEB_ARTIFACTS||join(import.meta.dirname,'../test-artifacts/orb-ink');
await mkdir(artifacts,{recursive:true});
const server=createServer(async(req,res)=>{
  try{
    if(req.url==='/')return res.setHeader('Content-Type','text/html').end('<!doctype html><script type="module">import{Orb}from"/orb.js";import{OrbInkSurface}from"/orb-ink.js";import{ORB_VISUALS,publishOrbVisual}from"/orb-states.js";window.fixture={Orb,OrbInkSurface,ORB_VISUALS,publishOrbVisual};</script>');
    let script;
    if(req.url==='/simplex-noise.js')script=await readFile(join(import.meta.dirname,'../node_modules/simplex-noise/dist/esm/simplex-noise.js'),'utf8');
    else{
      assert.match(req.url,/^\/orb(?:-ink|-classic|-level|-states)?\.js$/);
      const source=await readFile(join(import.meta.dirname,'../src',req.url.slice(1).replace('.js','.ts')),'utf8');
      script=ts.transpileModule(source,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}}).outputText.replaceAll("'simplex-noise'","'./simplex-noise.js'").replaceAll(".ts'",".js'");
    }
    res.setHeader('Content-Type','text/javascript').end(script);
  }catch{res.writeHead(404).end();}
});
await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let browser;
try{
  browser=await chromium.launch({headless:true,args:(process.env.LUX_BROWSER_GPU_ARGS||'--use-angle=metal --enable-gpu').split(' ').filter(Boolean)});
  const page=await browser.newPage({deviceScaleFactor:2,reducedMotion:'reduce'});
  if(process.env.LUX_BROWSER_SLOT_TOKEN){const {assertGpu}=await import('/Users/rob/GitHub/lux-harness/skills/pi-control/scripts/pi_browser_launch.mjs');await assertGpu(page);}
  await page.goto(`http://127.0.0.1:${server.address().port}`);await page.waitForFunction(()=>!!window.fixture);
  const result=await page.evaluate(()=>{
    const {Orb,OrbInkSurface,ORB_VISUALS,publishOrbVisual}=window.fixture;
    // Accepted CPU oracle from 3822a54e, without its former scheduler interception.
    const cpu=source=>{
      const canvas=document.createElement('canvas');canvas.width=source.width;canvas.height=source.height;
      const context=canvas.getContext('2d');context.drawImage(source,0,0);const image=context.getImageData(0,0,canvas.width,canvas.height),p=image.data;
      for(let i=0;i<p.length;i+=4){
        if(p[i+3]===0)continue;const r=p[i],g=p[i+1],b=p[i+2],l=(.2126*r+.7152*g+.0722*b)/255;
        if(l<=0||l>=.62)continue;const peak=Math.max(r,g,b),scale=.62/l;
        if(peak*scale<=255){p[i]=Math.round(r*scale);p[i+1]=Math.round(g*scale);p[i+2]=Math.round(b*scale);}
        else{const mix=(.62-l)/(1-l);p[i]=Math.round(r+(255-r)*mix);p[i+1]=Math.round(g+(255-g)*mix);p[i+2]=Math.round(b+(255-b)*mix);}
      }
      context.putImageData(image,0,0);return Array.from(context.getImageData(0,0,canvas.width,canvas.height).data,(v,i)=>i%4===3?v:Math.round(v*p[i-i%4+3]/255));
    };
    const checks=[];
    const verify=(source,ink,label)=>{
      if(!ink.present())throw Error('No GPU frame');
      const gl=ink.canvas.getContext('webgl2'),bytes=new Uint8Array(source.width*source.height*4);gl.readPixels(0,0,source.width,source.height,gl.RGBA,gl.UNSIGNED_BYTE,bytes);
      const expected=cpu(source),raw=source.getContext('2d').getImageData(0,0,source.width,source.height).data;let max=0,over1=0;const worst=[];
      for(let y=0;y<source.height;y++)for(let x=0;x<source.width*4;x++){
        const error=Math.abs(expected[y*source.width*4+x]-bytes[(source.height-1-y)*source.width*4+x]);max=Math.max(max,error);if(error>1){over1++;if(worst.length<3){const pixel=(y*source.width*4+x)&~3;worst.push({source:Array.from(raw.slice(pixel,pixel+4)),expected:expected.slice(pixel,pixel+4),error});}}
      }
      checks.push({label,maxChannelError:max,channelsOver1:over1,channels:bytes.length,worst});
    };
    const known=document.createElement('canvas');known.width=16;known.height=16;const context=known.getContext('2d'),image=context.createImageData(16,16);let seed=41;
    for(let i=0;i<image.data.length;i++){seed=(1664525*seed+1013904223)>>>0;image.data[i]=seed>>>24;}
    context.putImageData(image,0,0);const knownInk=new OrbInkSurface(document.createElement('canvas'),known);verify(known,knownInk,'asymmetric-rgba');knownInk.destroy();
    for(const [state,voice] of [['cold','IDLE'],['listening','LISTENING'],['thinking','PROCESSING'],['speaking','SPEAKING']]){
      const source=document.createElement('canvas');source.style.width='220px';document.body.append(source);
      const orb=new Orb(source,voice),ink=new OrbInkSurface(document.createElement('canvas'),source);
      publishOrbVisual(source,ORB_VISUALS[state]);orb.prepareSurface();verify(source,ink,state);
      for(const t of [.1,.25,.5,.75,.9]){
        publishOrbVisual(source,{...ORB_VISUALS[state],mixing:{from:ORB_VISUALS.cold.hue,to:ORB_VISUALS[state].hue,t}});
        orb.prepareSurface();verify(source,ink,`${state}-crossfade-${t}`);
      }
      ink.destroy();orb.destroy();source.remove();
    }
    return checks;
  });
  await writeFile(join(artifacts,'orb-ink-result.json'),JSON.stringify(result,null,2));
  assert.equal(result.length,25);assert(result.every(check=>check.channelsOver1===0),JSON.stringify(result.filter(check=>check.channelsOver1)));
  console.log('ORB-INK-BROWSER PASS actual=OrbInkSurface cases=25 all-canonical-layers=retained maxChannelError='+Math.max(...result.map(check=>check.maxChannelError)));
}finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
