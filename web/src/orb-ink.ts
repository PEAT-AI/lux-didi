/** Transparent ink conversion after all canonical geometry, without frame readback. */
const VERTEX = `#version 300 es
in vec2 position;out vec2 uv;
void main(){gl_Position=vec4(position,0.,1.);uv=position*.5+.5;}`;
const FRAGMENT = `#version 300 es
precision highp float;precision highp int;
in vec2 uv;out vec4 colour;uniform sampler2D surface;uniform sampler2D unpremultiply;uniform sampler2D branchTies;
int straight(int p,int a){return int(roundEven(texelFetch(unpremultiply,ivec2(p,a),0).r*255.));}
int nearest(int n,int d){return (2*n+d)/(2*d);}
void main(){
  vec4 t=texture(surface,uv);int a=int(roundEven(t.a*255.));
  if(a==0){colour=vec4(0.);return;}
  ivec3 p=ivec3(roundEven(t.rgb*255.));
  ivec3 c=ivec3(straight(p.r,a),straight(p.g,a),straight(p.b,a));
  int l=2126*c.r+7152*c.g+722*c.b;int peak=max(max(c.r,c.g),c.b);
  if(l>0&&l<1581000){
    int difference=l-peak*6200;
    bool scale=difference>0;
    if(difference==0){int mask=int(roundEven(texelFetch(branchTies,c.rg,0).r*255.));scale=(mask&(peak==c.r?1:2))!=0;}
    if(scale)c=ivec3(nearest(c.r*1581000,l),nearest(c.g*1581000,l),nearest(c.b*1581000,l));
    else{int d=2550000-l;c=ivec3(nearest(c.r*969000+255*(1581000-l),d),nearest(c.g*969000+255*(1581000-l),d),nearest(c.b*969000+255*(1581000-l),d));}
  }
  colour=vec4(vec3(c)/255.*t.a,t.a);
}`;
const IDENTITY = `#version 300 es
precision highp float;in vec2 uv;out vec4 colour;uniform sampler2D surface;
void main(){colour=texture(surface,uv);}`;
let calibrated: Uint8Array | undefined;
function branchTies(): Uint8Array {
  const table=new Uint8Array(65536);
  const scales=(r: number,g: number,b: number) => Math.max(r,g,b)*(.62/((.2126*r+.7152*g+.0722*b)/255))<=255;
  for(let r=0;r<256;r++)for(let g=0;g<256;g++){
    const redPeak=(4074*r-7152*g)/722,bluePeak=(2126*r+7152*g)/5478;
    if(Number.isInteger(redPeak)&&redPeak>=0&&redPeak<=r&&g<=r&&scales(r,g,redPeak))table[g*256+r]|=1;
    if(Number.isInteger(bluePeak)&&bluePeak>=Math.max(r,g)&&bluePeak<=255&&scales(r,g,bluePeak))table[g*256+r]|=2;
  }
  return table;
}
let ties: Uint8Array | undefined;


export class OrbInkSurface {
  private readonly gl: WebGL2RenderingContext;
  private program!: WebGLProgram;
  private texture!: WebGLTexture;
  private textureWidth = 0;
  private textureHeight = 0;
  private resources: Array<() => void> = [];
  private available = true;
  constructor(private canvas: HTMLCanvasElement, readonly source: HTMLCanvasElement) {
    const gl=canvas.getContext('webgl2',{alpha:true,premultipliedAlpha:true,antialias:false});
    if(!gl)throw Error('The transparent orb requires WebGL2.');
    this.gl=gl;
    this.initialize();
    canvas.addEventListener('webglcontextlost',this.lost);
    canvas.addEventListener('webglcontextrestored',this.restored);
  }
  private shader(type: number, code: string): WebGLShader {
    const gl=this.gl,shader=gl.createShader(type);
    if(!shader)throw Error('Orb shader allocation failed.');
    this.resources.push(()=>gl.deleteShader(shader));gl.shaderSource(shader,code);gl.compileShader(shader);
    if(!gl.getShaderParameter(shader,gl.COMPILE_STATUS))throw Error(`Orb shader: ${gl.getShaderInfoLog(shader)}`);
    return shader;
  }
  private link(fragment: string): WebGLProgram {
    const gl=this.gl,program=gl.createProgram();
    if(!program)throw Error('Orb program allocation failed.');
    this.resources.push(()=>gl.deleteProgram(program));
    gl.attachShader(program,this.shader(gl.VERTEX_SHADER,VERTEX));
    gl.attachShader(program,this.shader(gl.FRAGMENT_SHADER,fragment));gl.linkProgram(program);
    if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(`Orb program: ${gl.getProgramInfoLog(program)}`);
    return program;
  }
  private bind(program: WebGLProgram): void {
    const gl=this.gl;gl.useProgram(program);
    const position=gl.getAttribLocation(program,'position');
    gl.enableVertexAttribArray(position);gl.vertexAttribPointer(position,2,gl.FLOAT,false,0,0);
  }
  private initialize(): void {
    const gl=this.gl;this.resources=[];this.textureWidth=0;this.textureHeight=0;
    const buffer=gl.createBuffer();if(!buffer)throw Error('Orb buffer allocation failed.');
    this.resources.push(()=>gl.deleteBuffer(buffer));gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
    gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,3,-1,-1,3]),gl.STATIC_DRAW);
    const texture=gl.createTexture();if(!texture)throw Error('Orb texture allocation failed.');
    this.texture=texture;this.resources.push(()=>gl.deleteTexture(texture));gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,texture);
    for(const key of [gl.TEXTURE_WRAP_S,gl.TEXTURE_WRAP_T])gl.texParameteri(gl.TEXTURE_2D,key,gl.CLAMP_TO_EDGE);
    for(const key of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,key,gl.NEAREST);
    const lookup=calibrated??this.calibrate();calibrated=lookup;
    this.program=this.link(FRAGMENT);this.bind(this.program);
    const table=gl.createTexture();if(!table)throw Error('Orb lookup allocation failed.');
    this.resources.push(()=>gl.deleteTexture(table));gl.activeTexture(gl.TEXTURE1);gl.bindTexture(gl.TEXTURE_2D,table);
    for(const key of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,key,gl.NEAREST);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,false);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,false);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,256,256,0,gl.RED,gl.UNSIGNED_BYTE,lookup);
    gl.uniform1i(gl.getUniformLocation(this.program,'unpremultiply'),1);
    const branches=gl.createTexture();if(!branches)throw Error('Orb branch lookup allocation failed.');
    this.resources.push(()=>gl.deleteTexture(branches));gl.activeTexture(gl.TEXTURE2);gl.bindTexture(gl.TEXTURE_2D,branches);
    for(const key of [gl.TEXTURE_MIN_FILTER,gl.TEXTURE_MAG_FILTER])gl.texParameteri(gl.TEXTURE_2D,key,gl.NEAREST);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.R8,256,256,0,gl.RED,gl.UNSIGNED_BYTE,ties??=branchTies());
    gl.uniform1i(gl.getUniformLocation(this.program,'branchTies'),2);
    gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,this.texture);
    this.available=true;
  }
  private upload(source: HTMLCanvasElement): void {
    const gl=this.gl;
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL,true);gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
    if(this.textureWidth!==source.width||this.textureHeight!==source.height){
      gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,source.width,source.height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
      this.textureWidth=source.width;this.textureHeight=source.height;
    }
    gl.texSubImage2D(gl.TEXTURE_2D,0,0,0,gl.RGBA,gl.UNSIGNED_BYTE,source);
  }
  private calibrate(): Uint8Array {
    const gl=this.gl,canvas=document.createElement('canvas');canvas.width=256;canvas.height=256;
    const context=canvas.getContext('2d');if(!context)throw Error('Orb calibration canvas unavailable.');
    const image=context.createImageData(256,256);
    for(let a=0;a<256;a++)for(let c=0;c<256;c++)image.data.set([c,c,c,a],(a*256+c)*4);
    context.putImageData(image,0,0);
    const straight=context.getImageData(0,0,256,256).data;
    this.canvas.width=256;this.canvas.height=256;
    this.bind(this.link(IDENTITY));this.upload(canvas);gl.viewport(0,0,256,256);gl.drawArrays(gl.TRIANGLES,0,3);
    const premultiplied=new Uint8Array(256*256*4);gl.readPixels(0,0,256,256,gl.RGBA,gl.UNSIGNED_BYTE,premultiplied);
    if(gl.getError()!==gl.NO_ERROR)throw Error('Orb calibration read failed.');
    const lookup=new Uint8Array(65536),assigned=new Uint8Array(65536);
    for(let y=0;y<256;y++)for(let x=0;x<256;x++){
      const i=(y*256+x)*4,j=((255-y)*256+x)*4;
      const key=premultiplied[j+3]*256+premultiplied[j],value=straight[i];
      if(assigned[key]&&lookup[key]!==value)throw Error('Orb calibration has inconsistent alpha conversion.');
      assigned[key]=1;lookup[key]=value;
    }
    return lookup;
  }
  present(): boolean {
    if(!this.available)return false;
    const gl=this.gl;
    if(this.canvas.width!==this.source.width||this.canvas.height!==this.source.height){
      this.canvas.width=this.source.width;this.canvas.height=this.source.height;
    }
    this.bind(this.program);this.upload(this.source);
    gl.viewport(0,0,this.canvas.width,this.canvas.height);gl.drawArrays(gl.TRIANGLES,0,3);
    return true;
  }
  private lost = (event: Event) => { event.preventDefault();this.available=false; };
  private restored = () => { this.initialize();this.present(); };
  destroy(): void {
    this.canvas.removeEventListener('webglcontextlost',this.lost);this.canvas.removeEventListener('webglcontextrestored',this.restored);
    for(const release of this.resources)release();
    this.resources=[];this.available=false;
  }
}
