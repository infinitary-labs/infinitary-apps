(function(){"use strict";var Pt;function u(e,t,n){function r(c,l){if(c._zod||Object.defineProperty(c,"_zod",{value:{def:l,constr:i,traits:new Set},enumerable:!1}),c._zod.traits.has(e))return;c._zod.traits.add(e),t(c,l);const d=i.prototype,w=Object.keys(d);for(let b=0;b<w.length;b++){const _=w[b];_ in c||(c[_]=d[_].bind(c))}}const o=n?.Parent??Object;class s extends o{}Object.defineProperty(s,"name",{value:e});function i(c){var l;const d=n?.Parent?new s:this;r(d,c),(l=d._zod).deferred??(l.deferred=[]);for(const w of d._zod.deferred)w();return d}return Object.defineProperty(i,"init",{value:r}),Object.defineProperty(i,Symbol.hasInstance,{value:c=>n?.Parent&&c instanceof n.Parent?!0:c?._zod?.traits?.has(e)}),Object.defineProperty(i,"name",{value:e}),i}class se extends Error{constructor(){super("Encountered Promise during synchronous parse. Use .parseAsync() instead.")}}class Zt extends Error{constructor(t){super(`Encountered unidirectional transform during encode: ${t}`),this.name="ZodEncodeError"}}(Pt=globalThis).__zod_globalConfig??(Pt.__zod_globalConfig={});const Ve=globalThis.__zod_globalConfig;function B(e){return Ve}function Dt(e){const t=Object.values(e).filter(r=>typeof r=="number");return Object.entries(e).filter(([r,o])=>t.indexOf(+r)===-1).map(([r,o])=>o)}function Ge(e,t){return typeof t=="bigint"?t.toString():t}function Ae(e){return{get value(){{const t=e();return Object.defineProperty(this,"value",{value:t}),t}}}}function Ke(e){return e==null}function He(e){const t=e.startsWith("^")?1:0,n=e.endsWith("$")?e.length-1:e.length;return e.slice(t,n)}function Kr(e,t){const n=e/t,r=Math.round(n),o=Number.EPSILON*Math.max(Math.abs(n),1);return Math.abs(n-r)<o?0:n-r}const Mt=Symbol("evaluating");function S(e,t,n){let r;Object.defineProperty(e,t,{get(){if(r!==Mt)return r===void 0&&(r=Mt,r=n()),r},set(o){Object.defineProperty(e,t,{value:o})},configurable:!0})}function Q(e,t,n){Object.defineProperty(e,t,{value:n,writable:!0,enumerable:!0,configurable:!0})}function G(...e){const t={};for(const n of e){const r=Object.getOwnPropertyDescriptors(n);Object.assign(t,r)}return Object.defineProperties({},t)}function Ft(e){return JSON.stringify(e)}function Hr(e){return e.toLowerCase().trim().replace(/[^\w\s-]/g,"").replace(/[\s_-]+/g,"-").replace(/^-+|-+$/g,"")}const Lt="captureStackTrace"in Error?Error.captureStackTrace:(...e)=>{};function he(e){return typeof e=="object"&&e!==null&&!Array.isArray(e)}const Xr=Ae(()=>{if(Ve.jitless||typeof navigator<"u"&&navigator?.userAgent?.includes("Cloudflare"))return!1;try{const e=Function;return new e(""),!0}catch{return!1}});function ce(e){if(he(e)===!1)return!1;const t=e.constructor;if(t===void 0||typeof t!="function")return!0;const n=t.prototype;return!(he(n)===!1||Object.prototype.hasOwnProperty.call(n,"isPrototypeOf")===!1)}function qt(e){return ce(e)?{...e}:Array.isArray(e)?[...e]:e instanceof Map?new Map(e):e instanceof Set?new Set(e):e}const Yr=new Set(["string","number","symbol"]);function le(e){return e.replace(/[.*+?^${}()|[\]\\]/g,"\\$&")}function K(e,t,n){const r=new e._zod.constr(t??e._zod.def);return(!t||n?.parent)&&(r._zod.parent=e),r}function y(e){const t=e;if(!t)return{};if(typeof t=="string")return{error:()=>t};if(t?.message!==void 0){if(t?.error!==void 0)throw new Error("Cannot specify both `message` and `error` params");t.error=t.message}return delete t.message,typeof t.error=="string"?{...t,error:()=>t.error}:t}function Qr(e){return Object.keys(e).filter(t=>e[t]._zod.optin==="optional"&&e[t]._zod.optout==="optional")}const eo={safeint:[Number.MIN_SAFE_INTEGER,Number.MAX_SAFE_INTEGER],int32:[-2147483648,2147483647],uint32:[0,4294967295],float32:[-34028234663852886e22,34028234663852886e22],float64:[-Number.MAX_VALUE,Number.MAX_VALUE]};function to(e,t){const n=e._zod.def,r=n.checks;if(r&&r.length>0)throw new Error(".pick() cannot be used on object schemas containing refinements");const s=G(e._zod.def,{get shape(){const i={};for(const c in t){if(!(c in n.shape))throw new Error(`Unrecognized key: "${c}"`);t[c]&&(i[c]=n.shape[c])}return Q(this,"shape",i),i},checks:[]});return K(e,s)}function no(e,t){const n=e._zod.def,r=n.checks;if(r&&r.length>0)throw new Error(".omit() cannot be used on object schemas containing refinements");const s=G(e._zod.def,{get shape(){const i={...e._zod.def.shape};for(const c in t){if(!(c in n.shape))throw new Error(`Unrecognized key: "${c}"`);t[c]&&delete i[c]}return Q(this,"shape",i),i},checks:[]});return K(e,s)}function ro(e,t){if(!ce(t))throw new Error("Invalid input to extend: expected a plain object");const n=e._zod.def.checks;if(n&&n.length>0){const s=e._zod.def.shape;for(const i in t)if(Object.getOwnPropertyDescriptor(s,i)!==void 0)throw new Error("Cannot overwrite keys on object schemas containing refinements. Use `.safeExtend()` instead.")}const o=G(e._zod.def,{get shape(){const s={...e._zod.def.shape,...t};return Q(this,"shape",s),s}});return K(e,o)}function oo(e,t){if(!ce(t))throw new Error("Invalid input to safeExtend: expected a plain object");const n=G(e._zod.def,{get shape(){const r={...e._zod.def.shape,...t};return Q(this,"shape",r),r}});return K(e,n)}function io(e,t){if(e._zod.def.checks?.length)throw new Error(".merge() cannot be used on object schemas containing refinements. Use .safeExtend() instead.");const n=G(e._zod.def,{get shape(){const r={...e._zod.def.shape,...t._zod.def.shape};return Q(this,"shape",r),r},get catchall(){return t._zod.def.catchall},checks:t._zod.def.checks??[]});return K(e,n)}function ao(e,t,n){const o=t._zod.def.checks;if(o&&o.length>0)throw new Error(".partial() cannot be used on object schemas containing refinements");const i=G(t._zod.def,{get shape(){const c=t._zod.def.shape,l={...c};if(n)for(const d in n){if(!(d in c))throw new Error(`Unrecognized key: "${d}"`);n[d]&&(l[d]=e?new e({type:"optional",innerType:c[d]}):c[d])}else for(const d in c)l[d]=e?new e({type:"optional",innerType:c[d]}):c[d];return Q(this,"shape",l),l},checks:[]});return K(t,i)}function so(e,t,n){const r=G(t._zod.def,{get shape(){const o=t._zod.def.shape,s={...o};if(n)for(const i in n){if(!(i in s))throw new Error(`Unrecognized key: "${i}"`);n[i]&&(s[i]=new e({type:"nonoptional",innerType:o[i]}))}else for(const i in o)s[i]=new e({type:"nonoptional",innerType:o[i]});return Q(this,"shape",s),s}});return K(t,r)}function ue(e,t=0){if(e.aborted===!0)return!0;for(let n=t;n<e.issues.length;n++)if(e.issues[n]?.continue!==!0)return!0;return!1}function co(e,t=0){if(e.aborted===!0)return!0;for(let n=t;n<e.issues.length;n++)if(e.issues[n]?.continue===!1)return!0;return!1}function de(e,t){return t.map(n=>{var r;return(r=n).path??(r.path=[]),n.path.unshift(e),n})}function ze(e){return typeof e=="string"?e:e?.message}function W(e,t,n){const r=e.message?e.message:ze(e.inst?._zod.def?.error?.(e))??ze(t?.error?.(e))??ze(n.customError?.(e))??ze(n.localeError?.(e))??"Invalid input",{inst:o,continue:s,input:i,...c}=e;return c.path??(c.path=[]),c.message=r,t?.reportInput&&(c.input=i),c}function Xe(e){return Array.isArray(e)?"array":typeof e=="string"?"string":"unknown"}function ge(...e){const[t,n,r]=e;return typeof t=="string"?{message:t,code:"custom",input:n,inst:r}:{...t}}const jt=(e,t)=>{e.name="$ZodError",Object.defineProperty(e,"_zod",{value:e._zod,enumerable:!1}),Object.defineProperty(e,"issues",{value:t,enumerable:!1}),e.message=JSON.stringify(t,Ge,2),Object.defineProperty(e,"toString",{value:()=>e.message,enumerable:!1})},Bt=u("$ZodError",jt),Wt=u("$ZodError",jt,{Parent:Error});function lo(e,t=n=>n.message){const n={},r=[];for(const o of e.issues)o.path.length>0?(n[o.path[0]]=n[o.path[0]]||[],n[o.path[0]].push(t(o))):r.push(t(o));return{formErrors:r,fieldErrors:n}}function uo(e,t=n=>n.message){const n={_errors:[]},r=(o,s=[])=>{for(const i of o.issues)if(i.code==="invalid_union"&&i.errors.length)i.errors.map(c=>r({issues:c},[...s,...i.path]));else if(i.code==="invalid_key")r({issues:i.issues},[...s,...i.path]);else if(i.code==="invalid_element")r({issues:i.issues},[...s,...i.path]);else{const c=[...s,...i.path];if(c.length===0)n._errors.push(t(i));else{let l=n,d=0;for(;d<c.length;){const w=c[d];d===c.length-1?(l[w]=l[w]||{_errors:[]},l[w]._errors.push(t(i))):l[w]=l[w]||{_errors:[]},l=l[w],d++}}}};return r(e),n}const Ye=e=>(t,n,r,o)=>{const s=r?{...r,async:!1}:{async:!1},i=t._zod.run({value:n,issues:[]},s);if(i instanceof Promise)throw new se;if(i.issues.length){const c=new(o?.Err??e)(i.issues.map(l=>W(l,s,B())));throw Lt(c,o?.callee),c}return i.value},Qe=e=>async(t,n,r,o)=>{const s=r?{...r,async:!0}:{async:!0};let i=t._zod.run({value:n,issues:[]},s);if(i instanceof Promise&&(i=await i),i.issues.length){const c=new(o?.Err??e)(i.issues.map(l=>W(l,s,B())));throw Lt(c,o?.callee),c}return i.value},Oe=e=>(t,n,r)=>{const o=r?{...r,async:!1}:{async:!1},s=t._zod.run({value:n,issues:[]},o);if(s instanceof Promise)throw new se;return s.issues.length?{success:!1,error:new(e??Bt)(s.issues.map(i=>W(i,o,B())))}:{success:!0,data:s.value}},fo=Oe(Wt),Ie=e=>async(t,n,r)=>{const o=r?{...r,async:!0}:{async:!0};let s=t._zod.run({value:n,issues:[]},o);return s instanceof Promise&&(s=await s),s.issues.length?{success:!1,error:new e(s.issues.map(i=>W(i,o,B())))}:{success:!0,data:s.value}},po=Ie(Wt),mo=e=>(t,n,r)=>{const o=r?{...r,direction:"backward"}:{direction:"backward"};return Ye(e)(t,n,o)},ho=e=>(t,n,r)=>Ye(e)(t,n,r),go=e=>async(t,n,r)=>{const o=r?{...r,direction:"backward"}:{direction:"backward"};return Qe(e)(t,n,o)},vo=e=>async(t,n,r)=>Qe(e)(t,n,r),wo=e=>(t,n,r)=>{const o=r?{...r,direction:"backward"}:{direction:"backward"};return Oe(e)(t,n,o)},yo=e=>(t,n,r)=>Oe(e)(t,n,r),bo=e=>async(t,n,r)=>{const o=r?{...r,direction:"backward"}:{direction:"backward"};return Ie(e)(t,n,o)},ko=e=>async(t,n,r)=>Ie(e)(t,n,r),_o=/^[cC][0-9a-z]{6,}$/,xo=/^[0-9a-z]+$/,So=/^[0-9A-HJKMNP-TV-Za-hjkmnp-tv-z]{26}$/,Eo=/^[0-9a-vA-V]{20}$/,Ao=/^[A-Za-z0-9]{27}$/,zo=/^[a-zA-Z0-9_-]{21}$/,Oo=/^P(?:(\d+W)|(?!.*W)(?=\d|T\d)(\d+Y)?(\d+M)?(\d+D)?(T(?=\d)(\d+H)?(\d+M)?(\d+([.,]\d+)?S)?)?)$/,Io=/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})$/,Jt=e=>e?new RegExp(`^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-${e}[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12})$`):/^([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-8][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}|00000000-0000-0000-0000-000000000000|ffffffff-ffff-ffff-ffff-ffffffffffff)$/,To=/^(?!\.)(?!.*\.\.)([A-Za-z0-9_'+\-\.]*)[A-Za-z0-9_+-]@([A-Za-z0-9][A-Za-z0-9\-]*\.)+[A-Za-z]{2,}$/,$o="^(\\p{Extended_Pictographic}|\\p{Emoji_Component})+$";function No(){return new RegExp($o,"u")}const Co=/^(?:(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(?:25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])$/,Ro=/^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,7}:|([0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|([0-9a-fA-F]{1,4}:){1,5}(:[0-9a-fA-F]{1,4}){1,2}|([0-9a-fA-F]{1,4}:){1,4}(:[0-9a-fA-F]{1,4}){1,3}|([0-9a-fA-F]{1,4}:){1,3}(:[0-9a-fA-F]{1,4}){1,4}|([0-9a-fA-F]{1,4}:){1,2}(:[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:((:[0-9a-fA-F]{1,4}){1,6})|:((:[0-9a-fA-F]{1,4}){1,7}|:))$/,Uo=/^((25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\.){3}(25[0-5]|2[0-4][0-9]|1[0-9][0-9]|[1-9][0-9]|[0-9])\/([0-9]|[1-2][0-9]|3[0-2])$/,Po=/^(([0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|::|([0-9a-fA-F]{1,4})?::([0-9a-fA-F]{1,4}:?){0,6})\/(12[0-8]|1[01][0-9]|[1-9]?[0-9])$/,Zo=/^$|^(?:[0-9a-zA-Z+/]{4})*(?:(?:[0-9a-zA-Z+/]{2}==)|(?:[0-9a-zA-Z+/]{3}=))?$/,Vt=/^[A-Za-z0-9_-]*$/,Do=/^https?$/,Mo=/^\+[1-9]\d{6,14}$/,Gt="(?:(?:\\d\\d[2468][048]|\\d\\d[13579][26]|\\d\\d0[48]|[02468][048]00|[13579][26]00)-02-29|\\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\\d|30)|(?:02)-(?:0[1-9]|1\\d|2[0-8])))",Fo=new RegExp(`^${Gt}$`);function Kt(e){const t="(?:[01]\\d|2[0-3]):[0-5]\\d";return typeof e.precision=="number"?e.precision===-1?`${t}`:e.precision===0?`${t}:[0-5]\\d`:`${t}:[0-5]\\d\\.\\d{${e.precision}}`:`${t}(?::[0-5]\\d(?:\\.\\d+)?)?`}function Lo(e){return new RegExp(`^${Kt(e)}$`)}function qo(e){const t=Kt({precision:e.precision}),n=["Z"];e.local&&n.push(""),e.offset&&n.push("([+-](?:[01]\\d|2[0-3]):[0-5]\\d)");const r=`${t}(?:${n.join("|")})`;return new RegExp(`^${Gt}T(?:${r})$`)}const jo=e=>{const t=e?`[\\s\\S]{${e?.minimum??0},${e?.maximum??""}}`:"[\\s\\S]*";return new RegExp(`^${t}$`)},Bo=/^-?\d+$/,Ht=/^-?\d+(?:\.\d+)?$/,Wo=/^(?:true|false)$/i,Jo=/^null$/i,Vo=/^undefined$/i,Go=/^[^A-Z]*$/,Ko=/^[^a-z]*$/,Z=u("$ZodCheck",(e,t)=>{var n;e._zod??(e._zod={}),e._zod.def=t,(n=e._zod).onattach??(n.onattach=[])}),Xt={number:"number",bigint:"bigint",object:"date"},Yt=u("$ZodCheckLessThan",(e,t)=>{Z.init(e,t);const n=Xt[typeof t.value];e._zod.onattach.push(r=>{const o=r._zod.bag,s=(t.inclusive?o.maximum:o.exclusiveMaximum)??Number.POSITIVE_INFINITY;t.value<s&&(t.inclusive?o.maximum=t.value:o.exclusiveMaximum=t.value)}),e._zod.check=r=>{(t.inclusive?r.value<=t.value:r.value<t.value)||r.issues.push({origin:n,code:"too_big",maximum:typeof t.value=="object"?t.value.getTime():t.value,input:r.value,inclusive:t.inclusive,inst:e,continue:!t.abort})}}),Qt=u("$ZodCheckGreaterThan",(e,t)=>{Z.init(e,t);const n=Xt[typeof t.value];e._zod.onattach.push(r=>{const o=r._zod.bag,s=(t.inclusive?o.minimum:o.exclusiveMinimum)??Number.NEGATIVE_INFINITY;t.value>s&&(t.inclusive?o.minimum=t.value:o.exclusiveMinimum=t.value)}),e._zod.check=r=>{(t.inclusive?r.value>=t.value:r.value>t.value)||r.issues.push({origin:n,code:"too_small",minimum:typeof t.value=="object"?t.value.getTime():t.value,input:r.value,inclusive:t.inclusive,inst:e,continue:!t.abort})}}),Ho=u("$ZodCheckMultipleOf",(e,t)=>{Z.init(e,t),e._zod.onattach.push(n=>{var r;(r=n._zod.bag).multipleOf??(r.multipleOf=t.value)}),e._zod.check=n=>{if(typeof n.value!=typeof t.value)throw new Error("Cannot mix number and bigint in multiple_of check.");(typeof n.value=="bigint"?n.value%t.value===BigInt(0):Kr(n.value,t.value)===0)||n.issues.push({origin:typeof n.value,code:"not_multiple_of",divisor:t.value,input:n.value,inst:e,continue:!t.abort})}}),Xo=u("$ZodCheckNumberFormat",(e,t)=>{Z.init(e,t),t.format=t.format||"float64";const n=t.format?.includes("int"),r=n?"int":"number",[o,s]=eo[t.format];e._zod.onattach.push(i=>{const c=i._zod.bag;c.format=t.format,c.minimum=o,c.maximum=s,n&&(c.pattern=Bo)}),e._zod.check=i=>{const c=i.value;if(n){if(!Number.isInteger(c)){i.issues.push({expected:r,format:t.format,code:"invalid_type",continue:!1,input:c,inst:e});return}if(!Number.isSafeInteger(c)){c>0?i.issues.push({input:c,code:"too_big",maximum:Number.MAX_SAFE_INTEGER,note:"Integers must be within the safe integer range.",inst:e,origin:r,inclusive:!0,continue:!t.abort}):i.issues.push({input:c,code:"too_small",minimum:Number.MIN_SAFE_INTEGER,note:"Integers must be within the safe integer range.",inst:e,origin:r,inclusive:!0,continue:!t.abort});return}}c<o&&i.issues.push({origin:"number",input:c,code:"too_small",minimum:o,inclusive:!0,inst:e,continue:!t.abort}),c>s&&i.issues.push({origin:"number",input:c,code:"too_big",maximum:s,inclusive:!0,inst:e,continue:!t.abort})}}),Yo=u("$ZodCheckMaxLength",(e,t)=>{var n;Z.init(e,t),(n=e._zod.def).when??(n.when=r=>{const o=r.value;return!Ke(o)&&o.length!==void 0}),e._zod.onattach.push(r=>{const o=r._zod.bag.maximum??Number.POSITIVE_INFINITY;t.maximum<o&&(r._zod.bag.maximum=t.maximum)}),e._zod.check=r=>{const o=r.value;if(o.length<=t.maximum)return;const i=Xe(o);r.issues.push({origin:i,code:"too_big",maximum:t.maximum,inclusive:!0,input:o,inst:e,continue:!t.abort})}}),Qo=u("$ZodCheckMinLength",(e,t)=>{var n;Z.init(e,t),(n=e._zod.def).when??(n.when=r=>{const o=r.value;return!Ke(o)&&o.length!==void 0}),e._zod.onattach.push(r=>{const o=r._zod.bag.minimum??Number.NEGATIVE_INFINITY;t.minimum>o&&(r._zod.bag.minimum=t.minimum)}),e._zod.check=r=>{const o=r.value;if(o.length>=t.minimum)return;const i=Xe(o);r.issues.push({origin:i,code:"too_small",minimum:t.minimum,inclusive:!0,input:o,inst:e,continue:!t.abort})}}),ei=u("$ZodCheckLengthEquals",(e,t)=>{var n;Z.init(e,t),(n=e._zod.def).when??(n.when=r=>{const o=r.value;return!Ke(o)&&o.length!==void 0}),e._zod.onattach.push(r=>{const o=r._zod.bag;o.minimum=t.length,o.maximum=t.length,o.length=t.length}),e._zod.check=r=>{const o=r.value,s=o.length;if(s===t.length)return;const i=Xe(o),c=s>t.length;r.issues.push({origin:i,...c?{code:"too_big",maximum:t.length}:{code:"too_small",minimum:t.length},inclusive:!0,exact:!0,input:r.value,inst:e,continue:!t.abort})}}),Te=u("$ZodCheckStringFormat",(e,t)=>{var n,r;Z.init(e,t),e._zod.onattach.push(o=>{const s=o._zod.bag;s.format=t.format,t.pattern&&(s.patterns??(s.patterns=new Set),s.patterns.add(t.pattern))}),t.pattern?(n=e._zod).check??(n.check=o=>{t.pattern.lastIndex=0,!t.pattern.test(o.value)&&o.issues.push({origin:"string",code:"invalid_format",format:t.format,input:o.value,...t.pattern?{pattern:t.pattern.toString()}:{},inst:e,continue:!t.abort})}):(r=e._zod).check??(r.check=()=>{})}),ti=u("$ZodCheckRegex",(e,t)=>{Te.init(e,t),e._zod.check=n=>{t.pattern.lastIndex=0,!t.pattern.test(n.value)&&n.issues.push({origin:"string",code:"invalid_format",format:"regex",input:n.value,pattern:t.pattern.toString(),inst:e,continue:!t.abort})}}),ni=u("$ZodCheckLowerCase",(e,t)=>{t.pattern??(t.pattern=Go),Te.init(e,t)}),ri=u("$ZodCheckUpperCase",(e,t)=>{t.pattern??(t.pattern=Ko),Te.init(e,t)}),oi=u("$ZodCheckIncludes",(e,t)=>{Z.init(e,t);const n=le(t.includes),r=new RegExp(typeof t.position=="number"?`^.{${t.position}}${n}`:n);t.pattern=r,e._zod.onattach.push(o=>{const s=o._zod.bag;s.patterns??(s.patterns=new Set),s.patterns.add(r)}),e._zod.check=o=>{o.value.includes(t.includes,t.position)||o.issues.push({origin:"string",code:"invalid_format",format:"includes",includes:t.includes,input:o.value,inst:e,continue:!t.abort})}}),ii=u("$ZodCheckStartsWith",(e,t)=>{Z.init(e,t);const n=new RegExp(`^${le(t.prefix)}.*`);t.pattern??(t.pattern=n),e._zod.onattach.push(r=>{const o=r._zod.bag;o.patterns??(o.patterns=new Set),o.patterns.add(n)}),e._zod.check=r=>{r.value.startsWith(t.prefix)||r.issues.push({origin:"string",code:"invalid_format",format:"starts_with",prefix:t.prefix,input:r.value,inst:e,continue:!t.abort})}}),ai=u("$ZodCheckEndsWith",(e,t)=>{Z.init(e,t);const n=new RegExp(`.*${le(t.suffix)}$`);t.pattern??(t.pattern=n),e._zod.onattach.push(r=>{const o=r._zod.bag;o.patterns??(o.patterns=new Set),o.patterns.add(n)}),e._zod.check=r=>{r.value.endsWith(t.suffix)||r.issues.push({origin:"string",code:"invalid_format",format:"ends_with",suffix:t.suffix,input:r.value,inst:e,continue:!t.abort})}}),si=u("$ZodCheckOverwrite",(e,t)=>{Z.init(e,t),e._zod.check=n=>{n.value=t.tx(n.value)}});class ci{constructor(t=[]){this.content=[],this.indent=0,this&&(this.args=t)}indented(t){this.indent+=1,t(this),this.indent-=1}write(t){if(typeof t=="function"){t(this,{execution:"sync"}),t(this,{execution:"async"});return}const r=t.split(`
`).filter(i=>i),o=Math.min(...r.map(i=>i.length-i.trimStart().length)),s=r.map(i=>i.slice(o)).map(i=>" ".repeat(this.indent*2)+i);for(const i of s)this.content.push(i)}compile(){const t=Function,n=this?.args,o=[...(this?.content??[""]).map(s=>`  ${s}`)];return new t(...n,o.join(`
`))}}const li={major:4,minor:4,patch:3},A=u("$ZodType",(e,t)=>{var n;e??(e={}),e._zod.def=t,e._zod.bag=e._zod.bag||{},e._zod.version=li;const r=[...e._zod.def.checks??[]];e._zod.traits.has("$ZodCheck")&&r.unshift(e);for(const o of r)for(const s of o._zod.onattach)s(e);if(r.length===0)(n=e._zod).deferred??(n.deferred=[]),e._zod.deferred?.push(()=>{e._zod.run=e._zod.parse});else{const o=(i,c,l)=>{let d=ue(i),w;for(const b of c){if(b._zod.def.when){if(co(i)||!b._zod.def.when(i))continue}else if(d)continue;const _=i.issues.length,k=b._zod.check(i);if(k instanceof Promise&&l?.async===!1)throw new se;if(w||k instanceof Promise)w=(w??Promise.resolve()).then(async()=>{await k,i.issues.length!==_&&(d||(d=ue(i,_)))});else{if(i.issues.length===_)continue;d||(d=ue(i,_))}}return w?w.then(()=>i):i},s=(i,c,l)=>{if(ue(i))return i.aborted=!0,i;const d=o(c,r,l);if(d instanceof Promise){if(l.async===!1)throw new se;return d.then(w=>e._zod.parse(w,l))}return e._zod.parse(d,l)};e._zod.run=(i,c)=>{if(c.skipChecks)return e._zod.parse(i,c);if(c.direction==="backward"){const d=e._zod.parse({value:i.value,issues:[]},{...c,skipChecks:!0});return d instanceof Promise?d.then(w=>s(w,i,c)):s(d,i,c)}const l=e._zod.parse(i,c);if(l instanceof Promise){if(c.async===!1)throw new se;return l.then(d=>o(d,r,c))}return o(l,r,c)}}S(e,"~standard",()=>({validate:o=>{try{const s=fo(e,o);return s.success?{value:s.data}:{issues:s.error?.issues}}catch{return po(e,o).then(i=>i.success?{value:i.data}:{issues:i.error?.issues})}},vendor:"zod",version:1}))}),et=u("$ZodString",(e,t)=>{A.init(e,t),e._zod.pattern=[...e?._zod.bag?.patterns??[]].pop()??jo(e._zod.bag),e._zod.parse=(n,r)=>{if(t.coerce)try{n.value=String(n.value)}catch{}return typeof n.value=="string"||n.issues.push({expected:"string",code:"invalid_type",input:n.value,inst:e}),n}}),O=u("$ZodStringFormat",(e,t)=>{Te.init(e,t),et.init(e,t)}),ui=u("$ZodGUID",(e,t)=>{t.pattern??(t.pattern=Io),O.init(e,t)}),di=u("$ZodUUID",(e,t)=>{if(t.version){const r={v1:1,v2:2,v3:3,v4:4,v5:5,v6:6,v7:7,v8:8}[t.version];if(r===void 0)throw new Error(`Invalid UUID version: "${t.version}"`);t.pattern??(t.pattern=Jt(r))}else t.pattern??(t.pattern=Jt());O.init(e,t)}),fi=u("$ZodEmail",(e,t)=>{t.pattern??(t.pattern=To),O.init(e,t)}),pi=u("$ZodURL",(e,t)=>{O.init(e,t),e._zod.check=n=>{try{const r=n.value.trim();if(!t.normalize&&t.protocol?.source===Do.source&&!/^https?:\/\//i.test(r)){n.issues.push({code:"invalid_format",format:"url",note:"Invalid URL format",input:n.value,inst:e,continue:!t.abort});return}const o=new URL(r);t.hostname&&(t.hostname.lastIndex=0,t.hostname.test(o.hostname)||n.issues.push({code:"invalid_format",format:"url",note:"Invalid hostname",pattern:t.hostname.source,input:n.value,inst:e,continue:!t.abort})),t.protocol&&(t.protocol.lastIndex=0,t.protocol.test(o.protocol.endsWith(":")?o.protocol.slice(0,-1):o.protocol)||n.issues.push({code:"invalid_format",format:"url",note:"Invalid protocol",pattern:t.protocol.source,input:n.value,inst:e,continue:!t.abort})),t.normalize?n.value=o.href:n.value=r;return}catch{n.issues.push({code:"invalid_format",format:"url",input:n.value,inst:e,continue:!t.abort})}}}),mi=u("$ZodEmoji",(e,t)=>{t.pattern??(t.pattern=No()),O.init(e,t)}),hi=u("$ZodNanoID",(e,t)=>{t.pattern??(t.pattern=zo),O.init(e,t)}),gi=u("$ZodCUID",(e,t)=>{t.pattern??(t.pattern=_o),O.init(e,t)}),vi=u("$ZodCUID2",(e,t)=>{t.pattern??(t.pattern=xo),O.init(e,t)}),wi=u("$ZodULID",(e,t)=>{t.pattern??(t.pattern=So),O.init(e,t)}),yi=u("$ZodXID",(e,t)=>{t.pattern??(t.pattern=Eo),O.init(e,t)}),bi=u("$ZodKSUID",(e,t)=>{t.pattern??(t.pattern=Ao),O.init(e,t)}),ki=u("$ZodISODateTime",(e,t)=>{t.pattern??(t.pattern=qo(t)),O.init(e,t)}),_i=u("$ZodISODate",(e,t)=>{t.pattern??(t.pattern=Fo),O.init(e,t)}),xi=u("$ZodISOTime",(e,t)=>{t.pattern??(t.pattern=Lo(t)),O.init(e,t)}),Si=u("$ZodISODuration",(e,t)=>{t.pattern??(t.pattern=Oo),O.init(e,t)}),Ei=u("$ZodIPv4",(e,t)=>{t.pattern??(t.pattern=Co),O.init(e,t),e._zod.bag.format="ipv4"}),Ai=u("$ZodIPv6",(e,t)=>{t.pattern??(t.pattern=Ro),O.init(e,t),e._zod.bag.format="ipv6",e._zod.check=n=>{try{new URL(`http://[${n.value}]`)}catch{n.issues.push({code:"invalid_format",format:"ipv6",input:n.value,inst:e,continue:!t.abort})}}}),zi=u("$ZodCIDRv4",(e,t)=>{t.pattern??(t.pattern=Uo),O.init(e,t)}),Oi=u("$ZodCIDRv6",(e,t)=>{t.pattern??(t.pattern=Po),O.init(e,t),e._zod.check=n=>{const r=n.value.split("/");try{if(r.length!==2)throw new Error;const[o,s]=r;if(!s)throw new Error;const i=Number(s);if(`${i}`!==s)throw new Error;if(i<0||i>128)throw new Error;new URL(`http://[${o}]`)}catch{n.issues.push({code:"invalid_format",format:"cidrv6",input:n.value,inst:e,continue:!t.abort})}}});function en(e){if(e==="")return!0;if(/\s/.test(e)||e.length%4!==0)return!1;try{return atob(e),!0}catch{return!1}}const Ii=u("$ZodBase64",(e,t)=>{t.pattern??(t.pattern=Zo),O.init(e,t),e._zod.bag.contentEncoding="base64",e._zod.check=n=>{en(n.value)||n.issues.push({code:"invalid_format",format:"base64",input:n.value,inst:e,continue:!t.abort})}});function Ti(e){if(!Vt.test(e))return!1;const t=e.replace(/[-_]/g,r=>r==="-"?"+":"/"),n=t.padEnd(Math.ceil(t.length/4)*4,"=");return en(n)}const $i=u("$ZodBase64URL",(e,t)=>{t.pattern??(t.pattern=Vt),O.init(e,t),e._zod.bag.contentEncoding="base64url",e._zod.check=n=>{Ti(n.value)||n.issues.push({code:"invalid_format",format:"base64url",input:n.value,inst:e,continue:!t.abort})}}),Ni=u("$ZodE164",(e,t)=>{t.pattern??(t.pattern=Mo),O.init(e,t)});function Ci(e,t=null){try{const n=e.split(".");if(n.length!==3)return!1;const[r]=n;if(!r)return!1;const o=JSON.parse(atob(r));return!("typ"in o&&o?.typ!=="JWT"||!o.alg||t&&(!("alg"in o)||o.alg!==t))}catch{return!1}}const Ri=u("$ZodJWT",(e,t)=>{O.init(e,t),e._zod.check=n=>{Ci(n.value,t.alg)||n.issues.push({code:"invalid_format",format:"jwt",input:n.value,inst:e,continue:!t.abort})}}),tn=u("$ZodNumber",(e,t)=>{A.init(e,t),e._zod.pattern=e._zod.bag.pattern??Ht,e._zod.parse=(n,r)=>{if(t.coerce)try{n.value=Number(n.value)}catch{}const o=n.value;if(typeof o=="number"&&!Number.isNaN(o)&&Number.isFinite(o))return n;const s=typeof o=="number"?Number.isNaN(o)?"NaN":Number.isFinite(o)?void 0:"Infinity":void 0;return n.issues.push({expected:"number",code:"invalid_type",input:o,inst:e,...s?{received:s}:{}}),n}}),Ui=u("$ZodNumberFormat",(e,t)=>{Xo.init(e,t),tn.init(e,t)}),Pi=u("$ZodBoolean",(e,t)=>{A.init(e,t),e._zod.pattern=Wo,e._zod.parse=(n,r)=>{if(t.coerce)try{n.value=!!n.value}catch{}const o=n.value;return typeof o=="boolean"||n.issues.push({expected:"boolean",code:"invalid_type",input:o,inst:e}),n}}),Zi=u("$ZodUndefined",(e,t)=>{A.init(e,t),e._zod.pattern=Vo,e._zod.values=new Set([void 0]),e._zod.parse=(n,r)=>{const o=n.value;return typeof o>"u"||n.issues.push({expected:"undefined",code:"invalid_type",input:o,inst:e}),n}}),Di=u("$ZodNull",(e,t)=>{A.init(e,t),e._zod.pattern=Jo,e._zod.values=new Set([null]),e._zod.parse=(n,r)=>{const o=n.value;return o===null||n.issues.push({expected:"null",code:"invalid_type",input:o,inst:e}),n}}),Mi=u("$ZodUnknown",(e,t)=>{A.init(e,t),e._zod.parse=n=>n}),Fi=u("$ZodNever",(e,t)=>{A.init(e,t),e._zod.parse=(n,r)=>(n.issues.push({expected:"never",code:"invalid_type",input:n.value,inst:e}),n)});function nn(e,t,n){e.issues.length&&t.issues.push(...de(n,e.issues)),t.value[n]=e.value}const Li=u("$ZodArray",(e,t)=>{A.init(e,t),e._zod.parse=(n,r)=>{const o=n.value;if(!Array.isArray(o))return n.issues.push({expected:"array",code:"invalid_type",input:o,inst:e}),n;n.value=Array(o.length);const s=[];for(let i=0;i<o.length;i++){const c=o[i],l=t.element._zod.run({value:c,issues:[]},r);l instanceof Promise?s.push(l.then(d=>nn(d,n,i))):nn(l,n,i)}return s.length?Promise.all(s).then(()=>n):n}});function $e(e,t,n,r,o,s){const i=n in r;if(e.issues.length){if(o&&s&&!i)return;t.issues.push(...de(n,e.issues))}if(!i&&!o){e.issues.length||t.issues.push({code:"invalid_type",expected:"nonoptional",input:void 0,path:[n]});return}e.value===void 0?i&&(t.value[n]=void 0):t.value[n]=e.value}function rn(e){const t=Object.keys(e.shape);for(const r of t)if(!e.shape?.[r]?._zod?.traits?.has("$ZodType"))throw new Error(`Invalid element at key "${r}": expected a Zod schema`);const n=Qr(e.shape);return{...e,keys:t,keySet:new Set(t),numKeys:t.length,optionalKeys:new Set(n)}}function on(e,t,n,r,o,s){const i=[],c=o.keySet,l=o.catchall._zod,d=l.def.type,w=l.optin==="optional",b=l.optout==="optional";for(const _ in t){if(_==="__proto__"||c.has(_))continue;if(d==="never"){i.push(_);continue}const k=l.run({value:t[_],issues:[]},r);k instanceof Promise?e.push(k.then(E=>$e(E,n,_,t,w,b))):$e(k,n,_,t,w,b)}return i.length&&n.issues.push({code:"unrecognized_keys",keys:i,input:t,inst:s}),e.length?Promise.all(e).then(()=>n):n}const qi=u("$ZodObject",(e,t)=>{if(A.init(e,t),!Object.getOwnPropertyDescriptor(t,"shape")?.get){const c=t.shape;Object.defineProperty(t,"shape",{get:()=>{const l={...c};return Object.defineProperty(t,"shape",{value:l}),l}})}const r=Ae(()=>rn(t));S(e._zod,"propValues",()=>{const c=t.shape,l={};for(const d in c){const w=c[d]._zod;if(w.values){l[d]??(l[d]=new Set);for(const b of w.values)l[d].add(b)}}return l});const o=he,s=t.catchall;let i;e._zod.parse=(c,l)=>{i??(i=r.value);const d=c.value;if(!o(d))return c.issues.push({expected:"object",code:"invalid_type",input:d,inst:e}),c;c.value={};const w=[],b=i.shape;for(const _ of i.keys){const k=b[_],E=k._zod.optin==="optional",Ee=k._zod.optout==="optional",C=k._zod.run({value:d[_],issues:[]},l);C instanceof Promise?w.push(C.then(Ut=>$e(Ut,c,_,d,E,Ee))):$e(C,c,_,d,E,Ee)}return s?on(w,d,c,l,r.value,e):w.length?Promise.all(w).then(()=>c):c}}),ji=u("$ZodObjectJIT",(e,t)=>{qi.init(e,t);const n=e._zod.parse,r=Ae(()=>rn(t)),o=_=>{const k=new ci(["shape","payload","ctx"]),E=r.value,Ee=j=>{const $=Ft(j);return`shape[${$}]._zod.run({ value: input[${$}], issues: [] }, ctx)`};k.write("const input = payload.value;");const C=Object.create(null);let Ut=0;for(const j of E.keys)C[j]=`key_${Ut++}`;k.write("const newResult = {};");for(const j of E.keys){const $=C[j],R=Ft(j),Vr=_[j],Gr=Vr?._zod?.optin==="optional",Cd=Vr?._zod?.optout==="optional";k.write(`const ${$} = ${Ee(j)};`),Gr&&Cd?k.write(`
        if (${$}.issues.length) {
          if (${R} in input) {
            payload.issues = payload.issues.concat(${$}.issues.map(iss => ({
              ...iss,
              path: iss.path ? [${R}, ...iss.path] : [${R}]
            })));
          }
        }
        
        if (${$}.value === undefined) {
          if (${R} in input) {
            newResult[${R}] = undefined;
          }
        } else {
          newResult[${R}] = ${$}.value;
        }
        
      `):Gr?k.write(`
        if (${$}.issues.length) {
          payload.issues = payload.issues.concat(${$}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${R}, ...iss.path] : [${R}]
          })));
        }
        
        if (${$}.value === undefined) {
          if (${R} in input) {
            newResult[${R}] = undefined;
          }
        } else {
          newResult[${R}] = ${$}.value;
        }
        
      `):k.write(`
        const ${$}_present = ${R} in input;
        if (${$}.issues.length) {
          payload.issues = payload.issues.concat(${$}.issues.map(iss => ({
            ...iss,
            path: iss.path ? [${R}, ...iss.path] : [${R}]
          })));
        }
        if (!${$}_present && !${$}.issues.length) {
          payload.issues.push({
            code: "invalid_type",
            expected: "nonoptional",
            input: undefined,
            path: [${R}]
          });
        }

        if (${$}_present) {
          if (${$}.value === undefined) {
            newResult[${R}] = undefined;
          } else {
            newResult[${R}] = ${$}.value;
          }
        }

      `)}k.write("payload.value = newResult;"),k.write("return payload;");const Nd=k.compile();return(j,$)=>Nd(_,j,$)};let s;const i=he,c=!Ve.jitless,d=c&&Xr.value,w=t.catchall;let b;e._zod.parse=(_,k)=>{b??(b=r.value);const E=_.value;return i(E)?c&&d&&k?.async===!1&&k.jitless!==!0?(s||(s=o(t.shape)),_=s(_,k),w?on([],E,_,k,b,e):_):n(_,k):(_.issues.push({expected:"object",code:"invalid_type",input:E,inst:e}),_)}});function an(e,t,n,r){for(const s of e)if(s.issues.length===0)return t.value=s.value,t;const o=e.filter(s=>!ue(s));return o.length===1?(t.value=o[0].value,o[0]):(t.issues.push({code:"invalid_union",input:t.value,inst:n,errors:e.map(s=>s.issues.map(i=>W(i,r,B())))}),t)}const sn=u("$ZodUnion",(e,t)=>{A.init(e,t),S(e._zod,"optin",()=>t.options.some(r=>r._zod.optin==="optional")?"optional":void 0),S(e._zod,"optout",()=>t.options.some(r=>r._zod.optout==="optional")?"optional":void 0),S(e._zod,"values",()=>{if(t.options.every(r=>r._zod.values))return new Set(t.options.flatMap(r=>Array.from(r._zod.values)))}),S(e._zod,"pattern",()=>{if(t.options.every(r=>r._zod.pattern)){const r=t.options.map(o=>o._zod.pattern);return new RegExp(`^(${r.map(o=>He(o.source)).join("|")})$`)}});const n=t.options.length===1?t.options[0]._zod.run:null;e._zod.parse=(r,o)=>{if(n)return n(r,o);let s=!1;const i=[];for(const c of t.options){const l=c._zod.run({value:r.value,issues:[]},o);if(l instanceof Promise)i.push(l),s=!0;else{if(l.issues.length===0)return l;i.push(l)}}return s?Promise.all(i).then(c=>an(c,r,e,o)):an(i,r,e,o)}}),Bi=u("$ZodDiscriminatedUnion",(e,t)=>{t.inclusive=!1,sn.init(e,t);const n=e._zod.parse;S(e._zod,"propValues",()=>{const o={};for(const s of t.options){const i=s._zod.propValues;if(!i||Object.keys(i).length===0)throw new Error(`Invalid discriminated union option at index "${t.options.indexOf(s)}"`);for(const[c,l]of Object.entries(i)){o[c]||(o[c]=new Set);for(const d of l)o[c].add(d)}}return o});const r=Ae(()=>{const o=t.options,s=new Map;for(const i of o){const c=i._zod.propValues?.[t.discriminator];if(!c||c.size===0)throw new Error(`Invalid discriminated union option at index "${t.options.indexOf(i)}"`);for(const l of c){if(s.has(l))throw new Error(`Duplicate discriminator value "${String(l)}"`);s.set(l,i)}}return s});e._zod.parse=(o,s)=>{const i=o.value;if(!he(i))return o.issues.push({code:"invalid_type",expected:"object",input:i,inst:e}),o;const c=r.value.get(i?.[t.discriminator]);return c?c._zod.run(o,s):t.unionFallback||s.direction==="backward"?n(o,s):(o.issues.push({code:"invalid_union",errors:[],note:"No matching discriminator",discriminator:t.discriminator,options:Array.from(r.value.keys()),input:i,path:[t.discriminator],inst:e}),o)}}),Wi=u("$ZodIntersection",(e,t)=>{A.init(e,t),e._zod.parse=(n,r)=>{const o=n.value,s=t.left._zod.run({value:o,issues:[]},r),i=t.right._zod.run({value:o,issues:[]},r);return s instanceof Promise||i instanceof Promise?Promise.all([s,i]).then(([l,d])=>cn(n,l,d)):cn(n,s,i)}});function tt(e,t){if(e===t)return{valid:!0,data:e};if(e instanceof Date&&t instanceof Date&&+e==+t)return{valid:!0,data:e};if(ce(e)&&ce(t)){const n=Object.keys(t),r=Object.keys(e).filter(s=>n.indexOf(s)!==-1),o={...e,...t};for(const s of r){const i=tt(e[s],t[s]);if(!i.valid)return{valid:!1,mergeErrorPath:[s,...i.mergeErrorPath]};o[s]=i.data}return{valid:!0,data:o}}if(Array.isArray(e)&&Array.isArray(t)){if(e.length!==t.length)return{valid:!1,mergeErrorPath:[]};const n=[];for(let r=0;r<e.length;r++){const o=e[r],s=t[r],i=tt(o,s);if(!i.valid)return{valid:!1,mergeErrorPath:[r,...i.mergeErrorPath]};n.push(i.data)}return{valid:!0,data:n}}return{valid:!1,mergeErrorPath:[]}}function cn(e,t,n){const r=new Map;let o;for(const c of t.issues)if(c.code==="unrecognized_keys"){o??(o=c);for(const l of c.keys)r.has(l)||r.set(l,{}),r.get(l).l=!0}else e.issues.push(c);for(const c of n.issues)if(c.code==="unrecognized_keys")for(const l of c.keys)r.has(l)||r.set(l,{}),r.get(l).r=!0;else e.issues.push(c);const s=[...r].filter(([,c])=>c.l&&c.r).map(([c])=>c);if(s.length&&o&&e.issues.push({...o,keys:s}),ue(e))return e;const i=tt(t.value,n.value);if(!i.valid)throw new Error(`Unmergable intersection. Error path: ${JSON.stringify(i.mergeErrorPath)}`);return e.value=i.data,e}const Ji=u("$ZodRecord",(e,t)=>{A.init(e,t),e._zod.parse=(n,r)=>{const o=n.value;if(!ce(o))return n.issues.push({expected:"record",code:"invalid_type",input:o,inst:e}),n;const s=[],i=t.keyType._zod.values;if(i){n.value={};const c=new Set;for(const d of i)if(typeof d=="string"||typeof d=="number"||typeof d=="symbol"){c.add(typeof d=="number"?d.toString():d);const w=t.keyType._zod.run({value:d,issues:[]},r);if(w instanceof Promise)throw new Error("Async schemas not supported in object keys currently");if(w.issues.length){n.issues.push({code:"invalid_key",origin:"record",issues:w.issues.map(k=>W(k,r,B())),input:d,path:[d],inst:e});continue}const b=w.value,_=t.valueType._zod.run({value:o[d],issues:[]},r);_ instanceof Promise?s.push(_.then(k=>{k.issues.length&&n.issues.push(...de(d,k.issues)),n.value[b]=k.value})):(_.issues.length&&n.issues.push(...de(d,_.issues)),n.value[b]=_.value)}let l;for(const d in o)c.has(d)||(l=l??[],l.push(d));l&&l.length>0&&n.issues.push({code:"unrecognized_keys",input:o,inst:e,keys:l})}else{n.value={};for(const c of Reflect.ownKeys(o)){if(c==="__proto__"||!Object.prototype.propertyIsEnumerable.call(o,c))continue;let l=t.keyType._zod.run({value:c,issues:[]},r);if(l instanceof Promise)throw new Error("Async schemas not supported in object keys currently");if(typeof c=="string"&&Ht.test(c)&&l.issues.length){const b=t.keyType._zod.run({value:Number(c),issues:[]},r);if(b instanceof Promise)throw new Error("Async schemas not supported in object keys currently");b.issues.length===0&&(l=b)}if(l.issues.length){t.mode==="loose"?n.value[c]=o[c]:n.issues.push({code:"invalid_key",origin:"record",issues:l.issues.map(b=>W(b,r,B())),input:c,path:[c],inst:e});continue}const w=t.valueType._zod.run({value:o[c],issues:[]},r);w instanceof Promise?s.push(w.then(b=>{b.issues.length&&n.issues.push(...de(c,b.issues)),n.value[l.value]=b.value})):(w.issues.length&&n.issues.push(...de(c,w.issues)),n.value[l.value]=w.value)}}return s.length?Promise.all(s).then(()=>n):n}}),Vi=u("$ZodEnum",(e,t)=>{A.init(e,t);const n=Dt(t.entries),r=new Set(n);e._zod.values=r,e._zod.pattern=new RegExp(`^(${n.filter(o=>Yr.has(typeof o)).map(o=>typeof o=="string"?le(o):o.toString()).join("|")})$`),e._zod.parse=(o,s)=>{const i=o.value;return r.has(i)||o.issues.push({code:"invalid_value",values:n,input:i,inst:e}),o}}),Gi=u("$ZodLiteral",(e,t)=>{if(A.init(e,t),t.values.length===0)throw new Error("Cannot create literal schema with no valid values");const n=new Set(t.values);e._zod.values=n,e._zod.pattern=new RegExp(`^(${t.values.map(r=>typeof r=="string"?le(r):r?le(r.toString()):String(r)).join("|")})$`),e._zod.parse=(r,o)=>{const s=r.value;return n.has(s)||r.issues.push({code:"invalid_value",values:t.values,input:s,inst:e}),r}}),Ki=u("$ZodTransform",(e,t)=>{A.init(e,t),e._zod.optin="optional",e._zod.parse=(n,r)=>{if(r.direction==="backward")throw new Zt(e.constructor.name);const o=t.transform(n.value,n);if(r.async)return(o instanceof Promise?o:Promise.resolve(o)).then(i=>(n.value=i,n.fallback=!0,n));if(o instanceof Promise)throw new se;return n.value=o,n.fallback=!0,n}});function ln(e,t){return t===void 0&&(e.issues.length||e.fallback)?{issues:[],value:void 0}:e}const un=u("$ZodOptional",(e,t)=>{A.init(e,t),e._zod.optin="optional",e._zod.optout="optional",S(e._zod,"values",()=>t.innerType._zod.values?new Set([...t.innerType._zod.values,void 0]):void 0),S(e._zod,"pattern",()=>{const n=t.innerType._zod.pattern;return n?new RegExp(`^(${He(n.source)})?$`):void 0}),e._zod.parse=(n,r)=>{if(t.innerType._zod.optin==="optional"){const o=n.value,s=t.innerType._zod.run(n,r);return s instanceof Promise?s.then(i=>ln(i,o)):ln(s,o)}return n.value===void 0?n:t.innerType._zod.run(n,r)}}),Hi=u("$ZodExactOptional",(e,t)=>{un.init(e,t),S(e._zod,"values",()=>t.innerType._zod.values),S(e._zod,"pattern",()=>t.innerType._zod.pattern),e._zod.parse=(n,r)=>t.innerType._zod.run(n,r)}),Xi=u("$ZodNullable",(e,t)=>{A.init(e,t),S(e._zod,"optin",()=>t.innerType._zod.optin),S(e._zod,"optout",()=>t.innerType._zod.optout),S(e._zod,"pattern",()=>{const n=t.innerType._zod.pattern;return n?new RegExp(`^(${He(n.source)}|null)$`):void 0}),S(e._zod,"values",()=>t.innerType._zod.values?new Set([...t.innerType._zod.values,null]):void 0),e._zod.parse=(n,r)=>n.value===null?n:t.innerType._zod.run(n,r)}),Yi=u("$ZodDefault",(e,t)=>{A.init(e,t),e._zod.optin="optional",S(e._zod,"values",()=>t.innerType._zod.values),e._zod.parse=(n,r)=>{if(r.direction==="backward")return t.innerType._zod.run(n,r);if(n.value===void 0)return n.value=t.defaultValue,n;const o=t.innerType._zod.run(n,r);return o instanceof Promise?o.then(s=>dn(s,t)):dn(o,t)}});function dn(e,t){return e.value===void 0&&(e.value=t.defaultValue),e}const Qi=u("$ZodPrefault",(e,t)=>{A.init(e,t),e._zod.optin="optional",S(e._zod,"values",()=>t.innerType._zod.values),e._zod.parse=(n,r)=>(r.direction==="backward"||n.value===void 0&&(n.value=t.defaultValue),t.innerType._zod.run(n,r))}),ea=u("$ZodNonOptional",(e,t)=>{A.init(e,t),S(e._zod,"values",()=>{const n=t.innerType._zod.values;return n?new Set([...n].filter(r=>r!==void 0)):void 0}),e._zod.parse=(n,r)=>{const o=t.innerType._zod.run(n,r);return o instanceof Promise?o.then(s=>fn(s,e)):fn(o,e)}});function fn(e,t){return!e.issues.length&&e.value===void 0&&e.issues.push({code:"invalid_type",expected:"nonoptional",input:e.value,inst:t}),e}const ta=u("$ZodCatch",(e,t)=>{A.init(e,t),e._zod.optin="optional",S(e._zod,"optout",()=>t.innerType._zod.optout),S(e._zod,"values",()=>t.innerType._zod.values),e._zod.parse=(n,r)=>{if(r.direction==="backward")return t.innerType._zod.run(n,r);const o=t.innerType._zod.run(n,r);return o instanceof Promise?o.then(s=>(n.value=s.value,s.issues.length&&(n.value=t.catchValue({...n,error:{issues:s.issues.map(i=>W(i,r,B()))},input:n.value}),n.issues=[],n.fallback=!0),n)):(n.value=o.value,o.issues.length&&(n.value=t.catchValue({...n,error:{issues:o.issues.map(s=>W(s,r,B()))},input:n.value}),n.issues=[],n.fallback=!0),n)}}),na=u("$ZodPipe",(e,t)=>{A.init(e,t),S(e._zod,"values",()=>t.in._zod.values),S(e._zod,"optin",()=>t.in._zod.optin),S(e._zod,"optout",()=>t.out._zod.optout),S(e._zod,"propValues",()=>t.in._zod.propValues),e._zod.parse=(n,r)=>{if(r.direction==="backward"){const s=t.out._zod.run(n,r);return s instanceof Promise?s.then(i=>Ne(i,t.in,r)):Ne(s,t.in,r)}const o=t.in._zod.run(n,r);return o instanceof Promise?o.then(s=>Ne(s,t.out,r)):Ne(o,t.out,r)}});function Ne(e,t,n){return e.issues.length?(e.aborted=!0,e):t._zod.run({value:e.value,issues:e.issues,fallback:e.fallback},n)}const ra=u("$ZodReadonly",(e,t)=>{A.init(e,t),S(e._zod,"propValues",()=>t.innerType._zod.propValues),S(e._zod,"values",()=>t.innerType._zod.values),S(e._zod,"optin",()=>t.innerType?._zod?.optin),S(e._zod,"optout",()=>t.innerType?._zod?.optout),e._zod.parse=(n,r)=>{if(r.direction==="backward")return t.innerType._zod.run(n,r);const o=t.innerType._zod.run(n,r);return o instanceof Promise?o.then(pn):pn(o)}});function pn(e){return e.value=Object.freeze(e.value),e}const oa=u("$ZodLazy",(e,t)=>{A.init(e,t),S(e._zod,"innerType",()=>{const n=t;return n._cachedInner||(n._cachedInner=t.getter()),n._cachedInner}),S(e._zod,"pattern",()=>e._zod.innerType?._zod?.pattern),S(e._zod,"propValues",()=>e._zod.innerType?._zod?.propValues),S(e._zod,"optin",()=>e._zod.innerType?._zod?.optin??void 0),S(e._zod,"optout",()=>e._zod.innerType?._zod?.optout??void 0),e._zod.parse=(n,r)=>e._zod.innerType._zod.run(n,r)}),ia=u("$ZodCustom",(e,t)=>{Z.init(e,t),A.init(e,t),e._zod.parse=(n,r)=>n,e._zod.check=n=>{const r=n.value,o=t.fn(r);if(o instanceof Promise)return o.then(s=>mn(s,n,r,e));mn(o,n,r,e)}});function mn(e,t,n,r){if(!e){const o={code:"custom",input:n,inst:r,path:[...r._zod.def.path??[]],continue:!r._zod.def.abort};r._zod.def.params&&(o.params=r._zod.def.params),t.issues.push(ge(o))}}var hn;class aa{constructor(){this._map=new WeakMap,this._idmap=new Map}add(t,...n){const r=n[0];return this._map.set(t,r),r&&typeof r=="object"&&"id"in r&&this._idmap.set(r.id,t),this}clear(){return this._map=new WeakMap,this._idmap=new Map,this}remove(t){const n=this._map.get(t);return n&&typeof n=="object"&&"id"in n&&this._idmap.delete(n.id),this._map.delete(t),this}get(t){const n=t._zod.parent;if(n){const r={...this.get(n)??{}};delete r.id;const o={...r,...this._map.get(t)};return Object.keys(o).length?o:void 0}return this._map.get(t)}has(t){return this._map.has(t)}}function sa(){return new aa}(hn=globalThis).__zod_globalRegistry??(hn.__zod_globalRegistry=sa());const ve=globalThis.__zod_globalRegistry;function ca(e,t){return new e({type:"string",...y(t)})}function la(e,t){return new e({type:"string",format:"email",check:"string_format",abort:!1,...y(t)})}function gn(e,t){return new e({type:"string",format:"guid",check:"string_format",abort:!1,...y(t)})}function ua(e,t){return new e({type:"string",format:"uuid",check:"string_format",abort:!1,...y(t)})}function da(e,t){return new e({type:"string",format:"uuid",check:"string_format",abort:!1,version:"v4",...y(t)})}function fa(e,t){return new e({type:"string",format:"uuid",check:"string_format",abort:!1,version:"v6",...y(t)})}function pa(e,t){return new e({type:"string",format:"uuid",check:"string_format",abort:!1,version:"v7",...y(t)})}function ma(e,t){return new e({type:"string",format:"url",check:"string_format",abort:!1,...y(t)})}function ha(e,t){return new e({type:"string",format:"emoji",check:"string_format",abort:!1,...y(t)})}function ga(e,t){return new e({type:"string",format:"nanoid",check:"string_format",abort:!1,...y(t)})}function va(e,t){return new e({type:"string",format:"cuid",check:"string_format",abort:!1,...y(t)})}function wa(e,t){return new e({type:"string",format:"cuid2",check:"string_format",abort:!1,...y(t)})}function ya(e,t){return new e({type:"string",format:"ulid",check:"string_format",abort:!1,...y(t)})}function ba(e,t){return new e({type:"string",format:"xid",check:"string_format",abort:!1,...y(t)})}function ka(e,t){return new e({type:"string",format:"ksuid",check:"string_format",abort:!1,...y(t)})}function _a(e,t){return new e({type:"string",format:"ipv4",check:"string_format",abort:!1,...y(t)})}function xa(e,t){return new e({type:"string",format:"ipv6",check:"string_format",abort:!1,...y(t)})}function Sa(e,t){return new e({type:"string",format:"cidrv4",check:"string_format",abort:!1,...y(t)})}function Ea(e,t){return new e({type:"string",format:"cidrv6",check:"string_format",abort:!1,...y(t)})}function Aa(e,t){return new e({type:"string",format:"base64",check:"string_format",abort:!1,...y(t)})}function za(e,t){return new e({type:"string",format:"base64url",check:"string_format",abort:!1,...y(t)})}function Oa(e,t){return new e({type:"string",format:"e164",check:"string_format",abort:!1,...y(t)})}function Ia(e,t){return new e({type:"string",format:"jwt",check:"string_format",abort:!1,...y(t)})}function Ta(e,t){return new e({type:"string",format:"datetime",check:"string_format",offset:!1,local:!1,precision:null,...y(t)})}function $a(e,t){return new e({type:"string",format:"date",check:"string_format",...y(t)})}function Na(e,t){return new e({type:"string",format:"time",check:"string_format",precision:null,...y(t)})}function Ca(e,t){return new e({type:"string",format:"duration",check:"string_format",...y(t)})}function Ra(e,t){return new e({type:"number",checks:[],...y(t)})}function Ua(e,t){return new e({type:"number",check:"number_format",abort:!1,format:"safeint",...y(t)})}function Pa(e,t){return new e({type:"boolean",...y(t)})}function Za(e,t){return new e({type:"undefined",...y(t)})}function Da(e,t){return new e({type:"null",...y(t)})}function Ma(e){return new e({type:"unknown"})}function Fa(e,t){return new e({type:"never",...y(t)})}function vn(e,t){return new Yt({check:"less_than",...y(t),value:e,inclusive:!1})}function nt(e,t){return new Yt({check:"less_than",...y(t),value:e,inclusive:!0})}function wn(e,t){return new Qt({check:"greater_than",...y(t),value:e,inclusive:!1})}function rt(e,t){return new Qt({check:"greater_than",...y(t),value:e,inclusive:!0})}function yn(e,t){return new Ho({check:"multiple_of",...y(t),value:e})}function bn(e,t){return new Yo({check:"max_length",...y(t),maximum:e})}function Ce(e,t){return new Qo({check:"min_length",...y(t),minimum:e})}function kn(e,t){return new ei({check:"length_equals",...y(t),length:e})}function La(e,t){return new ti({check:"string_format",format:"regex",...y(t),pattern:e})}function qa(e){return new ni({check:"string_format",format:"lowercase",...y(e)})}function ja(e){return new ri({check:"string_format",format:"uppercase",...y(e)})}function Ba(e,t){return new oi({check:"string_format",format:"includes",...y(t),includes:e})}function Wa(e,t){return new ii({check:"string_format",format:"starts_with",...y(t),prefix:e})}function Ja(e,t){return new ai({check:"string_format",format:"ends_with",...y(t),suffix:e})}function fe(e){return new si({check:"overwrite",tx:e})}function Va(e){return fe(t=>t.normalize(e))}function Ga(){return fe(e=>e.trim())}function Ka(){return fe(e=>e.toLowerCase())}function Ha(){return fe(e=>e.toUpperCase())}function Xa(){return fe(e=>Hr(e))}function Ya(e,t,n){return new e({type:"array",element:t,...y(n)})}function Qa(e,t,n){return new e({type:"custom",check:"custom",fn:t,...y(n)})}function es(e,t){const n=ts(r=>(r.addIssue=o=>{if(typeof o=="string")r.issues.push(ge(o,r.value,n._zod.def));else{const s=o;s.fatal&&(s.continue=!1),s.code??(s.code="custom"),s.input??(s.input=r.value),s.inst??(s.inst=n),s.continue??(s.continue=!n._zod.def.abort),r.issues.push(ge(s))}},e(r.value,r)),t);return n}function ts(e,t){const n=new Z({check:"custom",...y(t)});return n._zod.check=e,n}function _n(e){let t=e?.target??"draft-2020-12";return t==="draft-4"&&(t="draft-04"),t==="draft-7"&&(t="draft-07"),{processors:e.processors??{},metadataRegistry:e?.metadata??ve,target:t,unrepresentable:e?.unrepresentable??"throw",override:e?.override??(()=>{}),io:e?.io??"output",counter:0,seen:new Map,cycles:e?.cycles??"ref",reused:e?.reused??"inline",external:e?.external??void 0}}function N(e,t,n={path:[],schemaPath:[]}){var r;const o=e._zod.def,s=t.seen.get(e);if(s)return s.count++,n.schemaPath.includes(e)&&(s.cycle=n.path),s.schema;const i={schema:{},count:1,cycle:void 0,path:n.path};t.seen.set(e,i);const c=e._zod.toJSONSchema?.();if(c)i.schema=c;else{const w={...n,schemaPath:[...n.schemaPath,e],path:n.path};if(e._zod.processJSONSchema)e._zod.processJSONSchema(t,i.schema,w);else{const _=i.schema,k=t.processors[o.type];if(!k)throw new Error(`[toJSONSchema]: Non-representable type encountered: ${o.type}`);k(e,t,_,w)}const b=e._zod.parent;b&&(i.ref||(i.ref=b),N(b,t,w),t.seen.get(b).isParent=!0)}const l=t.metadataRegistry.get(e);return l&&Object.assign(i.schema,l),t.io==="input"&&P(e)&&(delete i.schema.examples,delete i.schema.default),t.io==="input"&&"_prefault"in i.schema&&((r=i.schema).default??(r.default=i.schema._prefault)),delete i.schema._prefault,t.seen.get(e).schema}function xn(e,t){const n=e.seen.get(t);if(!n)throw new Error("Unprocessed schema. This is a bug in Zod.");const r=new Map;for(const i of e.seen.entries()){const c=e.metadataRegistry.get(i[0])?.id;if(c){const l=r.get(c);if(l&&l!==i[0])throw new Error(`Duplicate schema id "${c}" detected during JSON Schema conversion. Two different schemas cannot share the same id when converted together.`);r.set(c,i[0])}}const o=i=>{const c=e.target==="draft-2020-12"?"$defs":"definitions";if(e.external){const b=e.external.registry.get(i[0])?.id,_=e.external.uri??(E=>E);if(b)return{ref:_(b)};const k=i[1].defId??i[1].schema.id??`schema${e.counter++}`;return i[1].defId=k,{defId:k,ref:`${_("__shared")}#/${c}/${k}`}}if(i[1]===n)return{ref:"#"};const d=`#/${c}/`,w=i[1].schema.id??`__schema${e.counter++}`;return{defId:w,ref:d+w}},s=i=>{if(i[1].schema.$ref)return;const c=i[1],{ref:l,defId:d}=o(i);c.def={...c.schema},d&&(c.defId=d);const w=c.schema;for(const b in w)delete w[b];w.$ref=l};if(e.cycles==="throw")for(const i of e.seen.entries()){const c=i[1];if(c.cycle)throw new Error(`Cycle detected: #/${c.cycle?.join("/")}/<root>

Set the \`cycles\` parameter to \`"ref"\` to resolve cyclical schemas with defs.`)}for(const i of e.seen.entries()){const c=i[1];if(t===i[0]){s(i);continue}if(e.external){const d=e.external.registry.get(i[0])?.id;if(t!==i[0]&&d){s(i);continue}}if(e.metadataRegistry.get(i[0])?.id){s(i);continue}if(c.cycle){s(i);continue}if(c.count>1&&e.reused==="ref"){s(i);continue}}}function Sn(e,t){const n=e.seen.get(t);if(!n)throw new Error("Unprocessed schema. This is a bug in Zod.");const r=c=>{const l=e.seen.get(c);if(l.ref===null)return;const d=l.def??l.schema,w={...d},b=l.ref;if(l.ref=null,b){r(b);const k=e.seen.get(b),E=k.schema;if(E.$ref&&(e.target==="draft-07"||e.target==="draft-04"||e.target==="openapi-3.0")?(d.allOf=d.allOf??[],d.allOf.push(E)):Object.assign(d,E),Object.assign(d,w),c._zod.parent===b)for(const C in d)C==="$ref"||C==="allOf"||C in w||delete d[C];if(E.$ref&&k.def)for(const C in d)C==="$ref"||C==="allOf"||C in k.def&&JSON.stringify(d[C])===JSON.stringify(k.def[C])&&delete d[C]}const _=c._zod.parent;if(_&&_!==b){r(_);const k=e.seen.get(_);if(k?.schema.$ref&&(d.$ref=k.schema.$ref,k.def))for(const E in d)E==="$ref"||E==="allOf"||E in k.def&&JSON.stringify(d[E])===JSON.stringify(k.def[E])&&delete d[E]}e.override({zodSchema:c,jsonSchema:d,path:l.path??[]})};for(const c of[...e.seen.entries()].reverse())r(c[0]);const o={};if(e.target==="draft-2020-12"?o.$schema="https://json-schema.org/draft/2020-12/schema":e.target==="draft-07"?o.$schema="http://json-schema.org/draft-07/schema#":e.target==="draft-04"?o.$schema="http://json-schema.org/draft-04/schema#":e.target,e.external?.uri){const c=e.external.registry.get(t)?.id;if(!c)throw new Error("Schema is missing an `id` property");o.$id=e.external.uri(c)}Object.assign(o,n.def??n.schema);const s=e.metadataRegistry.get(t)?.id;s!==void 0&&o.id===s&&delete o.id;const i=e.external?.defs??{};for(const c of e.seen.entries()){const l=c[1];l.def&&l.defId&&(l.def.id===l.defId&&delete l.def.id,i[l.defId]=l.def)}e.external||Object.keys(i).length>0&&(e.target==="draft-2020-12"?o.$defs=i:o.definitions=i);try{const c=JSON.parse(JSON.stringify(o));return Object.defineProperty(c,"~standard",{value:{...t["~standard"],jsonSchema:{input:Re(t,"input",e.processors),output:Re(t,"output",e.processors)}},enumerable:!1,writable:!1}),c}catch{throw new Error("Error converting schema to JSON.")}}function P(e,t){const n=t??{seen:new Set};if(n.seen.has(e))return!1;n.seen.add(e);const r=e._zod.def;if(r.type==="transform")return!0;if(r.type==="array")return P(r.element,n);if(r.type==="set")return P(r.valueType,n);if(r.type==="lazy")return P(r.getter(),n);if(r.type==="promise"||r.type==="optional"||r.type==="nonoptional"||r.type==="nullable"||r.type==="readonly"||r.type==="default"||r.type==="prefault")return P(r.innerType,n);if(r.type==="intersection")return P(r.left,n)||P(r.right,n);if(r.type==="record"||r.type==="map")return P(r.keyType,n)||P(r.valueType,n);if(r.type==="pipe")return e._zod.traits.has("$ZodCodec")?!0:P(r.in,n)||P(r.out,n);if(r.type==="object"){for(const o in r.shape)if(P(r.shape[o],n))return!0;return!1}if(r.type==="union"){for(const o of r.options)if(P(o,n))return!0;return!1}if(r.type==="tuple"){for(const o of r.items)if(P(o,n))return!0;return!!(r.rest&&P(r.rest,n))}return!1}const ns=(e,t={})=>n=>{const r=_n({...n,processors:t});return N(e,r),xn(r,e),Sn(r,e)},Re=(e,t,n={})=>r=>{const{libraryOptions:o,target:s}=r??{},i=_n({...o??{},target:s,io:t,processors:n});return N(e,i),xn(i,e),Sn(i,e)},rs={guid:"uuid",url:"uri",datetime:"date-time",json_string:"json-string",regex:""},os=(e,t,n,r)=>{const o=n;o.type="string";const{minimum:s,maximum:i,format:c,patterns:l,contentEncoding:d}=e._zod.bag;if(typeof s=="number"&&(o.minLength=s),typeof i=="number"&&(o.maxLength=i),c&&(o.format=rs[c]??c,o.format===""&&delete o.format,c==="time"&&delete o.format),d&&(o.contentEncoding=d),l&&l.size>0){const w=[...l];w.length===1?o.pattern=w[0].source:w.length>1&&(o.allOf=[...w.map(b=>({...t.target==="draft-07"||t.target==="draft-04"||t.target==="openapi-3.0"?{type:"string"}:{},pattern:b.source}))])}},is=(e,t,n,r)=>{const o=n,{minimum:s,maximum:i,format:c,multipleOf:l,exclusiveMaximum:d,exclusiveMinimum:w}=e._zod.bag;typeof c=="string"&&c.includes("int")?o.type="integer":o.type="number";const b=typeof w=="number"&&w>=(s??Number.NEGATIVE_INFINITY),_=typeof d=="number"&&d<=(i??Number.POSITIVE_INFINITY),k=t.target==="draft-04"||t.target==="openapi-3.0";b?k?(o.minimum=w,o.exclusiveMinimum=!0):o.exclusiveMinimum=w:typeof s=="number"&&(o.minimum=s),_?k?(o.maximum=d,o.exclusiveMaximum=!0):o.exclusiveMaximum=d:typeof i=="number"&&(o.maximum=i),typeof l=="number"&&(o.multipleOf=l)},as=(e,t,n,r)=>{n.type="boolean"},ss=(e,t,n,r)=>{t.target==="openapi-3.0"?(n.type="string",n.nullable=!0,n.enum=[null]):n.type="null"},cs=(e,t,n,r)=>{if(t.unrepresentable==="throw")throw new Error("Undefined cannot be represented in JSON Schema")},ls=(e,t,n,r)=>{n.not={}},us=(e,t,n,r)=>{},ds=(e,t,n,r)=>{const o=e._zod.def,s=Dt(o.entries);s.every(i=>typeof i=="number")&&(n.type="number"),s.every(i=>typeof i=="string")&&(n.type="string"),n.enum=s},fs=(e,t,n,r)=>{const o=e._zod.def,s=[];for(const i of o.values)if(i===void 0){if(t.unrepresentable==="throw")throw new Error("Literal `undefined` cannot be represented in JSON Schema")}else if(typeof i=="bigint"){if(t.unrepresentable==="throw")throw new Error("BigInt literals cannot be represented in JSON Schema");s.push(Number(i))}else s.push(i);if(s.length!==0)if(s.length===1){const i=s[0];n.type=i===null?"null":typeof i,t.target==="draft-04"||t.target==="openapi-3.0"?n.enum=[i]:n.const=i}else s.every(i=>typeof i=="number")&&(n.type="number"),s.every(i=>typeof i=="string")&&(n.type="string"),s.every(i=>typeof i=="boolean")&&(n.type="boolean"),s.every(i=>i===null)&&(n.type="null"),n.enum=s},ps=(e,t,n,r)=>{if(t.unrepresentable==="throw")throw new Error("Custom types cannot be represented in JSON Schema")},ms=(e,t,n,r)=>{if(t.unrepresentable==="throw")throw new Error("Transforms cannot be represented in JSON Schema")},hs=(e,t,n,r)=>{const o=n,s=e._zod.def,{minimum:i,maximum:c}=e._zod.bag;typeof i=="number"&&(o.minItems=i),typeof c=="number"&&(o.maxItems=c),o.type="array",o.items=N(s.element,t,{...r,path:[...r.path,"items"]})},gs=(e,t,n,r)=>{const o=n,s=e._zod.def;o.type="object",o.properties={};const i=s.shape;for(const d in i)o.properties[d]=N(i[d],t,{...r,path:[...r.path,"properties",d]});const c=new Set(Object.keys(i)),l=new Set([...c].filter(d=>{const w=s.shape[d]._zod;return t.io==="input"?w.optin===void 0:w.optout===void 0}));l.size>0&&(o.required=Array.from(l)),s.catchall?._zod.def.type==="never"?o.additionalProperties=!1:s.catchall?s.catchall&&(o.additionalProperties=N(s.catchall,t,{...r,path:[...r.path,"additionalProperties"]})):t.io==="output"&&(o.additionalProperties=!1)},vs=(e,t,n,r)=>{const o=e._zod.def,s=o.inclusive===!1,i=o.options.map((c,l)=>N(c,t,{...r,path:[...r.path,s?"oneOf":"anyOf",l]}));s?n.oneOf=i:n.anyOf=i},ws=(e,t,n,r)=>{const o=e._zod.def,s=N(o.left,t,{...r,path:[...r.path,"allOf",0]}),i=N(o.right,t,{...r,path:[...r.path,"allOf",1]}),c=d=>"allOf"in d&&Object.keys(d).length===1,l=[...c(s)?s.allOf:[s],...c(i)?i.allOf:[i]];n.allOf=l},ys=(e,t,n,r)=>{const o=n,s=e._zod.def;o.type="object";const i=s.keyType,l=i._zod.bag?.patterns;if(s.mode==="loose"&&l&&l.size>0){const w=N(s.valueType,t,{...r,path:[...r.path,"patternProperties","*"]});o.patternProperties={};for(const b of l)o.patternProperties[b.source]=w}else(t.target==="draft-07"||t.target==="draft-2020-12")&&(o.propertyNames=N(s.keyType,t,{...r,path:[...r.path,"propertyNames"]})),o.additionalProperties=N(s.valueType,t,{...r,path:[...r.path,"additionalProperties"]});const d=i._zod.values;if(d){const w=[...d].filter(b=>typeof b=="string"||typeof b=="number");w.length>0&&(o.required=w)}},bs=(e,t,n,r)=>{const o=e._zod.def,s=N(o.innerType,t,r),i=t.seen.get(e);t.target==="openapi-3.0"?(i.ref=o.innerType,n.nullable=!0):n.anyOf=[s,{type:"null"}]},ks=(e,t,n,r)=>{const o=e._zod.def;N(o.innerType,t,r);const s=t.seen.get(e);s.ref=o.innerType},_s=(e,t,n,r)=>{const o=e._zod.def;N(o.innerType,t,r);const s=t.seen.get(e);s.ref=o.innerType,n.default=JSON.parse(JSON.stringify(o.defaultValue))},xs=(e,t,n,r)=>{const o=e._zod.def;N(o.innerType,t,r);const s=t.seen.get(e);s.ref=o.innerType,t.io==="input"&&(n._prefault=JSON.parse(JSON.stringify(o.defaultValue)))},Ss=(e,t,n,r)=>{const o=e._zod.def;N(o.innerType,t,r);const s=t.seen.get(e);s.ref=o.innerType;let i;try{i=o.catchValue(void 0)}catch{throw new Error("Dynamic catch values are not supported in JSON Schema")}n.default=i},Es=(e,t,n,r)=>{const o=e._zod.def,s=o.in._zod.traits.has("$ZodTransform"),i=t.io==="input"?s?o.out:o.in:o.out;N(i,t,r);const c=t.seen.get(e);c.ref=i},As=(e,t,n,r)=>{const o=e._zod.def;N(o.innerType,t,r);const s=t.seen.get(e);s.ref=o.innerType,n.readOnly=!0},En=(e,t,n,r)=>{const o=e._zod.def;N(o.innerType,t,r);const s=t.seen.get(e);s.ref=o.innerType},zs=(e,t,n,r)=>{const o=e._zod.innerType;N(o,t,r);const s=t.seen.get(e);s.ref=o},Os=u("ZodISODateTime",(e,t)=>{ki.init(e,t),I.init(e,t)});function Is(e){return Ta(Os,e)}const Ts=u("ZodISODate",(e,t)=>{_i.init(e,t),I.init(e,t)});function $s(e){return $a(Ts,e)}const Ns=u("ZodISOTime",(e,t)=>{xi.init(e,t),I.init(e,t)});function Cs(e){return Na(Ns,e)}const Rs=u("ZodISODuration",(e,t)=>{Si.init(e,t),I.init(e,t)});function Us(e){return Ca(Rs,e)}const M=u("ZodError",(e,t)=>{Bt.init(e,t),e.name="ZodError",Object.defineProperties(e,{format:{value:n=>uo(e,n)},flatten:{value:n=>lo(e,n)},addIssue:{value:n=>{e.issues.push(n),e.message=JSON.stringify(e.issues,Ge,2)}},addIssues:{value:n=>{e.issues.push(...n),e.message=JSON.stringify(e.issues,Ge,2)}},isEmpty:{get(){return e.issues.length===0}}})},{Parent:Error}),Ps=Ye(M),Zs=Qe(M),Ds=Oe(M),Ms=Ie(M),Fs=mo(M),Ls=ho(M),qs=go(M),js=vo(M),Bs=wo(M),Ws=yo(M),Js=bo(M),Vs=ko(M),An=new WeakMap;function we(e,t,n){const r=Object.getPrototypeOf(e);let o=An.get(r);if(o||(o=new Set,An.set(r,o)),!o.has(t)){o.add(t);for(const s in n){const i=n[s];Object.defineProperty(r,s,{configurable:!0,enumerable:!1,get(){const c=i.bind(this);return Object.defineProperty(this,s,{configurable:!0,writable:!0,enumerable:!0,value:c}),c},set(c){Object.defineProperty(this,s,{configurable:!0,writable:!0,enumerable:!0,value:c})}})}}}const z=u("ZodType",(e,t)=>(A.init(e,t),Object.assign(e["~standard"],{jsonSchema:{input:Re(e,"input"),output:Re(e,"output")}}),e.toJSONSchema=ns(e,{}),e.def=t,e.type=t.type,Object.defineProperty(e,"_def",{value:t}),e.parse=(n,r)=>Ps(e,n,r,{callee:e.parse}),e.safeParse=(n,r)=>Ds(e,n,r),e.parseAsync=async(n,r)=>Zs(e,n,r,{callee:e.parseAsync}),e.safeParseAsync=async(n,r)=>Ms(e,n,r),e.spa=e.safeParseAsync,e.encode=(n,r)=>Fs(e,n,r),e.decode=(n,r)=>Ls(e,n,r),e.encodeAsync=async(n,r)=>qs(e,n,r),e.decodeAsync=async(n,r)=>js(e,n,r),e.safeEncode=(n,r)=>Bs(e,n,r),e.safeDecode=(n,r)=>Ws(e,n,r),e.safeEncodeAsync=async(n,r)=>Js(e,n,r),e.safeDecodeAsync=async(n,r)=>Vs(e,n,r),we(e,"ZodType",{check(...n){const r=this.def;return this.clone(G(r,{checks:[...r.checks??[],...n.map(o=>typeof o=="function"?{_zod:{check:o,def:{check:"custom"},onattach:[]}}:o)]}),{parent:!0})},with(...n){return this.check(...n)},clone(n,r){return K(this,n,r)},brand(){return this},register(n,r){return n.add(this,r),this},refine(n,r){return this.check(Lc(n,r))},superRefine(n,r){return this.check(qc(n,r))},overwrite(n){return this.check(fe(n))},optional(){return Pn(this)},exactOptional(){return zc(this)},nullable(){return Zn(this)},nullish(){return Pn(Zn(this))},nonoptional(n){return Cc(this,n)},array(){return v(this)},or(n){return F([this,n])},and(n){return _c(this,n)},transform(n){return Mn(this,Ec(n))},default(n){return Tc(this,n)},prefault(n){return Nc(this,n)},catch(n){return Uc(this,n)},pipe(n){return Mn(this,n)},readonly(){return Dc(this)},describe(n){const r=this.clone();return ve.add(r,{description:n}),r},meta(...n){if(n.length===0)return ve.get(this);const r=this.clone();return ve.add(r,n[0]),r},isOptional(){return this.safeParse(void 0).success},isNullable(){return this.safeParse(null).success},apply(n){return n(this)}}),Object.defineProperty(e,"description",{get(){return ve.get(e)?.description},configurable:!0}),e)),zn=u("_ZodString",(e,t)=>{et.init(e,t),z.init(e,t),e._zod.processJSONSchema=(r,o,s)=>os(e,r,o);const n=e._zod.bag;e.format=n.format??null,e.minLength=n.minimum??null,e.maxLength=n.maximum??null,we(e,"_ZodString",{regex(...r){return this.check(La(...r))},includes(...r){return this.check(Ba(...r))},startsWith(...r){return this.check(Wa(...r))},endsWith(...r){return this.check(Ja(...r))},min(...r){return this.check(Ce(...r))},max(...r){return this.check(bn(...r))},length(...r){return this.check(kn(...r))},nonempty(...r){return this.check(Ce(1,...r))},lowercase(r){return this.check(qa(r))},uppercase(r){return this.check(ja(r))},trim(){return this.check(Ga())},normalize(...r){return this.check(Va(...r))},toLowerCase(){return this.check(Ka())},toUpperCase(){return this.check(Ha())},slugify(){return this.check(Xa())}})}),Gs=u("ZodString",(e,t)=>{et.init(e,t),zn.init(e,t),e.email=n=>e.check(la(Ks,n)),e.url=n=>e.check(ma(Hs,n)),e.jwt=n=>e.check(Ia(dc,n)),e.emoji=n=>e.check(ha(Xs,n)),e.guid=n=>e.check(gn(On,n)),e.uuid=n=>e.check(ua(Ue,n)),e.uuidv4=n=>e.check(da(Ue,n)),e.uuidv6=n=>e.check(fa(Ue,n)),e.uuidv7=n=>e.check(pa(Ue,n)),e.nanoid=n=>e.check(ga(Ys,n)),e.guid=n=>e.check(gn(On,n)),e.cuid=n=>e.check(va(Qs,n)),e.cuid2=n=>e.check(wa(ec,n)),e.ulid=n=>e.check(ya(tc,n)),e.base64=n=>e.check(Aa(cc,n)),e.base64url=n=>e.check(za(lc,n)),e.xid=n=>e.check(ba(nc,n)),e.ksuid=n=>e.check(ka(rc,n)),e.ipv4=n=>e.check(_a(oc,n)),e.ipv6=n=>e.check(xa(ic,n)),e.cidrv4=n=>e.check(Sa(ac,n)),e.cidrv6=n=>e.check(Ea(sc,n)),e.e164=n=>e.check(Oa(uc,n)),e.datetime=n=>e.check(Is(n)),e.date=n=>e.check($s(n)),e.time=n=>e.check(Cs(n)),e.duration=n=>e.check(Us(n))});function a(e){return ca(Gs,e)}const I=u("ZodStringFormat",(e,t)=>{O.init(e,t),zn.init(e,t)}),Ks=u("ZodEmail",(e,t)=>{fi.init(e,t),I.init(e,t)}),On=u("ZodGUID",(e,t)=>{ui.init(e,t),I.init(e,t)}),Ue=u("ZodUUID",(e,t)=>{di.init(e,t),I.init(e,t)}),Hs=u("ZodURL",(e,t)=>{pi.init(e,t),I.init(e,t)}),Xs=u("ZodEmoji",(e,t)=>{mi.init(e,t),I.init(e,t)}),Ys=u("ZodNanoID",(e,t)=>{hi.init(e,t),I.init(e,t)}),Qs=u("ZodCUID",(e,t)=>{gi.init(e,t),I.init(e,t)}),ec=u("ZodCUID2",(e,t)=>{vi.init(e,t),I.init(e,t)}),tc=u("ZodULID",(e,t)=>{wi.init(e,t),I.init(e,t)}),nc=u("ZodXID",(e,t)=>{yi.init(e,t),I.init(e,t)}),rc=u("ZodKSUID",(e,t)=>{bi.init(e,t),I.init(e,t)}),oc=u("ZodIPv4",(e,t)=>{Ei.init(e,t),I.init(e,t)}),ic=u("ZodIPv6",(e,t)=>{Ai.init(e,t),I.init(e,t)}),ac=u("ZodCIDRv4",(e,t)=>{zi.init(e,t),I.init(e,t)}),sc=u("ZodCIDRv6",(e,t)=>{Oi.init(e,t),I.init(e,t)}),cc=u("ZodBase64",(e,t)=>{Ii.init(e,t),I.init(e,t)}),lc=u("ZodBase64URL",(e,t)=>{$i.init(e,t),I.init(e,t)}),uc=u("ZodE164",(e,t)=>{Ni.init(e,t),I.init(e,t)}),dc=u("ZodJWT",(e,t)=>{Ri.init(e,t),I.init(e,t)}),In=u("ZodNumber",(e,t)=>{tn.init(e,t),z.init(e,t),e._zod.processJSONSchema=(r,o,s)=>is(e,r,o),we(e,"ZodNumber",{gt(r,o){return this.check(wn(r,o))},gte(r,o){return this.check(rt(r,o))},min(r,o){return this.check(rt(r,o))},lt(r,o){return this.check(vn(r,o))},lte(r,o){return this.check(nt(r,o))},max(r,o){return this.check(nt(r,o))},int(r){return this.check(Tn(r))},safe(r){return this.check(Tn(r))},positive(r){return this.check(wn(0,r))},nonnegative(r){return this.check(rt(0,r))},negative(r){return this.check(vn(0,r))},nonpositive(r){return this.check(nt(0,r))},multipleOf(r,o){return this.check(yn(r,o))},step(r,o){return this.check(yn(r,o))},finite(){return this}});const n=e._zod.bag;e.minValue=Math.max(n.minimum??Number.NEGATIVE_INFINITY,n.exclusiveMinimum??Number.NEGATIVE_INFINITY)??null,e.maxValue=Math.min(n.maximum??Number.POSITIVE_INFINITY,n.exclusiveMaximum??Number.POSITIVE_INFINITY)??null,e.isInt=(n.format??"").includes("int")||Number.isSafeInteger(n.multipleOf??.5),e.isFinite=!0,e.format=n.format??null});function f(e){return Ra(In,e)}const fc=u("ZodNumberFormat",(e,t)=>{Ui.init(e,t),In.init(e,t)});function Tn(e){return Ua(fc,e)}const pc=u("ZodBoolean",(e,t)=>{Pi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>as(e,n,r)});function x(e){return Pa(pc,e)}const mc=u("ZodUndefined",(e,t)=>{Zi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>cs(e,n)});function hc(e){return Za(mc,e)}const gc=u("ZodNull",(e,t)=>{Di.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>ss(e,n,r)});function Pe(e){return Da(gc,e)}const vc=u("ZodUnknown",(e,t)=>{Mi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>us()});function ee(){return Ma(vc)}const wc=u("ZodNever",(e,t)=>{Fi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>ls(e,n,r)});function $n(e){return Fa(wc,e)}const yc=u("ZodArray",(e,t)=>{Li.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>hs(e,n,r,o),e.element=t.element,we(e,"ZodArray",{min(n,r){return this.check(Ce(n,r))},nonempty(n){return this.check(Ce(1,n))},max(n,r){return this.check(bn(n,r))},length(n,r){return this.check(kn(n,r))},unwrap(){return this.element}})});function v(e,t){return Ya(yc,e,t)}const Nn=u("ZodObject",(e,t)=>{ji.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>gs(e,n,r,o),S(e,"shape",()=>t.shape),we(e,"ZodObject",{keyof(){return h(Object.keys(this._zod.def.shape))},catchall(n){return this.clone({...this._zod.def,catchall:n})},passthrough(){return this.clone({...this._zod.def,catchall:ee()})},loose(){return this.clone({...this._zod.def,catchall:ee()})},strict(){return this.clone({...this._zod.def,catchall:$n()})},strip(){return this.clone({...this._zod.def,catchall:void 0})},extend(n){return ro(this,n)},safeExtend(n){return oo(this,n)},merge(n){return io(this,n)},pick(n){return to(this,n)},omit(n){return no(this,n)},partial(...n){return ao(Un,this,n[0])},required(...n){return so(Dn,this,n[0])}})});function p(e,t){const n={type:"object",shape:e??{},...y(t)};return new Nn(n)}function g(e,t){return new Nn({type:"object",shape:e,catchall:$n(),...y(t)})}const Cn=u("ZodUnion",(e,t)=>{sn.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>vs(e,n,r,o),e.options=t.options});function F(e,t){return new Cn({type:"union",options:e,...y(t)})}const bc=u("ZodDiscriminatedUnion",(e,t)=>{Cn.init(e,t),Bi.init(e,t)});function T(e,t,n){return new bc({type:"union",options:t,discriminator:e,...y(n)})}const kc=u("ZodIntersection",(e,t)=>{Wi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>ws(e,n,r,o)});function _c(e,t){return new kc({type:"intersection",left:e,right:t})}const Rn=u("ZodRecord",(e,t)=>{Ji.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>ys(e,n,r,o),e.keyType=t.keyType,e.valueType=t.valueType});function L(e,t,n){return!t||!t._zod?new Rn({type:"record",keyType:a(),valueType:e,...y(t)}):new Rn({type:"record",keyType:e,valueType:t,...y(n)})}const ot=u("ZodEnum",(e,t)=>{Vi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(r,o,s)=>ds(e,r,o),e.enum=t.entries,e.options=Object.values(t.entries);const n=new Set(Object.keys(t.entries));e.extract=(r,o)=>{const s={};for(const i of r)if(n.has(i))s[i]=t.entries[i];else throw new Error(`Key ${i} not found in enum`);return new ot({...t,checks:[],...y(o),entries:s})},e.exclude=(r,o)=>{const s={...t.entries};for(const i of r)if(n.has(i))delete s[i];else throw new Error(`Key ${i} not found in enum`);return new ot({...t,checks:[],...y(o),entries:s})}});function h(e,t){const n=Array.isArray(e)?Object.fromEntries(e.map(r=>[r,r])):e;return new ot({type:"enum",entries:n,...y(t)})}const xc=u("ZodLiteral",(e,t)=>{Gi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>fs(e,n,r),e.values=new Set(t.values),Object.defineProperty(e,"value",{get(){if(t.values.length>1)throw new Error("This schema contains multiple valid literal values. Use `.values` instead.");return t.values[0]}})});function m(e,t){return new xc({type:"literal",values:Array.isArray(e)?e:[e],...y(t)})}const Sc=u("ZodTransform",(e,t)=>{Ki.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>ms(e,n),e._zod.parse=(n,r)=>{if(r.direction==="backward")throw new Zt(e.constructor.name);n.addIssue=s=>{if(typeof s=="string")n.issues.push(ge(s,n.value,t));else{const i=s;i.fatal&&(i.continue=!1),i.code??(i.code="custom"),i.input??(i.input=n.value),i.inst??(i.inst=e),n.issues.push(ge(i))}};const o=t.transform(n.value,n);return o instanceof Promise?o.then(s=>(n.value=s,n.fallback=!0,n)):(n.value=o,n.fallback=!0,n)}});function Ec(e){return new Sc({type:"transform",transform:e})}const Un=u("ZodOptional",(e,t)=>{un.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>En(e,n,r,o),e.unwrap=()=>e._zod.def.innerType});function Pn(e){return new Un({type:"optional",innerType:e})}const Ac=u("ZodExactOptional",(e,t)=>{Hi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>En(e,n,r,o),e.unwrap=()=>e._zod.def.innerType});function zc(e){return new Ac({type:"optional",innerType:e})}const Oc=u("ZodNullable",(e,t)=>{Xi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>bs(e,n,r,o),e.unwrap=()=>e._zod.def.innerType});function Zn(e){return new Oc({type:"nullable",innerType:e})}const Ic=u("ZodDefault",(e,t)=>{Yi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>_s(e,n,r,o),e.unwrap=()=>e._zod.def.innerType,e.removeDefault=e.unwrap});function Tc(e,t){return new Ic({type:"default",innerType:e,get defaultValue(){return typeof t=="function"?t():qt(t)}})}const $c=u("ZodPrefault",(e,t)=>{Qi.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>xs(e,n,r,o),e.unwrap=()=>e._zod.def.innerType});function Nc(e,t){return new $c({type:"prefault",innerType:e,get defaultValue(){return typeof t=="function"?t():qt(t)}})}const Dn=u("ZodNonOptional",(e,t)=>{ea.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>ks(e,n,r,o),e.unwrap=()=>e._zod.def.innerType});function Cc(e,t){return new Dn({type:"nonoptional",innerType:e,...y(t)})}const Rc=u("ZodCatch",(e,t)=>{ta.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>Ss(e,n,r,o),e.unwrap=()=>e._zod.def.innerType,e.removeCatch=e.unwrap});function Uc(e,t){return new Rc({type:"catch",innerType:e,catchValue:typeof t=="function"?t:()=>t})}const Pc=u("ZodPipe",(e,t)=>{na.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>Es(e,n,r,o),e.in=t.in,e.out=t.out});function Mn(e,t){return new Pc({type:"pipe",in:e,out:t})}const Zc=u("ZodReadonly",(e,t)=>{ra.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>As(e,n,r,o),e.unwrap=()=>e._zod.def.innerType});function Dc(e){return new Zc({type:"readonly",innerType:e})}const Mc=u("ZodLazy",(e,t)=>{oa.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>zs(e,n,r,o),e.unwrap=()=>e._zod.def.getter()});function Fn(e){return new Mc({type:"lazy",getter:e})}const Fc=u("ZodCustom",(e,t)=>{ia.init(e,t),z.init(e,t),e._zod.processJSONSchema=(n,r,o)=>ps(e,n)});function Lc(e,t={}){return Qa(Fc,e,t)}function qc(e,t){return es(e,t)}const Ze=["fm","inf"],Ln="inf",qn=p({id:a().min(1).max(64).regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),sharedId:a().min(1).max(64).optional(),target:a().min(1).max(200),title:a().min(1).max(200),consequence:a().min(1).max(500),instructions:v(a().min(1).max(2e3)).min(1).max(20),criterion:a().min(1).max(1e3),prerequisites:v(a().min(1).max(64)).max(50),completion:T("kind",[p({kind:m("manual"),label:a().min(1).max(64)}),p({kind:m("device-version"),deviceId:a().min(1).max(64),minVersion:a().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/)})])}),it=v(qn).max(20);p({requirements:v(p({source:a(),offer:a(),head:a().optional(),action:qn})),generation:f().int().positive(),state:h(["blocked","ready","deferred","confirmed","checked","cancelled"]),cardId:a(),presentedGeneration:f().int().nonnegative(),activatedAt:f(),completedAt:f().optional(),cancelledReason:a().optional()}),p({cardId:a(),state:h(["blocked","ready","deferred","confirmed","checked","cancelled"]),result:a()});const jc=h(["quick","standard","reviewed"]);h(["pass","findings","blocked"]),h(["low","medium","high"]),h(["error","warning","info"]),h(["auto-fix","ask-user","no-op"]);const jn=p({kind:m("settle"),mode:h(["merge","discard"]),confirm:m(!0).optional(),proceedWithOpen:m(!0).optional()}),Bn=p({kind:m("request_merge"),review:a().min(1).max(64)}),Wn=p({kind:m("request_write"),ask:a().min(1).max(64),integration:h(["always","once","deny"]).optional()}),Jn=h(["link","command","user-command"]),Vn=p({deviceId:a().min(1).max(64),providerId:a().min(1).max(256)}),Gn=p({deviceId:a().min(1).max(64),host:a().min(1).max(253)}),Kn=p({kind:m("open"),target:h(["settings","subscriptions","projects","devices","browser"]),savedSignIn:m(!0).optional(),signIn:a().min(1).max(253).optional(),make:Jn.optional(),remove:a().min(1).max(64).optional(),add:a().min(1).max(255).optional(),update:a().min(1).max(64).optional(),signInOn:Vn.optional(),forgeSignInOn:Gn.optional()}),Bc=["restore-account","move-flagship","retry-firstmate","try-again","add-plugin","decline-plugin","apply-project-change","decline-project-change","add-project","decline-project","continue-task","move-task","stop-task","start-task","ask-again","confirm-required-action","defer-required-action"];h(["start-task","start-again","stop-task","continue-task","drop-task","queue-task","unqueue-task","show-card"]),p({parts:v(a().min(1).max(64)).max(64),waiting:v(a().min(1).max(64)).max(64),underway:v(a().min(1).max(64)).max(64)}),g({panel:a().min(1).max(40)});const Wc=p({kind:m("host"),op:h(Bc),arg:a().optional()}),Hn=T("kind",[jn,Bn,Wn,Kn,Wc]);T("kind",[jn,Bn,Wn,Kn]);const at=h(["crewmate","firstmate","host"]),st=p({id:a(),label:a(),variant:h(["primary","secondary","ghost","danger"]).optional(),default:x().optional(),keepsOpen:x().optional(),effect:Hn.optional(),danger:x().optional(),care:jc.optional(),passes:m("checks").optional()}),Jc=g({id:a(),kind:h(["mp4","gif"]),width:f().int().positive(),height:f().int().positive(),durationMs:f().int().positive(),bytes:f().int().positive(),sha256:a().regex(/^[0-9a-f]{64}$/)}),Xn=g({sha256:a().regex(/^[0-9a-f]{64}$/).optional(),id:a(),alt:a(),width:f().int().positive(),height:f().int().positive(),group:f().int().nonnegative(),demo:Jc.optional()}),Yn=32,Qn=T("kind",[g({kind:m("browser"),label:a().min(1).max(Yn),taskId:a().min(1).max(64),session:a().min(1).max(64),generation:f().int().positive(),handoff:m(!0).optional()}),g({kind:m("page"),label:a().min(1).max(Yn),taskId:a().min(1).max(64),path:a().min(1).max(256)})]),te=g({level:h(["low","medium","high"]),why:a().min(1).max(100)}),Vc=g({blast:te,behavior:te,undo:te,evidence:te,sensitivity:te,novelty:te,deps:te}),ct=p({declared:Vc}),lt=h(["regular","wide","full"]),er=h(["answer","close-out"]),Gc=g({at:f(),added:f().int().nonnegative(),removed:f().int().nonnegative(),rewritten:x(),marks:v(f().int().nonnegative()).max(512)});h(["chrome","frame"]);const De=256,ut=256,tr=200,dt=16384;`${(64*1024).toLocaleString("en-US")}`;const nr=500,rr=g({name:a().min(1).max(tr),values:v(a().max(dt)).max(ut),labels:v(a().max(dt)).max(ut).optional(),changed:x(),json:m(!0).optional(),written:a().min(1).max(4e3).optional()}),pe=v(rr).max(De);g({answers:pe});const ft=500,Kc=64*1024,Hc=["single","multiple","text","opaque"],or=["no-prompt","conflicting-prompt","label-truncated","duplicate-values","mixed-controls","opaque"],Xc=g({value:a().max(dt),label:a().max(ft).nullable(),authoredDefault:x(),disabled:x(),hidden:x()}),Yc=g({name:a().min(1).max(tr),kind:h(Hc),control:h(["radio","checkbox","select","select-multiple","text","textarea","hidden","staged","mixed"]),prompt:a().max(ft).nullable(),promptBasis:h(["legend","labelledby","aria-label","label"]).nullable(),options:v(Xc).max(ut),defaultBasis:h(["authored","implicit-first","none"]),required:x(),gaps:v(h(or)).max(or.length),complete:x(),writeIn:m(!0).optional()}),pt=v(Yc).max(De),ir=h(["no-fresh-reading","too-large","invalid"]);g({id:a().min(8).max(64),lifecycleId:a().max(64).optional(),offerId:a().max(64).optional(),reading:h(["fresh","fallback","none"]).optional(),remounted:m(!0).optional(),questions:pt.optional(),questionsGap:ir.optional()}),g({id:a(),taskId:a().optional(),reviewTaskId:a().optional(),author:at,priority:f(),title:a(),meta:a(),model:a().optional(),place:a().optional(),body:a(),requiredActions:it.optional(),actions:v(st),status:h(["streaming","ready"]),createdAt:f(),pictures:v(Xn).optional(),width:lt.optional(),attachment:Qn.optional(),risk:ct.optional(),replies:m(!1).optional(),holdsPlace:m(!0).optional(),asking:m(!0).optional(),designOnly:m(!0).optional(),awaiting:er.optional(),minimized:m(!0).optional(),sentBackAt:f().int().nonnegative().optional(),lifecycleId:a().max(64).optional(),offerId:a().max(64).optional(),changes:Gc.optional()});const ar=h(["captain","crewmate","firstmate","host"]),mt=512,sr=g({id:f().int().nonnegative().max(mt+1),label:a().max(160),region:h(["body","title","buttons","whole","preview"]),start:f().int().nonnegative().optional()}),Qc=g({lifecycleId:a().min(1).max(64),offerId:a().min(1).max(64),previousOfferId:a().min(1).max(64),released:x(),targets:v(sr).max(mt+2),removed:f().int().nonnegative()}),el=g({offerId:a().min(1).max(64),targets:v(sr).max(mt+2)}),cr=g({revision:Qc.optional(),revisionShown:el.optional(),id:f(),cardId:a(),who:ar,text:a(),at:f(),answers:pe.optional()});g({cardId:a(),messages:v(cr)});const tl=["chose","dismissed","author-withdrawal","host-withdrawal","task-retired","duplicate","unknown"];g({id:a(),reviewTaskId:a().optional(),taskId:a().optional(),author:at,title:a(),meta:a(),model:a().optional(),body:a(),actions:v(st.omit({effect:!0})),width:lt.optional(),requiredActions:it.optional(),risk:ct.optional(),ending:g({how:h(tl),at:f(),actionId:a().optional(),label:a().optional(),by:h(["captain","firstmate","crewmate","host","frame"]).optional()}),answers:pe,messages:v(cr)}),g({mimeType:h(["image/png","image/jpeg","image/gif","image/webp"]),data:a().min(1).max(75e5),name:a().max(120).optional()}),p({kind:m("open"),target:h(["settings","subscriptions","projects","devices","browser"]),browser:p({taskId:a(),session:a(),generation:f().int().positive(),cardId:a()}).optional(),restoreAccountId:a().optional(),signIn:a().optional(),make:Jn.optional(),remove:a().optional(),add:a().optional(),update:a().optional(),signInOn:Vn.optional(),forgeSignInOn:Gn.optional()});const ht=g({fidelity:h(["matched","mismatched","legacy-missing","unavailable"]),reportedOfferId:a().max(64).optional(),reportedLifecycleId:a().max(64).optional()}),nl=g({at:f(),taskId:a(),key:a(),kind:a(),status:a(),activity:a().nullable(),parentId:a().nullable(),gate:g({kind:a(),ref:a().optional()}).nullable(),delivery:g({mode:a(),changeLabel:a().optional(),headSha:a().optional(),checks:a().optional(),checksAt:f().optional(),review:a().optional(),reviewSha:a().optional(),reviewedAt:f().optional(),settlePending:x()}).nullable(),blockers:v(g({id:a(),status:a()})),asks:v(a())}),lr=500;g({reviewTaskId:a().optional(),basis:h(["emitted","put","legacy-initial-snapshot"]),fingerprint:a(),author:at,title:a(),meta:a(),model:a().optional(),place:a().optional(),body:a(),requiredActions:it.optional(),actions:v(st),pictures:v(Xn).optional(),width:lt.optional(),attachment:Qn.optional(),risk:ct.optional(),asking:m(!0).optional(),designOnly:m(!0).optional(),holdsPlace:m(!0).optional()}),g({state:h(["available","waiting"]),waitingOn:er.optional(),cause:h(["emit","revise","put","close-out","reply","answered","restore"]),closeOut:h(["report","idle","turn-end","restart"]).optional(),replaces:a().optional(),lifecycle:h(["started","reopened","legacy-initial-snapshot"]).optional(),predecessor:a().optional()}),g({actionId:a(),recognized:x(),label:a().nullable(),closes:x(),keepsOpen:x(),effect:Hn.nullable(),frameValue:a().optional(),answers:pe.optional(),display:ht,reading:h(["fresh","fallback","none"]).optional(),remounted:m(!0).optional(),questions:pt.optional(),questionsGap:h(["absent","no-fresh-reading","too-large","invalid"]).optional(),context:nl.optional(),contextGap:h(["no-task","task-missing"]).optional(),interactionSource:h(["shell","host"])}),g({messageId:f().int(),who:ar,answers:pe.optional(),display:ht.optional()}),g({reason:h(["dismissed","author-withdrawal","host-withdrawal","task-retired","duplicate"]),note:a().max(lr).optional(),duplicateOf:a().optional(),display:ht.optional()}),g({interactionId:a(),outcome:h(["completed","refused","failed","queued"]),note:a().max(lr).optional()}),g({});const gt=200,D=a().min(1).max(64),vt=a().regex(/^[cf]-[a-z0-9]{6}$/),J=p({state:m("unavailable"),reason:a()}),V=p({id:a(),kind:h(["concept","finding"]),title:a(),retired:x()}),ne=h(["checked","unchecked","recheck","differing","superseded","retired"]),ur=p({recheck:x(),differing:x()}),rl=p({scope:D,name:a(),private:x(),concepts:f().int().nonnegative(),findings:f().int().nonnegative(),directions:f().int().nonnegative().optional()});T("state",[p({state:m("ready"),collections:v(rl)}),J]),g({scope:D,focus:vt.optional(),hops:F([m(1),m(2)]).optional(),query:a().max(gt).optional()});const ol=p({id:a(),title:a(),aliases:v(a()),findings:f().int().nonnegative(),degree:f().int().nonnegative()}),il=T("kind",[p({kind:m("claim"),id:a(),from:a(),to:a(),predicate:a(),finding:a(),standing:ne}),p({kind:m("context"),id:a(),from:a(),to:a(),reason:a()})]),dr=p({concepts:f().int().nonnegative(),connections:f().int().nonnegative()});T("state",[p({state:m("ready"),scope:D,focus:a().nullable(),concepts:v(ol),connections:v(il),shown:dr,total:dr}),J]),g({scope:D,query:a().max(gt).optional(),page:f().int().min(0).max(1e4).optional()});const al=p({id:a(),title:a(),aliases:v(a()),explanation:a(),findings:f().int().nonnegative()});T("state",[p({state:m("ready"),scope:D,rows:v(al),total:f().int().nonnegative(),page:f().int().nonnegative()}),J]);const sl=h(["all","recheck","differing"]);g({scope:D,query:a().max(gt).optional(),filter:sl.optional(),page:f().int().min(0).max(1e4).optional()});const fr=p({from:V,predicate:a(),to:V}),cl=p({id:a(),statement:a(),basis:h(["observation","inference"]),conditions:a(),about:v(V),relationship:fr.nullable(),standing:ne,attention:ur,sources:f().int().nonnegative(),checks:f().int().nonnegative()});T("state",[p({state:m("ready"),scope:D,rows:v(cl),total:f().int().nonnegative(),page:f().int().nonnegative()}),J]);const wt=p({id:a(),kind:m("direction"),text:a(),scope:D,scopeName:a(),origin:a(),authority:h(["instruction","advice"]),revision:f().int().positive(),updatedAt:f()});T("state",[p({state:m("ready"),scope:D,rows:v(wt),total:f().int().nonnegative(),page:f().int().nonnegative()}),J]),g({id:a().min(1).max(64),page:f().int().min(0).max(1e4).optional()});const ll=wt.extend({retired:x(),createdAt:f(),history:v(p({revision:f().int().positive(),op:h(["publish","revise","retire"]),text:a(),origin:a(),scope:D,evidence:a(),at:f()})),page:f().int().nonnegative(),total:f().int().nonnegative()});T("state",[p({state:m("ready"),direction:ll}),p({state:m("missing")}),J]);const yt=a().regex(/^(d:)?[a-z0-9][a-z0-9-]{0,63}$/),pr=a().min(1).max(4e3),bt=a().min(1).max(400),mr=f().int().positive().optional();T("op",[g({op:m("add"),id:yt.optional(),text:pr,scope:D.optional(),reason:bt}),g({op:m("revise"),id:yt,text:pr,expectedRevision:mr,reason:bt}),g({op:m("retire"),id:yt,expectedRevision:mr,reason:bt})]),p({op:h(["add","revise","retire"]),direction:wt}),g({id:vt,revision:f().int().positive().optional()});const ul=T("kind",[p({kind:m("file"),path:a(),startLine:f().int(),endLine:f().int(),commit:a().nullable(),dirty:x()}),p({kind:m("report"),key:a(),event:f().int()}),p({kind:m("quote"),citation:a()}),p({kind:m("article"),url:a(),title:a(),author:a().nullable(),published:a().nullable(),retrieved:f()})]),hr=p({id:a(),origin:ul,text:a(),capturedAt:f(),check:p({state:h(["unchanged","changed","missing","unknown","kept"]),detail:a()})}),dl=p({id:a(),revision:f().int().positive(),verdict:h(["supports","contradicts","inconclusive"]),method:a(),conditions:a(),by:a(),at:f(),sources:v(hr)}),fl=p({revision:f().int().positive(),op:h(["publish","revise","link","retire","restore"]),by:a(),reason:a(),at:f(),title:a()}),pl=p({type:h(["contradicts","supersedes","duplicates"]),reason:a(),other:V,outgoing:x(),by:a(),at:f()}),ml=p({revision:f().int().positive(),by:a(),task:a().nullable(),purpose:a(),at:f()}),hl=T("kind",[p({kind:m("claim"),id:a(),finding:a(),from:V,predicate:a(),to:V,standing:ne}),p({kind:m("context"),id:a(),from:V,to:V,reason:a()})]),gl=p({id:a(),scope:D,kind:h(["concept","finding"]),revision:f().int().positive(),current:f().int().positive(),retired:x(),title:a(),aliases:v(a()),explanation:a(),basis:h(["observation","inference"]).nullable(),conditions:a(),about:v(V),relationship:fr.nullable(),standing:ne.nullable(),attention:ur.nullable(),author:a(),createdAt:f(),at:f(),connections:v(hl),findings:v(p({id:a(),statement:a(),standing:ne})),findingsTotal:f().int().nonnegative(),sources:v(hr),checks:v(dl),revisions:v(fl),olderRevisions:f().int().nonnegative(),relations:v(pl),uses:p({count:f().int().nonnegative(),recent:v(ml)})});T("state",[p({state:m("ready"),entry:gl}),p({state:m("missing")}),J]);const vl="(?<![A-Za-z0-9_-])[cf]-[a-z0-9]{6}(?![A-Za-z0-9_-])",wl=/^[cf]-[a-z0-9]{6}$/;g({ids:v(vt).min(1).max(32)});const yl=p({id:a(),kind:h(["concept","finding"]),scope:D,title:a(),revision:f().int().positive(),retired:x(),standing:ne.nullable()});T("state",[p({state:m("ready"),refs:v(yl)}),J]),g({task:a().min(1).max(64)});const bl=p({id:a(),kind:h(["concept","finding"]),scope:D,revision:f().int().positive(),title:a(),current:f().int().positive(),currentTitle:a(),retired:x(),standing:ne.nullable(),purpose:a(),at:f()});T("state",[p({state:m("ready"),uses:v(bl),total:f().int().nonnegative()}),J]);const kl="(?<![A-Za-z0-9_-])[A-Z0-9]{2,4}-[0-9]{1,9}(?![A-Za-z0-9_-])",_l=/^[A-Z0-9]{2,4}-[0-9]{1,9}$/,gr=["v_version_v1","v_tasks_v1","v_task_events_v1","v_usage_v1","v_feed_v1","v_quota_windows_v1","v_routing_v1","v_placements_v1","v_projects_v1","v_repos_v1"],xl=/^v_[a-z][a-z0-9_]*_v[1-9][0-9]*$/,ye=a().regex(xl,{message:"a versioned view name, such as v_usage_v1"}),Me={textBytes:4096,params:32,paramBytes:4096};function vr(e){return new TextEncoder().encode(e).byteLength}const wr=F([a().refine(e=>vr(e)<=Me.paramBytes,"a param is at most 4 KB"),f().finite(),Pe()]),yr=a().min(1).refine(e=>vr(e)<=Me.textBytes,"a query is at most 4 KB");g({sql:yr,params:v(wr).max(Me.params).optional()}),g({sql:yr,params:v(wr).max(Me.params).optional(),views:v(ye).max(64)});const Sl=["sql_view_not_declared","sql_not_readonly","sql_invalid","sql_timeout","sql_too_large"],El=F([a(),f(),Pe()]),Al=p({columns:v(a()),rows:v(L(a(),El)),truncated:x(),elapsedMs:f()}),zl=p({refused:h(Sl),message:a()});F([zl,Al]);const Fe={"commands.search":{label:"Search commands",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[{key:"k",meta:!0}]},"focus.main-message":{label:"Go to the main message",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[{key:"l",meta:!0}]},"focus.card-reply":{label:"Go to the card's reply",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[{key:"l",meta:!0,shift:!0}],searchWords:["anything to add","comment"]},"focus.card-body":{label:"Go to the card's body",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[]},"focus.card-actions":{label:"Go to the card's buttons",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[]},"cards.choice-1":{label:"Press the recommended choice",scope:"window",runs:"shell",repeat:!1,risk:"close",keys:[{key:"1",meta:!0}],searchWords:["card","button","default","first"]},"cards.choice-2":{label:"Press the second choice",scope:"window",runs:"shell",repeat:!1,risk:"close",keys:[{key:"2",meta:!0}],searchWords:["card","button"]},"cards.choice-3":{label:"Press the third choice",scope:"window",runs:"shell",repeat:!1,risk:"close",keys:[{key:"3",meta:!0}],searchWords:["card","button"]},"cards.choice-4":{label:"Press the fourth choice",scope:"window",runs:"shell",repeat:!1,risk:"close",keys:[{key:"4",meta:!0}],searchWords:["card","button"]},"regions.next":{label:"Go to the next part of the window",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[{key:"F6"}]},"regions.previous":{label:"Go to the previous part of the window",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[{key:"F6",shift:!0}]},"computers.previous":{label:"Previous work computers",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[]},"computers.next":{label:"Next work computers",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[]},"project-focus.open":{label:"Focus on a project",scope:"window",runs:"shell",repeat:!1,risk:"view",keys:[{key:"p",meta:!0,shift:!0}],searchWords:["filter","project","pill"]},"project-focus.clear":{label:"Show all projects",scope:"window",runs:"shell",repeat:!1,risk:"view",keys:[],searchWords:["filter","focus","project","clear"]},"cards.previous":{label:"Show the previous card",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[{key:"[",meta:!0,shift:!0},{key:"{",meta:!0,shift:!0}]},"cards.next":{label:"Show the next card",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[{key:"]",meta:!0,shift:!0},{key:"}",meta:!0,shift:!0}]},"cards.close":{label:"Close the shown card",scope:"window",runs:"shell",repeat:!1,risk:"close",keys:[]},"cards.minimize":{label:"Put card aside",scope:"window",runs:"shell",repeat:!1,risk:"view",keys:[{key:"m",meta:!0,shift:!0}]},"cards.maximize":{label:"Maximize or restore card",scope:"window",runs:"shell",repeat:!1,risk:"view",keys:[],searchWords:["full","screen","enlarge","expand","bigger"]},"cards.next-revision":{label:"Go to the next revised area",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["changes","revision","links"]},"cards.thread":{label:"Show or hide the card's thread",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[{key:"\\",meta:!0}],searchWords:["collapse","expand","chat","replies","messages"]},"cards.show-info":{label:"Show Info",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["task","record","tab","open"]},"cards.show-crewmate":{label:"Show Crewmate",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["task","session","transcript","tab"]},"browser.control":{label:"Take or return browser control",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["handback","take","return","browser"]},"cards.show-browser":{label:"Show Browser",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["task","page","tab"]},"cards.next-tab":{label:"Next tab",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["task","tab"]},"cards.previous-tab":{label:"Previous tab",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["task","tab"]},"settings.open":{label:"Open Settings",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[{key:",",meta:!0}]},"settings.keyboard":{label:"Open Keyboard settings",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[]},"whats-new.show":{label:"Show what's new",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["release","notes","changes","version"]},"firstmate.reply":{label:"Open the first mate's reply",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["answer","message","note","last"]},"settings.usage":{label:"Open Usage",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["tokens","models","cost","dollars"]},"settings.automation":{label:"Open Automation",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["schedule","scheduled","recurring","reminder","pause"]},"settings.integrations":{label:"Open Integrations",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["github","connection","connect","sign in"]},"automation.pause-all":{label:"Pause all automations",scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["schedule","scheduled","recurring","stop"]},"usage.unit":{label:"Switch Usage units",scope:"window",runs:"shell",repeat:!1,risk:"view",keys:[],searchWords:["tokens","cost","dollars","estimate"]},"allowance.recheck":{label:"Recheck allowance",scope:"window",runs:"shell",repeat:!1,risk:"view",keys:[],searchWords:["quota","refresh","usage","limit","account","switch"]},"devices.try-again":{label:`Try again to reach your ${{many:"computers"}.many}`,scope:"window",runs:"shell",repeat:!1,risk:"navigate",keys:[],searchWords:["devices","ssh","reconnect","connect","macs"],section:"devices"},"size.larger":{label:"Make everything larger",scope:"window",runs:"main",repeat:!0,risk:"view",keys:[{key:"+",meta:!0},{key:"=",meta:!0},{key:"+",ctrl:!0},{key:"=",ctrl:!0}]},"size.smaller":{label:"Make everything smaller",scope:"window",runs:"main",repeat:!0,risk:"view",keys:[{key:"-",meta:!0},{key:"-",ctrl:!0}]},"size.reset":{label:"Return to the usual size",scope:"window",runs:"main",repeat:!0,risk:"view",keys:[{key:"0",meta:!0},{key:"0",ctrl:!0}]},"message.delete-to-line-start":{label:"Delete back to the start of the line",scope:"message-field",repeat:!0,risk:"edit",keys:[{key:"u",ctrl:!0}]},"message.delete-to-line-end":{label:"Delete to the end of the line",scope:"message-field",repeat:!0,risk:"edit",keys:[{key:"k",ctrl:!0}]},"message.delete-word-before":{label:"Delete the word before the cursor",scope:"message-field",repeat:!0,risk:"edit",keys:[{key:"w",ctrl:!0}]},"message.put-back-deleted":{label:"Put back what was last deleted",scope:"message-field",repeat:!0,risk:"edit",keys:[{key:"y",ctrl:!0}]},"message.recall":{label:"Bring back the last message sent",scope:"main-message",repeat:!1,risk:"edit",keys:[{key:"ArrowUp"},{key:"p",ctrl:!0}]}};function Ol(e){return Fe[e].scope==="window"}function br(e){return Fe[e].runs==="shell"}const kt=Object.keys(Fe);kt.filter(br),kt.filter(e=>Ol(e)&&!br(e));function kr(e,t){return t==="mac"||!e.meta&&!e.ctrl?e:e.ctrl?null:{key:e.key,ctrl:!0,...e.alt?{alt:!0}:{},...e.shift?{shift:!0}:{}}}function Il(e,t){if(t==="mac")return e;const n=[];for(const r of e){const o=kr(r,t),s=r.second?kr(r.second,t):void 0;if(!o||s===null)continue;const i=s?{...o,second:s}:o;n.some(c=>JSON.stringify(c)===JSON.stringify(i))||n.push(i)}return n}function Tl(e,t="mac"){return Il(Fe[e].keys,t)}function $l(e){return Object.fromEntries(kt.map(t=>[t,Tl(t,e)]))}$l("mac");const _r=h(["regular","wide","full"]),xr=h(["content","fill"]),Nl=h(["open","search","add","list","note","filter","clock","chart"]),Cl=3,Rl=16,Le=16,Sr=3072,Er=4096,be=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,H=a().min(1).max(32).regex(be,"kebab-case"),Ul=/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/,Ar=a().regex(Ul,"a plain id"),zr=a().min(1).max(80),qe=Fn(()=>F([Pe(),x(),f().finite(),a(),v(qe),L(a(),qe)])),je=qe.refine(e=>JSON.stringify(e).length<=Sr,`a card's data is at most ${Sr} bytes of JSON`);qe.refine(e=>new TextEncoder().encode(JSON.stringify(e)).byteLength<=Er,`a card keeps at most ${Er} bytes of JSON`);const Pl=g({view:H,title:zr,width:_r.optional(),height:xr.optional(),data:je.optional()}),Zl=g({id:H,icon:Nl,label:a().min(1).max(40),emits:H.optional(),data:je.optional()}),Dl=g({id:H,label:a().min(1).max(60),emits:H.optional(),presses:H.optional(),data:je.optional(),key:a().min(1).max(12).refine(e=>Fl(e)!==null,"a key as a Mac writes it, such as ⌘B").optional(),words:v(a().min(1).max(24).regex(/^\S+$/,"one word")).max(8).optional()}).refine(e=>e.emits===void 0!=(e.presses===void 0),"a command either emits a card or presses a header button");g({id:Ar.optional(),view:H,title:zr,width:_r.optional(),height:xr.optional(),data:je.optional()});const _t=L(H,Pl).refine(e=>Object.keys(e).length<=Le,`at most ${Le} named cards`),xt=v(Zl).max(Cl),St=v(Dl).max(Rl),Ml={"⌃":"ctrl","⌥":"alt","⇧":"shift","⌘":"meta"};function Fl(e){const t={key:""};let n=e;for(;n.length>0;){const r=Ml[n[0]];if(!r)break;if(t[r])return null;t[r]=!0,n=n.slice(1)}return/^F([1-9]|1[0-9]|2[0-4])$/.test(n)?{...t,key:n}:[...n].length!==1||/\s/.test(n)?null:{...t,key:/^[A-Za-z]$/.test(n)?n.toLowerCase():n}}const Et=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,Ll=a().min(2).max(64).regex(Et,"kebab-case id"),At=a().min(1).max(64).regex(Et,"kebab-case id"),ql=/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,jl=h(["decision","note","attention","record"]),Bl=g({kind:At,chrome:jl,body:g({streaming:h(["plain","html"])})}),Wl=g({id:At,label:a().min(1).max(24),order:f().int().min(0).max(1e3),width:h(["standard","wide"]).default("wide")}),Jl=h(["left","right"]),Vl=h(["top","bottom"]),Gl=g({x:Jl,y:Vl}),Kl=h(["content","fill"]),Hl=g({id:At,title:a().min(1).max(40),preferredPlacement:Gl,order:f().int().min(0).max(1e3),size:Kl.default("content"),newestLast:x().default(!1),cardViews:v(a().regex(be)).max(Le).optional(),cards:_t.optional(),header:xt.optional(),commands:St.optional()});function zt(e,t,n,r){const o=new Set;for(const s of e){const i=t(s);o.has(i)&&n.addIssue({code:"custom",message:`duplicate ${r} id "${i}"`}),o.add(i)}}const Xl=g({cardKinds:v(Bl).default([]).superRefine((e,t)=>zt(e,n=>n.kind,t,"card-kind")),settingsSections:v(Wl).default([]).superRefine((e,t)=>zt(e,n=>n.id,t,"settings-section")),sidePanels:v(Hl).default([]).superRefine((e,t)=>zt(e,n=>n.id,t,"side-panel"))}),ke=["GET","HEAD","POST","PUT","PATCH","DELETE"],Yl=["GET","HEAD"],Ql={responseMaxBytes:1048576},Or=1048576,eu=/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+(?:[a-z](?:[a-z0-9-]{0,61}[a-z0-9])?)$/;function tu(e){const t=e.toLowerCase().replace(/^\[|\]$/g,"");if(t==="localhost"||t.endsWith(".localhost")||t.endsWith(".local")||t==="::1"||t==="::"||t.startsWith("fe80:")||/^f[cd][0-9a-f]{2}:/.test(t))return!0;const n=t.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);if(!n)return!1;const[r,o]=[Number(n[1]),Number(n[2])];return r===0||r===10||r===127||r===169&&o===254||r===172&&o>=16&&o<=31||r===192&&o===168}function Ir(e){let t;try{t=new URL(e)}catch{return!1}if(t.protocol!=="https:"||t.origin!==e||t.username||t.password)return!1;const n=t.hostname;if(n.includes("*")||tu(n))return!1;const r=/^\d{1,3}(?:\.\d{1,3}){3}$/.test(n),o=n.startsWith("[");return r||o||eu.test(n)}const nu=a().max(267).refine(Ir,"an exact https origin (no path, wildcard, or private host)"),Tr=v(h(ke)).min(1).max(ke.length).default([...Yl]).superRefine((e,t)=>{new Set(e).size!==e.length&&t.addIssue({code:"custom",message:"duplicate method"})}),$r=a().min(1).max(32).regex(Et,"kebab-case alias"),ru=F([g({origin:nu,methods:Tr}),g({userSupplied:m(!0),methods:Tr})]),ou=g({kind:h(["bearer","basic","header"]),label:a().min(1).max(80),header:a().min(1).max(64).regex(/^[A-Za-z0-9-]+$/).optional()}),iu=a().min(1).max(64).regex(/^[a-z][a-z0-9-]*(?:\.[a-z][a-z0-9-]*)*$/,"dotted read-catalog name"),au=g({net:g({origins:L($r,ru).superRefine((e,t)=>{Object.values(e).filter(r=>"userSupplied"in r).length>1&&t.addIssue({code:"custom",message:"at most one alias may be userSupplied"})})}).optional(),secrets:L($r,ou).superRefine((e,t)=>{for(const[n,r]of Object.entries(e))r.kind==="header"&&!r.header&&t.addIssue({code:"custom",message:`secret "${n}" of kind header names no header`}),r.kind!=="header"&&r.header&&t.addIssue({code:"custom",message:`secret "${n}" sets header for kind ${r.kind}`})}).optional(),storage:g({kv:g({maxBytes:f().int().positive().max(Or)})}).optional(),reads:v(iu).max(64).optional(),sql:v(ye).max(gr.length).optional(),moves:m(!0).optional()});g({id:Ll,name:a().min(1).max(40),version:a().regex(ql,"semver"),contributes:Xl,capabilities:au});const su=/^[A-Za-z0-9-]{1,64}$/,cu=["authorization","cookie","host","origin","proxy-authorization","referer","user-agent"],Nr=g({method:h(ke).default("GET"),path:a().min(1).max(2048).regex(/^\/(?![/\\])/,"an absolute path"),query:L(a().min(1).max(256),a().max(2048)).optional(),headers:L(a().regex(su),a().max(4096)).optional().refine(e=>!e||Object.keys(e).every(t=>!cu.includes(t.toLowerCase())),"a reserved header"),body:a().max(65536).optional()}),lu=["capability_not_granted","method_not_granted","timeout","network","oversized","rate_limited"];T("ok",[p({ok:m(!0),status:f().int().min(100).max(599),headers:L(a(),a()),body:a().max(Ql.responseMaxBytes)}),p({ok:m(!1),error:p({code:h(lu),message:a().max(500)})})]),g({pluginId:a().min(2).max(64),alias:a().min(1).max(32),request:Nr});const Cr=2,uu=4096,du=1024,fu=16*1024*1024,pu=4096,mu="app-frame://media/",hu=256,Rr=4096,gu=500,vu=`(function () {
  var VERSION = ${Cr};
  var LABEL_MAX = ${ft};
  var QUESTIONS_MAX_BYTES = ${Kc};
  var WRITTEN_MAX = ${nr};
  var nextId = 1;
  var pending = {};
  var subscriptions = {};
  var themeListeners = [];
  var stateListeners = [];
  var storeListeners = [];
  var state = null;
  var birthState = null;
  var stateSeen = false;
  var sized = false;
  var initialized = false;
  var documentId = Date.now().toString(36) + Math.random().toString(36).slice(2);
  var capped = new WeakSet();
  var theme = document.documentElement.getAttribute("data-theme") || "dark";
  var form = { on: false, locked: false, fill: null, filling: false, staged: {}, first: new WeakMap(), last: "", fields: new WeakMap() };
  var KEY_IN_TEXT = new RegExp(${JSON.stringify(`${kl}|${vl}`)}, "g");
  var UNLINKED = "a, button, summary, label, input, select, option, textarea, script, style, svg, [role=button], [data-inf-action], [data-inf-draft], [contenteditable]";
  var keys = { known: null, rested: null, quiet: null, lit: null };
  var entries = { known: null };
  var caps = { pictures: false, escape: false };
  var held = { element: null, start: null, end: null, direction: null };
  var listen = EventTarget.prototype.addEventListener;
  // A hook in another spelling of the app's code names - Firstmate 3000's
  // data-fm-action, fm-mono - reads as this build's own too, so a card
  // written before the Infinitary rename works here (src/shared/codeNames.ts). Every
  // element is read as it arrives and again as such an attribute changes; the
  // author's own attributes and classes stay as written.
  var OWN = ${JSON.stringify(Ln)};
  var OTHERS = ${JSON.stringify(Ze.filter(e=>e!==Ln))};
  function ownHook(name) {
    for (var i = 0; i < OTHERS.length; i++) {
      var prefix = "data-" + OTHERS[i] + "-";
      if (name.indexOf(prefix) === 0) return "data-" + OWN + "-" + name.slice(prefix.length);
    }
    return null;
  }
  function respell(element, changed) {
    if (!element || element.nodeType !== 1) return;
    var names = changed ? [changed] : Array.prototype.map.call(element.attributes, function (a) { return a.name; });
    names.forEach(function (name) {
      var own = ownHook(name);
      if (!own) return;
      // Written only when it differs: a write records a change even when the
      // value is the same, which would wake this observer again for ever.
      var value = element.getAttribute(name);
      if (value === null) {
        if (element.hasAttribute(own)) element.removeAttribute(own);
      } else if ((changed || !element.hasAttribute(own)) && element.getAttribute(own) !== value) {
        element.setAttribute(own, value);
      }
    });
    if (element.classList && (!changed || changed === "class")) {
      Array.prototype.slice.call(element.classList).forEach(function (token) {
        for (var i = 0; i < OTHERS.length; i++) {
          var mine = OWN + "-" + token.slice(OTHERS[i].length + 1);
          if (token.indexOf(OTHERS[i] + "-") === 0 && !element.classList.contains(mine)) element.classList.add(mine);
        }
      });
    }
  }
  function respellTree(node) {
    if (node.nodeType !== 1) return;
    respell(node);
    if (node.firstElementChild) Array.prototype.forEach.call(node.querySelectorAll("*"), function (child) { respell(child); });
  }
  respellTree(document.documentElement);
  new MutationObserver(function (records) {
    records.forEach(function (record) {
      if (record.type === "attributes") {
        if (record.attributeName === "class" || ownHook(record.attributeName)) respell(record.target, record.attributeName);
      } else {
        Array.prototype.forEach.call(record.addedNodes, respellTree);
      }
    });
  }).observe(document.documentElement, { subtree: true, childList: true, attributes: true });
  var BRIDGE = document.currentScript;
  var SVG_NS = "http://www.w3.org/2000/svg";
  var hold = document.documentElement.hasAttribute("data-inf-held")
    ? { scripts: [], seen: new WeakSet(), timelines: [], watch: null, style: null, form: false, waiting: false }
    : null;
  document.documentElement.removeAttribute("data-inf-held");
  var loaded = false;
  var settling = false;
  window.addEventListener("load", function () { loaded = true; });
  function holdNodes(nodes) {
    for (var i = 0; i < nodes.length; i++) {
      var node = nodes[i];
      if (node.nodeType !== 1) continue;
      var found = node.localName === "script" || node.localName === "svg" ? [node] : [];
      if (node.firstElementChild) found = found.concat(Array.prototype.slice.call(node.querySelectorAll("script, svg")));
      found.forEach(function (element) {
        if (element.localName === "svg") {
          if (element.namespaceURI === SVG_NS && !element.ownerSVGElement && !element.animationsPaused()) {
            element.pauseAnimations();
            hold.timelines.push(element);
          }
          return;
        }
        if (element === BRIDGE || hold.seen.has(element)) return;
        hold.seen.add(element);
        hold.scripts.push({ element: element, type: element.getAttribute("type") });
        element.setAttribute("type", "text/inf-held");
      });
    }
  }
  if (hold) {
    hold.watch = new MutationObserver(function (records) {
      records.forEach(function (record) { holdNodes(record.addedNodes); });
    });
    hold.watch.observe(document.documentElement, { childList: true, subtree: true });
    hold.style = document.createElement("style");
    hold.style.textContent = "*, *::before, *::after { animation-play-state: paused !important; }";
    (document.head || document.documentElement).appendChild(hold.style);
  }
  // Released once the markup is read: at the end of DOMContentLoaded, so a
  // listener a released script adds for it is run here, once, and never by
  // the browser as well.
  function activate() {
    if (!hold || hold.waiting) return;
    if (document.readyState === "loading") {
      hold.waiting = true;
      window.addEventListener("DOMContentLoaded", release, { once: true });
      return;
    }
    release();
  }
  function release() {
    if (!hold) return;
    hold.watch.takeRecords().forEach(function (record) { holdNodes(record.addedNodes); });
    hold.watch.disconnect();
    var parts = hold;
    hold = null;
    parts.style.remove();
    parts.timelines.forEach(function (svg) { svg.unpauseAnimations(); });
    var late = { document: [], window: [], load: [] };
    var shims = [document, window].map(function (target) {
      var shim = function (type, listener, options) {
        if (listener && this === target) {
          if (type === "DOMContentLoaded") late[target === document ? "document" : "window"].push(listener);
          else if (type === "load" && target === window && loaded) late.load.push(listener);
        }
        return listen.call(this, type, listener, options);
      };
      target.addEventListener = shim;
      return { target: target, shim: shim };
    });
    var onload = window.onload;
    parts.scripts.forEach(function (entry) {
      var old = entry.element;
      if (!old.isConnected) return;
      var script = document.createElementNS(old.namespaceURI, "script");
      for (var i = 0; i < old.attributes.length; i++) {
        var attribute = old.attributes[i];
        if (attribute.name !== "type") script.setAttributeNS(attribute.namespaceURI, attribute.name, attribute.value);
      }
      if (entry.type !== null) script.setAttribute("type", entry.type);
      script.textContent = old.textContent;
      old.replaceWith(script);
    });
    shims.forEach(function (entry) {
      if (entry.target.addEventListener === entry.shim) delete entry.target.addEventListener;
    });
    var target = { document: document, window: window, load: window };
    ["document", "window", "load"].forEach(function (phase) {
      late[phase].forEach(function (listener) {
        var event = new Event(phase === "load" ? "load" : "DOMContentLoaded");
        try {
          if (typeof listener === "function") listener.call(target[phase], event);
          else if (typeof listener.handleEvent === "function") listener.handleEvent(event);
        } catch (error) {
          reportError(error);
        }
      });
    });
    if (loaded && window.onload !== onload && typeof window.onload === "function") {
      try { window.onload(new Event("load")); } catch (error) { reportError(error); }
    }
    // The form's baseline is what the body shows once its scripts have run.
    if (parts.form) startForm();
    // What the scripts do in their first two frames is the drawing settling, not a live change.
    settling = true;
    requestAnimationFrame(function () { requestAnimationFrame(function () { settling = false; }); });
    reportDrawing();
  }
  function capFigures() {
    if (!sized) return;
    var figures = document.querySelectorAll('svg[width="100%"]');
    for (var i = 0; i < figures.length; i++) {
      var figure = figures[i];
      if (figure.parentElement && figure.parentElement.closest("svg")) continue;
      if (figure.style.maxWidth && !capped.has(figure)) continue;
      var box = figure.viewBox && figure.viewBox.baseVal;
      if (!box || !(box.width > 0)) continue;
      var cap = box.width + "px";
      if (figure.style.maxWidth !== cap) figure.style.maxWidth = cap;
      capped.add(figure);
    }
  }
  function post(message) {
    message.fm = VERSION;
    message.document = documentId;
    parent.postMessage(message, "*");
  }
  var pendingMarkup;
  function refreshMarkup(html) {
    // The initial refresh can arrive before the original parser finishes.
    // Let it finish before morphing, including when no body exists yet.
    if (document.readyState === "loading") {
      pendingMarkup = html;
      return;
    }
    pendingMarkup = undefined;
    if (!document.body) return;
    var next = document.createElement("template");
    next.innerHTML = html;
    morphChildren(document.body, next.content);
  }
  document.addEventListener("DOMContentLoaded", function () {
    if (pendingMarkup === undefined) return;
    var html = pendingMarkup;
    pendingMarkup = undefined;
    refreshMarkup(html);
  }, { once: true });
  function blank(node) {
    return node.nodeType === 3 && node.nodeValue.trim() === "";
  }
  function morphChildren(into, from) {
    var at = into.firstChild;
    var source = from.firstChild;
    while (source) {
      var following = source.nextSibling;
      if (!at) {
        into.appendChild(source);
      } else if (at.nodeType === source.nodeType && at.nodeName === source.nodeName) {
        if (at.nodeType === 1) {
          morphAttributes(at, source);
          morphChildren(at, source);
        } else if (at.nodeValue !== source.nodeValue) {
          at.nodeValue = source.nodeValue;
        }
        at = at.nextSibling;
      } else if (blank(at)) {
        // Whitespace the document was written with goes, and the same
        // source meets the next node: the markup around it is not new.
        var gone = at;
        at = at.nextSibling;
        into.removeChild(gone);
        continue;
      } else if (blank(source)) {
        into.insertBefore(source, at);
      } else {
        var replaced = at;
        at = at.nextSibling;
        into.replaceChild(source, replaced);
      }
      source = following;
    }
    while (at) {
      var rest = at.nextSibling;
      into.removeChild(at);
      at = rest;
    }
  }
  function morphAttributes(element, source) {
    var i;
    for (i = element.attributes.length - 1; i >= 0; i--) {
      var name = element.attributes[i].name;
      if (!source.hasAttribute(name)) element.removeAttribute(name);
    }
    for (i = 0; i < source.attributes.length; i++) {
      var attribute = source.attributes[i];
      if (element.getAttribute(attribute.name) !== attribute.value) element.setAttribute(attribute.name, attribute.value);
    }
  }
  function bridgeError(code, message) {
    var error = new Error(message);
    error.name = "FrameBridgeError";
    error.code = code;
    return error;
  }
  function request(verb, payload) {
    return new Promise(function (resolve, reject) {
      var id = nextId++;
      pending[id] = { resolve: resolve, reject: reject };
      var message = { type: "request", id: id, verb: verb };
      for (var key in payload) message[key] = payload[key];
      post(message);
    });
  }
  window.addEventListener("message", function (event) {
    if (event.source !== parent) return;
    var data = event.data;
    if (!data || data.fm !== VERSION || typeof data.type !== "string") return;
    if (data.type === "initialize") {
      if (data.document !== documentId) return;
      var born = document.readyState === "loading"
        ? new Promise(function (resolve) { document.addEventListener("DOMContentLoaded", resolve, { once: true }); })
        : Promise.resolve();
      born.then(function () {
        capFigures();
        if (document.body) document.body.getBoundingClientRect();
        return document.fonts.ready;
      }).then(function () {
        requestAnimationFrame(function () { requestAnimationFrame(function () {
          initialized = true;
          resize();
        }); });
      });
    } else if (data.type === "response") {
      if (data.document !== documentId) return;
      var waiter = pending[data.id];
      if (!waiter) return;
      delete pending[data.id];
      if (data.ok) waiter.resolve(data.result);
      else waiter.reject(bridgeError(data.error.code, data.error.message));
    } else if (data.type === "data") {
      var subscription = subscriptions[data.sub];
      if (!subscription) return;
      if (data.error) {
        if (subscription.onError) subscription.onError(bridgeError(data.error.code, data.error.message));
      } else {
        subscription.onValue(data.value);
      }
    } else if (data.type === "ping") {
      post({ type: "pong", seq: data.seq });
    } else if (data.type === "state") {
      if (!stateSeen) {
        stateSeen = true;
        birthState = data.state;
      }
      state = data.state;
      stateListeners.slice().forEach(function (listener) { listener(state); });
    } else if (data.type === "store") {
      storeListeners.slice().forEach(function (listener) { listener(data.key); });
    } else if (data.type === "form") {
      form.fill = Array.isArray(data.fill) ? data.fill : null;
      form.locked = data.readOnly === true;
      if (hold) hold.form = true;
      else if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", startForm);
      else startForm();
    } else if (data.type === "tasks") {
      var known = {};
      var any = false;
      (Array.isArray(data.keys) ? data.keys : []).forEach(function (key) {
        if (typeof key === "string") { known[key] = true; any = true; }
      });
      keys.known = any ? known : null;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", linkKeys, { once: true });
      else linkKeys();
    } else if (data.type === "lit") {
      keys.lit = typeof data.key === "string" ? data.key : null;
      markLit();
    } else if (data.type === "entries") {
      var named = {};
      var some = false;
      (Array.isArray(data.entries) ? data.entries : []).forEach(function (entry) {
        if (entry && typeof entry.id === "string" && typeof entry.label === "string") {
          named[entry.id] = { label: entry.label, tone: entry.tone === "ok" || entry.tone === "warn" ? entry.tone : "none" };
          some = true;
        }
      });
      entries.known = some ? named : null;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", linkKeys, { once: true });
      else {
        refreshEntries();
        linkKeys();
      }
    } else if (data.type === "keys") {
      caps.pictures = data.pictures === true;
      caps.escape = data.escape === true;
      if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", tagPictures, { once: true });
      else tagPictures();
    } else if (data.type === "focus") {
      returnFocus();
    } else if (data.type === "reveal") {
      if (data.document !== documentId || !Number.isSafeInteger(data.seq) || !Number.isSafeInteger(data.start)) return;
      var stamp = document.querySelector("[data-inf-revision-offer]");
      if (!stamp || stamp.getAttribute("data-inf-revision-offer") !== data.offerId) return;
      var targets = document.querySelectorAll('[data-inf-target="' + data.start + '"]');
      var target = targets.length === 1 ? targets[0] : null;
      if (!target) { post({ type: "revealed", seq: data.seq, offerId: data.offerId }); return; }
      var ancestor = target.parentElement;
      while (ancestor) { if (ancestor.tagName === "DETAILS") ancestor.open = true; ancestor = ancestor.parentElement; }
      resize();
      requestAnimationFrame(function () {
        if (!target.isConnected) { post({type: "revealed", seq: data.seq, offerId: data.offerId}); return; }
        var rect = target.getBoundingClientRect();
        if (!target.getClientRects().length) { post({type: "revealed", seq: data.seq, offerId: data.offerId}); return; }
        document.querySelectorAll("[data-inf-revision-highlight]").forEach(function (el) { el.removeAttribute("data-inf-revision-highlight"); });
        target.setAttribute("data-inf-revision-highlight", "");
        setTimeout(function () { target.removeAttribute("data-inf-revision-highlight"); }, 1000);
        if (data.keyboard) { if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1"); target.focus({preventScroll: true}); }
        post({ type: "revealed", seq: data.seq, offerId: data.offerId, top: rect.top + window.scrollY, height: rect.height });
      });
    } else if (data.type === "collect") {
      readForm(data.seq);
      if (data.focusUnpicked) focusUnpicked();
    } else if (data.type === "width") {
      sized = true;
      document.documentElement.setAttribute("data-width", String(data.width));
      capFigures();
    } else if (data.type === "inset") {
      // The box the card's chrome holds over this document's top right: the
      // stylesheet's [data-inf-inset] spacer keeps the first lines clear of it.
      var box = document.documentElement.style;
      box.setProperty("--inf-inset-width", Math.max(0, Number(data.width) || 0) + "px");
      box.setProperty("--inf-inset-height", Math.max(0, Number(data.height) || 0) + "px");
    } else if (data.type === "activate") {
      activate();
    } else if (data.type === "markup") {
      if (typeof data.html === "string") refreshMarkup(data.html);
    } else if (data.type === "theme") {
      theme = data.theme;
      document.documentElement.setAttribute("data-theme", theme);
      if (document.body) document.body.setAttribute("data-theme", theme);
      themeListeners.slice().forEach(function (listener) { listener(theme); });
    }
  });
  var fm = {
    version: VERSION,
    get theme() { return theme; },
    get state() { return state; },
    get birthState() { return birthState; },
    onTheme: function (listener) {
      themeListeners.push(listener);
      return function () {
        themeListeners = themeListeners.filter(function (l) { return l !== listener; });
      };
    },
    onState: function (listener) {
      stateListeners.push(listener);
      return function () {
        stateListeners = stateListeners.filter(function (l) { return l !== listener; });
      };
    },
    subscribe: function (read, args, onValue, onError) {
      var sub = nextId++;
      subscriptions[sub] = { onValue: onValue, onError: onError };
      var ready = request("subscribe", { sub: sub, read: read, args: args === undefined ? {} : args });
      ready.catch(function () { delete subscriptions[sub]; });
      return {
        ready: ready,
        unsubscribe: function () {
          if (!subscriptions[sub]) return Promise.resolve();
          delete subscriptions[sub];
          return request("unsubscribe", { sub: sub });
        }
      };
    },
    action: function (id, value) {
      return request("action", value === undefined ? { action: String(id) } : { action: String(id), value: value });
    },
    fetch: function (alias, req) {
      return request("fetch", { alias: String(alias), request: req });
    },
    store: function (req) {
      return request("store", req);
    },
    onStore: function (listener) {
      storeListeners.push(listener);
      return function () {
        storeListeners = storeListeners.filter(function (l) { return l !== listener; });
      };
    },
    stage: function (name, value) {
      var json = value === undefined ? undefined : JSON.stringify(value);
      if (json === undefined) delete form.staged[String(name)];
      else form.staged[String(name)] = json;
      if (form.on) readForm();
    }
  };
  Object.freeze(fm);
  // The same bridge under every spelling's name: window.inf, and window.fm
  // for a body written before the Infinitary rename.
  ${Ze.map(e=>`window.${e} = fm;`).join(" ")}
  ${Ze.map(e=>`window.${e}Action = function (id) { fm.action(id).catch(function () {}); };`).join(" ")}
  var STRIP_SHOWN = 6;
  function groupPictures(group) {
    var pictures = [];
    for (var i = 0; i < group.children.length; i++) {
      if (group.children[i].tagName === "IMG") pictures.push(group.children[i]);
    }
    return pictures;
  }
  function showPictures(pictures, index) {
    post({
      type: "image",
      index: index,
      pictures: pictures.map(function (picture) {
        return {
          src: picture.currentSrc || picture.src,
          alt: picture.getAttribute("alt") || "",
          width: picture.naturalWidth || 0,
          height: picture.naturalHeight || 0
        };
      })
    });
  }
  function openPicture(picture) {
    var demo = demoOf(picture.closest("figure[data-inf-demo]"));
    if (demo && demo.poster === picture) {
      showDemo(demo, false);
      return;
    }
    var group = picture.closest(".inf-pictures");
    var members = group ? groupPictures(group) : [];
    var index = members.indexOf(picture);
    if (index < 0) {
      members = [picture];
      index = 0;
    }
    showPictures(members, index);
  }
  var DEMO_SOURCE = ${JSON.stringify(mu)};
  var DEMO_CAPTION_MAX = ${Rr};
  function demoOf(figure) {
    if (!figure || !figure.hasAttribute("data-inf-demo")) return null;
    var src = figure.getAttribute("data-inf-demo") || "";
    var poster = figure.querySelector("img");
    if (src.indexOf(DEMO_SOURCE) !== 0 || !poster) return null;
    return { figure: figure, src: src, poster: poster };
  }
  function demoMs(figure) {
    var ms = Math.round(Number(figure.getAttribute("data-inf-demo-duration")));
    return ms > 0 && ms < 600000 ? ms : 0;
  }
  function showDemo(demo, play) {
    var caption = demo.figure.querySelector("figcaption");
    var poster = demo.poster;
    post({
      type: "demo",
      src: demo.src,
      play: play,
      durationMs: demoMs(demo.figure),
      caption: caption ? (caption.textContent || "").replace(/\\s+/g, " ").trim().slice(0, DEMO_CAPTION_MAX) : "",
      poster: {
        src: poster.currentSrc || poster.src,
        alt: poster.getAttribute("alt") || "",
        width: poster.naturalWidth || 0,
        height: poster.naturalHeight || 0
      }
    });
  }
  // Each verified demo gets its Play button, with the recording's length,
  // under its poster: drawn with the body, so it is part of its first drawing.
  // A figure is done only once it has its button: the parser can pause after
  // the figure's start tag, before its poster, and the next change draws it.
  function decorateDemos() {
    if (!document.body) return false;
    var figures = document.querySelectorAll("figure[data-inf-demo]:not([data-inf-demo-ready])");
    var drawn = false;
    for (var i = 0; i < figures.length; i++) {
      var demo = demoOf(figures[i]);
      if (!demo) continue;
      figures[i].setAttribute("data-inf-demo-ready", "");
      var seconds = Math.max(1, Math.round(demoMs(demo.figure) / 1000));
      var button = document.createElement("button");
      button.type = "button";
      button.setAttribute("data-inf-demo-play", "");
      button.setAttribute("aria-label", "Play the demo, " + seconds + (seconds === 1 ? " second" : " seconds"));
      button.textContent = "Play · " + seconds + " s";
      demo.poster.insertAdjacentElement("afterend", button);
      drawn = true;
    }
    return drawn;
  }
  var PICTURE_CONTROL = "a, button, summary, label, [data-inf-action]";
  var UNSHOWN_PICTURE = ".inf-pictures > img:nth-of-type(n+7)";
  function tagPictures() {
    if (!caps.pictures || !document.body) return;
    var pictures = document.querySelectorAll("img:not([data-inf-picture]):not([tabindex])");
    var tagged = false;
    for (var i = 0; i < pictures.length; i++) {
      var picture = pictures[i];
      if (picture.closest(PICTURE_CONTROL) || picture.matches(UNSHOWN_PICTURE)) continue;
      picture.setAttribute("data-inf-picture", "");
      picture.setAttribute("tabindex", "0");
      tagged = true;
    }
    if (!tagged) return;
    // The same pictures in the same place: a stop for the keyboard is not the body changing.
    sizeWatch.takeRecords();
  }
  function moreTileIndex(group, x, y) {
    var pictures = groupPictures(group);
    if (pictures.length <= STRIP_SHOWN) return -1;
    var tile = getComputedStyle(group, "::after");
    if (tile.content === "none" || tile.display === "none") return -1;
    var last = pictures[STRIP_SHOWN - 1];
    var lastBox = last.getBoundingClientRect();
    var box = group.getBoundingClientRect();
    var width = parseFloat(tile.width) || 0;
    var height = parseFloat(tile.height) || 0;
    var left = lastBox.right + (parseFloat(getComputedStyle(group).columnGap) || 0);
    var top = lastBox.top;
    if (left + width > box.right + 0.5) {
      left = box.left;
      top = lastBox.bottom + (parseFloat(getComputedStyle(last).marginBottom) || 0);
    }
    return x >= left && x <= left + width && y >= top && y <= top + height ? STRIP_SHOWN : -1;
  }
  document.addEventListener("click", function (event) {
    var target = event.target;
    var action = target && target.closest ? target.closest("[data-inf-action]") : null;
    if (action) {
      event.preventDefault();
      window.infAction(action.getAttribute("data-inf-action"));
      return;
    }
    var draft = target && target.closest ? target.closest("[data-inf-draft]") : null;
    if (draft) {
      event.preventDefault();
      post({ type: "draft", text: draft.getAttribute("data-inf-draft") });
      return;
    }
    var task = keyLink(target);
    if (task) {
      event.preventDefault();
      openKey(task);
      return;
    }
    var reference = entryLink(target);
    if (reference) {
      event.preventDefault();
      openEntry(reference);
      return;
    }
    var link = target && target.closest ? target.closest("a[href]") : null;
    if (link) {
      event.preventDefault();
      post({ type: "link", href: link.getAttribute("href") });
      return;
    }
    if (event.defaultPrevented || !target || !target.closest) return;
    var play = target.closest("[data-inf-demo-play]");
    if (play) {
      var playing = demoOf(play.closest("figure[data-inf-demo]"));
      if (playing) showDemo(playing, true);
      return;
    }
    var picture = target.closest("img");
    if (picture) {
      if (picture.closest("button, summary, label")) return;
      openPicture(picture);
      return;
    }
    if (target.classList.contains("inf-pictures")) {
      var more = moreTileIndex(target, event.clientX, event.clientY);
      if (more >= 0) showPictures(groupPictures(target), more);
    }
  });
  function kindOf(control) {
    if (control.tagName === "SELECT") return "select";
    if (control.tagName === "TEXTAREA") return "text";
    var type = (control.getAttribute("type") || "text").toLowerCase();
    if (type === "radio" || type === "checkbox" || type === "hidden") return type;
    if (type === "submit" || type === "button" || type === "reset" || type === "image" || type === "file") return "";
    return "text";
  }
  function words(node) {
    return (node.textContent || "").replace(/\\s+/g, " ").trim().slice(0, 500);
  }
  function labelOf(control) {
    var parts = [];
    for (var i = 0; control.labels && i < control.labels.length; i++) parts.push(words(control.labels[i]));
    return parts.join(" ").trim();
  }
  function questions() {
    var list = [];
    var byName = {};
    var controls = document.querySelectorAll("input[name], select[name], textarea[name]");
    for (var i = 0; i < controls.length; i++) {
      var control = controls[i];
      var kind = kindOf(control);
      if (!kind || control.disabled || !control.name) continue;
      if (kind === "hidden" && !form.first.has(control)) form.first.set(control, control.value);
      var group = byName[control.name];
      if (!group) {
        group = byName[control.name] = { name: control.name, controls: [], required: false };
        list.push(group);
      }
      group.controls.push(control);
      if (control.required) group.required = true;
    }
    for (var name in form.staged) {
      if (!byName[name]) {
        byName[name] = { name: name, controls: [], required: false };
        list.push(byName[name]);
      }
      byName[name].staged = true;
    }
    return list;
  }
  function recommended(control, fallback) {
    var owner = control.tagName === "OPTION" ? control.closest("select") : control;
    var marked = owner.tagName === "SELECT"
      ? owner.querySelector("option[data-inf-recommended]")
      : document.querySelector('input[name="' + CSS.escape(control.name) + '"][data-inf-recommended]');
    return marked ? control.hasAttribute("data-inf-recommended") : fallback;
  }
  // A question's Something else row (FI3-1002): the author writes it as one
  // more radio or checkbox of the question, or an <option> of its select,
  // marked data-inf-write-in. It is never an option value: once picked the
  // app opens a text field under it, and the words in it are the answer.
  function isWriteIn(control) {
    return control.hasAttribute("data-inf-write-in");
  }
  function rowPicked(row) {
    return row.tagName === "OPTION" ? row.selected : row.checked;
  }
  function writeInRows(group) {
    var rows = [];
    group.controls.forEach(function (control) {
      var kind = kindOf(control);
      if ((kind === "radio" || kind === "checkbox") && isWriteIn(control)) rows.push(control);
      else if (kind === "select") {
        for (var i = 0; i < control.options.length; i++) if (isWriteIn(control.options[i])) rows.push(control.options[i]);
      }
    });
    return rows;
  }
  function pickedWriteIn(group) {
    return writeInRows(group).find(rowPicked) || null;
  }
  function writtenOf(row) {
    var field = row && form.fields.get(row);
    return field && rowPicked(row) ? field.value.trim().slice(0, WRITTEN_MAX) : "";
  }
  function hasAnswer(answer) {
    return answer.values.length > 0 || answer.written !== undefined;
  }
  function focusUnpicked() {
    var group = questions().find(function (group) { return group.required && !hasAnswer(answerOf(group)); });
    if (!group) return;
    // A picked Something else with nothing written: its field is what waits.
    var field = form.fields.get(pickedWriteIn(group));
    var control = field && !field.hidden ? field : group.controls.find(function (control) { return !control.disabled && !boxless(control); });
    if (control) { control.focus(); control.scrollIntoView({ block: "center", behavior: "smooth" }); }
  }
  // A question that recommends rather than pre-picks: nothing is chosen
  // until the captain chooses, so any answer it has is the captain's pick.
  function tagged(group) {
    return group.controls.some(function (control) { return control.hasAttribute("data-inf-recommended") || (kindOf(control) === "select" && control.querySelector("option[data-inf-recommended]")); });
  }
  function answerOf(group) {
    if (group.staged) return { name: group.name, values: [form.staged[group.name]], changed: true, json: true };
    var values = [];
    var labels = [];
    var proposed = [];
    function pick(value, label) {
      if (value === "") return;
      values.push(value);
      labels.push(label);
    }
    group.controls.forEach(function (control) {
      var kind = kindOf(control);
      if (kind === "radio" || kind === "checkbox") {
        if (isWriteIn(control)) return;
        if (control.checked) pick(control.value, labelOf(control));
        if (recommended(control, control.defaultChecked) && control.value !== "") proposed.push(control.value);
      } else if (kind === "select") {
        var marked = false;
        for (var i = 0; i < control.options.length; i++) {
          var option = control.options[i];
          if (isWriteIn(option)) continue;
          if (option.selected) pick(option.value, words(option));
          if (recommended(option, option.defaultSelected)) {
            marked = true;
            if (option.value !== "") proposed.push(option.value);
          }
        }
        var first = control.options[0];
        if (!marked && !control.multiple && first && first.value !== "" && !isWriteIn(first)) proposed.push(first.value);
      } else {
        pick(control.value, "");
        var initial = kind === "hidden" ? form.first.get(control) : control.defaultValue;
        if (initial) proposed.push(initial);
      }
    });
    // The captain's own words are never what the author proposed.
    var written = writtenOf(pickedWriteIn(group));
    var changed = written !== "" || ((!tagged(group) || values.length > 0) && JSON.stringify(values.slice().sort()) !== JSON.stringify(proposed.sort()));
    var answer = { name: group.name, values: values, changed: changed };
    if (labels.some(function (label) { return label !== ""; })) answer.labels = labels;
    if (written) answer.written = written;
    return answer;
  }
  function wording(text) {
    var whole = (text || "").replace(/\\s+/g, " ").trim();
    return { text: whole.slice(0, LABEL_MAX), cut: whole.length > LABEL_MAX };
  }
  // A node's own words: the text of a control it wraps - a select's
  // options, a textarea's default - is an answer, never the question.
  function spoken(node) {
    var copy = node.cloneNode(true);
    var inner = copy.querySelectorAll("select, textarea, script, style");
    for (var i = 0; i < inner.length; i++) inner[i].remove();
    return copy.textContent || "";
  }
  function byIds(ids) {
    var parts = [];
    (ids || "").split(/\\s+/).forEach(function (id) {
      var node = id ? document.getElementById(id) : null;
      if (node) parts.push(spoken(node));
    });
    return parts.join(" ");
  }
  function ownWording(node) {
    if (node.hasAttribute("aria-labelledby")) return { raw: byIds(node.getAttribute("aria-labelledby")), basis: "labelledby" };
    if (node.hasAttribute("aria-label")) return { raw: node.getAttribute("aria-label"), basis: "aria-label" };
    if (node.tagName === "FIELDSET") {
      for (var i = 0; i < node.children.length; i++) {
        if (node.children[i].tagName === "LEGEND") return { raw: spoken(node.children[i]), basis: "legend" };
      }
    }
    return null;
  }
  function holderOf(control) {
    for (var node = control.parentElement; node && node !== document.body; node = node.parentElement) {
      var role = node.getAttribute("role");
      if (node.tagName === "FIELDSET" || role === "group" || role === "radiogroup") return node;
    }
    return null;
  }
  function promptOf(controls, lone) {
    if (lone) {
      var own = ownWording(controls[0]);
      if (own && own.raw) return own;
      var bound = [];
      for (var i = 0; controls[0].labels && i < controls[0].labels.length; i++) bound.push(spoken(controls[0].labels[i]));
      if (bound.join("").trim()) return { raw: bound.join(" "), basis: "label" };
    }
    var holders = controls.map(holderOf);
    var holder = holders[0];
    if (holders.every(function (each) { return each === holder; })) {
      if (holder) return ownWording(holder) || { gap: "no-prompt" };
    } else if (holders.some(function (each) { return each; })) return { gap: "conflicting-prompt" };
    var first = controls.map(function (control) { return (control.getAttribute("aria-labelledby") || "").split(/\\s+/)[0]; });
    if (!lone && first[0] && first.every(function (id) { return id === first[0]; })) return { raw: byIds(first[0]), basis: "labelledby" };
    return { gap: "no-prompt" };
  }
  function boxless(node) {
    return node.hidden || node.getClientRects().length === 0;
  }
  function defineQuestion(group) {
    var gaps = [];
    function gap(name) { if (gaps.indexOf(name) < 0) gaps.push(name); }
    function label(text) {
      var read = wording(text);
      if (read.cut) gap("label-truncated");
      return read.text || null;
    }
    var definition = { name: group.name, kind: "opaque", control: "staged", prompt: null, promptBasis: null, options: [], defaultBasis: "none", required: group.required, gaps: gaps, complete: false };
    if (group.staged) {
      gap("opaque");
      return definition;
    }
    var all = [];
    var named = document.getElementsByName(group.name);
    for (var i = 0; i < named.length; i++) if (kindOf(named[i])) all.push(named[i]);
    var kinds = [];
    group.controls.forEach(function (control) {
      var kind = kindOf(control);
      if (kinds.indexOf(kind) < 0) kinds.push(kind);
    });
    var kind = kinds.length === 1 ? kinds[0] : "mixed";
    var first = group.controls[0];
    if (kind === "mixed") {
      gap("mixed-controls");
      definition.control = "mixed";
    } else if (kind === "hidden") {
      definition.control = "hidden";
      if (form.first.get(first)) definition.defaultBasis = "authored";
    } else if (kind === "radio" || kind === "checkbox") {
      definition.control = kind;
      definition.kind = kind === "radio" ? "single" : "multiple";
      all.forEach(function (control) {
        if (kindOf(control) !== kind) return;
        if (isWriteIn(control)) {
          definition.writeIn = true;
          return;
        }
        definition.options.push({ value: control.value, label: label(labelOf(control)), authoredDefault: recommended(control, control.defaultChecked), disabled: control.disabled, hidden: boxless(control) });
      });
      if (definition.options.some(function (option) { return option.authoredDefault; })) definition.defaultBasis = "authored";
    } else if (kind === "select") {
      definition.control = first.multiple ? "select-multiple" : "select";
      definition.kind = first.multiple ? "multiple" : "single";
      group.controls.forEach(function (control) {
        for (var i = 0; i < control.options.length; i++) {
          var option = control.options[i];
          if (isWriteIn(option)) {
            definition.writeIn = true;
            continue;
          }
          definition.options.push({ value: option.value, label: label(option.textContent), authoredDefault: recommended(option, option.defaultSelected), disabled: option.disabled, hidden: option.hidden });
        }
      });
      if (definition.options.some(function (option) { return option.authoredDefault; })) definition.defaultBasis = "authored";
      else if (!first.multiple && first.options[0] && first.options[0].value !== "") definition.defaultBasis = "implicit-first";
    } else {
      definition.control = first.tagName === "TEXTAREA" ? "textarea" : "text";
      definition.kind = "text";
      if (group.controls.some(function (control) { return control.defaultValue; })) definition.defaultBasis = "authored";
    }
    if (definition.kind === "opaque") {
      gap("opaque");
      return definition;
    }
    var values = definition.options.map(function (option) { return option.value; });
    if (values.some(function (value, index) { return values.indexOf(value) !== index; })) gap("duplicate-values");
    var lone = group.controls.length === 1 && (kind === "text" || kind === "select");
    var prompt = promptOf(group.controls, lone);
    if (prompt.gap || !wording(prompt.raw).text) gap(prompt.gap || "no-prompt");
    else {
      definition.prompt = label(prompt.raw);
      definition.promptBasis = prompt.basis;
    }
    definition.complete = gaps.length === 0;
    return definition;
  }
  function readForm(seq) {
    var answers = [];
    var answered = 0;
    var changed = 0;
    var picked = 0;
    var groups = questions();
    groups.forEach(function (group) {
      var answer = answerOf(group);
      answers.push(answer);
      if (!group.required || hasAnswer(answer)) answered += 1;
      if (answer.changed) changed += 1;
      // The captain's own answers, which a close would lose: a change from
      // the author's proposal, a pick where the author only recommended, or
      // words written under Something else. An untouched prefilled field or
      // authored default is not one.
      if (tagged(group) ? hasAnswer(answer) : answer.changed) picked += 1;
    });
    var message = { type: "answers", answered: answered, of: answers.length, changed: changed, picked: picked, answers: answers };
    var key = JSON.stringify(message);
    if (seq === undefined && key === form.last) return;
    form.last = key;
    if (seq !== undefined) {
      message.seq = seq;
      // What the questions offered rides only the reading a footer click
      // asked for, never a draft (docs/card-evidence.md).
      try {
        var defined = groups.map(defineQuestion);
        if (new TextEncoder().encode(JSON.stringify(defined)).byteLength > QUESTIONS_MAX_BYTES) message.questionsGap = "too-large";
        else message.questions = defined;
      } catch (error) {
        message.questionsGap = "invalid";
      }
    }
    post(message);
  }
  function fillForm(answers) {
    var byName = {};
    questions().forEach(function (group) { byName[group.name] = group; });
    var touched = [];
    answers.forEach(function (answer) {
      if (!answer || !Array.isArray(answer.values)) return;
      if (answer.json) {
        if (typeof answer.values[0] === "string") form.staged[answer.name] = answer.values[0];
        return;
      }
      var group = byName[answer.name];
      if (!group || group.staged) return;
      if (!answer.changed && group.controls.every(function (control) { var kind = kindOf(control); return kind === "text" || kind === "hidden"; })) return;
      var values = answer.values.map(String);
      // Words written under Something else come back under the new body's
      // own Something else row; a body with none leaves them at its proposal.
      var written = typeof answer.written === "string" ? answer.written : "";
      var row = written ? writeInRows(group)[0] || null : null;
      if (written && !row && values.length === 0) return;
      var offered = group.controls.some(function (control) {
        var kind = kindOf(control);
        if (kind === "text" || kind === "hidden") return true;
        if (kind !== "select") return values.indexOf(control.value) >= 0;
        for (var i = 0; i < control.options.length; i++) {
          if (values.indexOf(control.options[i].value) >= 0) return true;
        }
        return false;
      });
      if (values.length > 0 && !offered) return;
      var next = 0;
      group.controls.forEach(function (control) {
        var kind = kindOf(control);
        if (kind === "radio" || kind === "checkbox") control.checked = isWriteIn(control) ? control === row : values.indexOf(control.value) >= 0;
        else if (kind === "select") {
          for (var i = 0; i < control.options.length; i++) {
            var option = control.options[i];
            option.selected = isWriteIn(option) ? option === row : values.indexOf(option.value) >= 0;
          }
        } else control.value = values[next++] || "";
        touched.push(control);
      });
      var field = row && writeInField(row);
      if (field) field.value = written;
    });
    form.filling = true;
    try {
      touched.forEach(function (control) {
        control.dispatchEvent(new Event("input", { bubbles: true }));
        control.dispatchEvent(new Event("change", { bubbles: true }));
      });
    } finally {
      form.filling = false;
    }
  }
  function tagRecommendations() {
    document.querySelectorAll("input[data-inf-recommended]:is([type=radio], [type=checkbox])").forEach(function (control) {
      Array.from(control.labels || []).forEach(function (label) { if (!label.hasAttribute("data-inf-recommended-label")) label.setAttribute("data-inf-recommended-label", ""); });
    });
    document.querySelectorAll("select").forEach(function (select) {
      var options = Array.from(select.options).filter(function (option) { return option.hasAttribute("data-inf-recommended"); });
      var tag = select.nextElementSibling;
      if (!tag || !tag.hasAttribute("data-inf-recommendation")) {
        if (!options.length) return;
        tag = document.createElement("span");
        tag.setAttribute("data-inf-recommendation", "");
        select.after(tag);
      }
      var text = options.length ? "Recommended: " + options.map(words).join(", ") : "";
      if (tag.textContent !== text) tag.textContent = text;
    });
  }
  // The field under a Something else row: the app's own, with no name, so
  // its words ride the row's question as "written" and never a question of
  // their own. One line that grows to three (the frame stylesheet).
  function writeInField(row) {
    var field = form.fields.get(row);
    if (field && field.isConnected) return field;
    var owner = row.tagName === "OPTION" ? row.closest("select") : row;
    if (!owner || !owner.name) return null;
    field = document.createElement("textarea");
    field.setAttribute("data-inf-write-in-field", owner === row ? "row" : "select");
    field.rows = 1;
    field.maxLength = WRITTEN_MAX;
    field.placeholder = "Say what you want instead";
    var named = [];
    var all = document.getElementsByName(owner.name);
    for (var i = 0; i < all.length; i++) if (kindOf(all[i])) named.push(all[i]);
    var asked = promptOf(named, owner !== row);
    var prompt = asked.gap ? "" : wording(asked.raw).text;
    field.setAttribute("aria-label", prompt ? "Your own answer to: " + prompt : "Your own answer");
    field.hidden = true;
    form.fields.set(row, field);
    var anchor = owner;
    if (owner === row) {
      var label = row.closest("label") || (row.labels && row.labels[row.labels.length - 1]);
      if (label && (label.contains(row) || row.compareDocumentPosition(label) & Node.DOCUMENT_POSITION_FOLLOWING)) anchor = label;
    } else {
      while (anchor.nextElementSibling && anchor.nextElementSibling.hasAttribute("data-inf-recommendation")) anchor = anchor.nextElementSibling;
    }
    anchor.after(field);
    return field;
  }
  // Each Something else row's field shows only while the row is picked, and
  // keeps its words while it hides: they are sent only with the row.
  function offerWriteIns() {
    document.querySelectorAll('input[data-inf-write-in]:is([type="radio"], [type="checkbox"]), select option[data-inf-write-in]').forEach(function (row) {
      var field = writeInField(row);
      if (!field) return;
      var shown = rowPicked(row);
      if (field.hidden === shown) field.hidden = !shown;
    });
  }
  // Picking Something else puts the captain in its field, ready to write. A
  // pick the bridge restored (a revision's draft) moves no focus.
  function focusWriteIn(event) {
    var target = event.target;
    if (form.filling || form.locked || !target || !target.hasAttribute) return;
    var row = target.tagName === "SELECT"
      ? Array.prototype.find.call(target.selectedOptions, isWriteIn)
      : isWriteIn(target) && target.checked ? target : null;
    var field = row && form.fields.get(row);
    if (field && !field.hidden) field.focus();
  }
  function lockForm() {
    document.querySelectorAll("input, select, textarea, button, fieldset").forEach(function (control) {
      if (!control.disabled) control.disabled = true;
    });
  }
  function dressForm() {
    tagRecommendations();
    offerWriteIns();
  }
  function startForm() {
    dressForm();
    if (form.fill) fillForm(form.fill);
    form.fill = null;
    // A draft filled into a new document shows its rows' fields: no watch
    // heard that fill.
    offerWriteIns();
    if (form.locked) lockForm();
    if (!form.on) {
      form.on = true;
      var watch = function () { dressForm(); if (form.locked) lockForm(); readForm(); };
      document.addEventListener("input", watch, true);
      document.addEventListener("change", watch, true);
      document.addEventListener("change", focusWriteIn);
      new MutationObserver(watch).observe(document.documentElement, {
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ["name", "value", "disabled", "required", "checked", "selected", "data-inf-recommended", "data-inf-write-in"]
      });
    }
    readForm();
  }
  var lastReported = "";
  var resizeQueued = false;
  var liveChange = false;
  function reading(height, width) {
    return height + ":" + width + ":" + initialized + ":" + (hold !== null);
  }
  function resize() {
    if (resizeQueued) return;
    resizeQueued = true;
    requestAnimationFrame(function () {
      resizeQueued = false;
      capFigures();
      if (!document.body) return;
      var height = document.body.getBoundingClientRect().height;
      var width = document.documentElement.clientWidth;
      var read = reading(height, width);
      if (read === lastReported) return;
      lastReported = read;
      var message = { type: "resize", height: height, width: width, initialized: initialized, live: liveChange };
      // A held page's drawing: prepared, its own behavior not started.
      if (hold) message.held = true;
      post(message);
      liveChange = false;
    });
  }
  // A released page reports its drawing at once, without waiting for a
  // frame: a hidden frame's frames are throttled, and the stage shows the
  // card on this report. What its scripts changed is that drawing.
  function reportDrawing() {
    capFigures();
    if (!initialized || !document.body) {
      lastReported = "";
      resize();
      return;
    }
    sizeWatch.takeRecords();
    var height = document.body.getBoundingClientRect().height;
    var width = document.documentElement.clientWidth;
    lastReported = reading(height, width);
    liveChange = false;
    post({ type: "resize", height: height, width: width, initialized: true, live: false });
  }
  var sizeWatch = new MutationObserver(function () {
    if (initialized && !settling) liveChange = true;
    resize();
  });
  sizeWatch.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
  function keyLink(target) {
    return target && target.closest ? target.closest("a[data-inf-task]") : null;
  }
  function entryLink(target) {
    return target && target.closest ? target.closest("a[data-inf-entry]") : null;
  }
  function linkText(node) {
    var text = node.nodeValue;
    var parts = null;
    var at = 0;
    var match;
    KEY_IN_TEXT.lastIndex = 0;
    while ((match = KEY_IN_TEXT.exec(text))) {
      var task = keys.known && keys.known[match[0]];
      var entry = !task && entries.known && Object.prototype.hasOwnProperty.call(entries.known, match[0]) ? entries.known[match[0]] : null;
      if (!task && !entry) continue;
      parts = parts || document.createDocumentFragment();
      if (match.index > at) parts.appendChild(document.createTextNode(text.slice(at, match.index)));
      var link = document.createElement("a");
      if (task) {
        link.setAttribute("data-inf-task", match[0]);
      } else {
        link.setAttribute("data-inf-entry", match[0]);
        link.setAttribute("data-inf-standing", entry.tone);
        link.setAttribute("aria-label", entry.label);
        link.setAttribute("title", entry.label);
      }
      link.setAttribute("role", "link");
      link.setAttribute("tabindex", "0");
      link.textContent = match[0];
      parts.appendChild(link);
      at = match.index + match[0].length;
    }
    if (!parts) return false;
    if (at < text.length) parts.appendChild(document.createTextNode(text.slice(at)));
    node.parentNode.replaceChild(parts, node);
    return true;
  }
  // A reference already linked takes its entry's words and mark as they stand now.
  function refreshEntries() {
    if (!entries.known || !document.body) return;
    var changed = false;
    document.querySelectorAll("a[data-inf-entry]").forEach(function (link) {
      var id = link.getAttribute("data-inf-entry");
      var entry = Object.prototype.hasOwnProperty.call(entries.known, id) ? entries.known[id] : null;
      if (!entry) return;
      if (link.getAttribute("data-inf-standing") !== entry.tone) {
        link.setAttribute("data-inf-standing", entry.tone);
        changed = true;
      }
      if (link.getAttribute("aria-label") !== entry.label) {
        link.setAttribute("aria-label", entry.label);
        link.setAttribute("title", entry.label);
        changed = true;
      }
    });
    // The same words in the same place: a mark is not the body changing.
    if (changed) sizeWatch.takeRecords();
  }
  // The key lit by a rest elsewhere in the window (INF-237) takes the hover mark, on every link to it.
  function markLit() {
    document.querySelectorAll("a[data-inf-task]").forEach(function (link) {
      var on = keys.lit !== null && link.getAttribute("data-inf-task") === keys.lit;
      if (on === link.hasAttribute("data-inf-lit")) return;
      if (on) link.setAttribute("data-inf-lit", "");
      else link.removeAttribute("data-inf-lit");
    });
    // A mark is not the body changing.
    sizeWatch.takeRecords();
  }
  function linkKeys() {
    if ((!keys.known && !entries.known) || !document.body) return;
    var found = [];
    var walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
    for (var node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeValue.indexOf("-") < 0 || !node.parentElement) continue;
      if (node.parentElement.closest(UNLINKED)) continue;
      found.push(node);
    }
    var linked = false;
    found.forEach(function (text) { if (linkText(text)) linked = true; });
    if (!linked) return;
    markLit();
    // The same words in the same place: linking is not the body changing.
    sizeWatch.takeRecords();
    keyWatch.takeRecords();
    resize();
  }
  var keyWatch = new MutationObserver(function () {
    if (keys.known || entries.known) linkKeys();
    tagPictures();
    if (decorateDemos()) {
      // A demo the body's own script added: its button is part of that change.
      keyWatch.takeRecords();
    }
  });
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", decorateDemos, { once: true });
  else decorateDemos();
  keyWatch.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  function keyOf(link) {
    return link.getAttribute("data-inf-task");
  }
  function openKey(link) {
    post({ type: "task", gesture: "open", key: keyOf(link) });
  }
  function openEntry(link) {
    post({ type: "entry", id: link.getAttribute("data-inf-entry") });
  }
  function leaveKey() {
    var link = keys.rested;
    if (!link) return;
    keys.rested = null;
    post({ type: "task", gesture: "leave", key: keyOf(link) });
  }
  function restKey(link) {
    keys.rested = link;
    var box = link.getBoundingClientRect();
    post({ type: "task", gesture: "rest", key: keyOf(link), box: { top: box.top, right: box.right, bottom: box.bottom, left: box.left } });
  }
  function quietKey() {
    if (!keys.rested) return false;
    keys.quiet = keys.rested;
    leaveKey();
    return true;
  }
  document.addEventListener("pointerover", function (event) {
    var link = keyLink(event.target);
    // Coming in from outside the frame: the host has let go of whatever
    // rested, and the pointer has left any key it was asked to keep quiet.
    if (!event.relatedTarget) keys.quiet = null;
    if (link !== keys.rested) leaveKey();
    if (!link || link === keys.quiet) return;
    restKey(link);
  });
  document.addEventListener("pointerout", function (event) {
    var link = keyLink(event.target);
    if (!link || (event.relatedTarget && link.contains(event.relatedTarget))) return;
    if (link === keys.quiet) keys.quiet = null;
    if (link === keys.rested) leaveKey();
  });
  document.addEventListener("pointerdown", function (event) {
    if (keyLink(event.target)) quietKey();
  }, true);
  var quieted = null;
  document.addEventListener("keydown", function (event) {
    if (event.key === "Escape" && quietKey()) quieted = event;
    var link = keyLink(event.target);
    if (event.key === "Enter" && link && link === event.target) {
      event.preventDefault();
      openKey(link);
    }
    var reference = entryLink(event.target);
    if (event.key === "Enter" && reference && reference === event.target) {
      event.preventDefault();
      openEntry(reference);
    }
  }, true);
  // The keyboard rests on a key as the pointer does, and leaving it lets go.
  document.addEventListener("focusin", function (event) {
    var target = event.target;
    if (target && target.nodeType === 1 && target !== document.body) {
      held.element = target;
      held.start = null;
    }
    var link = keyLink(target);
    if (link !== keys.rested) leaveKey();
    if (!link || link !== target || link === keys.quiet || !link.matches(":focus-visible")) return;
    // Once the window has brought the key into view, where its summary goes.
    requestAnimationFrame(function () { requestAnimationFrame(function () {
      if (document.activeElement === link && keys.rested !== link) restKey(link);
    }); });
  }, true);
  document.addEventListener("focusout", function (event) {
    var target = event.target;
    // Focus that moved in a page whose process was not yet told it holds the
    // window's focus fired no focusin (Chromium sends it on the page's focus,
    // which a move to another page can pass by): the element focus leaves is
    // the one the page held, unless a press in the body moved it.
    if (target !== held.element && !pressing && target && target.nodeType === 1 && target !== document.body) {
      held.element = target;
    }
    if (target === held.element && typeof target.selectionStart === "number") {
      held.start = target.selectionStart;
      held.end = target.selectionEnd;
      held.direction = target.selectionDirection;
    } else if (target === held.element) {
      held.start = null;
    }
    var link = keyLink(target);
    if (!link) return;
    if (link === keys.quiet) keys.quiet = null;
    if (link === keys.rested) leaveKey();
  }, true);
  // A press elsewhere in the body leaves the field it held for whatever the
  // press focuses, in the same task as the press.
  var pressing = false;
  document.addEventListener("pointerdown", function (event) {
    if (held.element && !held.element.contains(event.target)) held.element = null;
    pressing = true;
    setTimeout(function () { pressing = false; });
  }, true);
  // The host gave the frame focus back (an overlay over the window closed):
  // the field it held takes it again, its caret where it was - unless focus
  // has moved on from the frame since (a command chosen in search moved it).
  function returnFocus() {
    var element = held.element;
    if (!document.hasFocus()) return;
    if (!element || !element.isConnected || element.disabled || boxless(element)) return;
    element.focus({ preventScroll: true });
    if (held.start !== null && typeof element.setSelectionRange === "function") {
      try { element.setSelectionRange(held.start, held.end, held.direction || "none"); } catch (error) {}
    }
  }
  // After the body's own handlers: a picture opens on Enter or Space, and
  // an Escape nothing in the body used leaves the body for its card.
  document.addEventListener("keydown", function (event) {
    if (event.defaultPrevented || event.isComposing) return;
    var target = event.target;
    if ((event.key === "Enter" || event.key === " ") && target && target.nodeType === 1 && target.hasAttribute("data-inf-picture")) {
      event.preventDefault();
      if (!event.repeat) openPicture(target);
      return;
    }
    if (event.key !== "Escape" || !caps.escape || event.repeat || quieted === event) return;
    if (document.querySelector("dialog:modal, :popover-open")) return;
    if (target && target.tagName === "INPUT" && target.type === "search" && target.value !== "") return;
    post({ type: "escape" });
  });
  document.addEventListener("scroll", leaveKey, true);
  new ResizeObserver(resize).observe(document.documentElement);
  window.addEventListener("load", resize);
  ["click", "focusin", "input", "keydown"].forEach(function (type) {
    document.addEventListener(type, function () { post({ type: "interaction" }); }, true);
  });
  // The window's focus moving between two frames passes the page by: each
  // frame says when its own window gains or loses it. Heard before any
  // script of the body's and sent through what the bridge held from its
  // start, so the body cannot keep its frame from saying it.
  var host = window.parent;
  var apply = Reflect.apply;
  var targetOf = Object.getOwnPropertyDescriptor(Event.prototype, "target").get;
  ["focus", "blur"].forEach(function (type) {
    window.addEventListener(type, function (event) {
      if (apply(targetOf, event, []) !== window) return;
      host.postMessage({ fm: VERSION, type: "focused", document: documentId, focused: type === "focus" }, "*");
    }, true);
  });
  // A press beginning in the frame passes the page by too: the frame says
  // so, the same way, before the press's own click or key is sent.
  var repeatOf = Object.getOwnPropertyDescriptor(KeyboardEvent.prototype, "repeat").get;
  window.addEventListener("pointerdown", function () {
    host.postMessage({ fm: VERSION, type: "pressed", document: documentId }, "*");
  }, true);
  window.addEventListener("keydown", function (event) {
    if (apply(repeatOf, event, [])) return;
    host.postMessage({ fm: VERSION, type: "pressed", document: documentId }, "*");
  }, true);
  post({ type: "ready" });
})();`,wu="sha256-Vl4bwle532/4bhsb43205qEDzVCqPtZ8SN3734s5aiY=",me=f().int().positive().max(Number.MAX_SAFE_INTEGER),U=m(Cr),yu=["get","set","delete","list"],Ur=128,bu=T("verb",[p({verb:m("subscribe"),sub:me,read:a().min(1).max(64),args:L(a(),ee()).default({})}),p({verb:m("unsubscribe"),sub:me}),p({verb:m("action"),action:a().min(1).max(200),value:ee().optional()}),p({verb:m("fetch"),alias:a().min(1).max(32),request:Nr}),p({verb:m("store"),op:h(yu),key:a().min(1).max(Ur).optional(),value:ee().optional(),prefix:a().max(Ur).optional()})]),Pr=p({src:a().min(1).max(fu),alt:a().max(pu),width:f().int().nonnegative(),height:f().int().nonnegative()}),Be=f().int().nonnegative().max(De),ku=rr.extend({written:a().min(1).max(nr).optional()}),_u=p({answered:Be,of:Be,changed:Be,picked:Be,answers:v(ku).max(De)}),xu=["rest","leave","open"],Su=p({top:f().finite(),right:f().finite(),bottom:f().finite(),left:f().finite()}),Eu=T("type",[p({fm:U,type:m("revealed"),document:a(),seq:me,offerId:a().min(1).max(64),top:f().finite().nonnegative().max(1e6).optional(),height:f().finite().nonnegative().max(1e6).optional()}),p({fm:U,type:m("ready"),document:a().optional()}),p({fm:U,type:m("request"),id:me}).loose(),p({fm:U,type:m("resize"),height:f().finite().nonnegative(),document:a().optional(),width:f().finite().nonnegative().optional(),initialized:x().optional(),live:x().optional(),held:x().optional()}),p({fm:U,type:m("link"),href:a().min(1).max(2048)}),p({fm:U,type:m("draft"),document:a(),text:a().min(1).max(gu).regex(/^[^\r\n]*$/)}),p({fm:U,type:m("image"),index:f().int().nonnegative(),pictures:v(Pr).min(1).max(du)}),p({fm:U,type:m("demo"),src:a().min(1).max(hu),poster:Pr,caption:a().max(Rr),durationMs:f().int().nonnegative(),play:x()}),p({fm:U,type:m("interaction"),document:a()}),p({fm:U,type:m("focused"),document:a(),focused:x()}),p({fm:U,type:m("pressed"),document:a()}),p({fm:U,type:m("escape"),document:a()}),p({fm:U,type:m("task"),document:a(),gesture:h(xu),key:a().regex(_l),box:Su.optional()}),p({fm:U,type:m("entry"),document:a(),id:a().regex(wl)}),p({fm:U,type:m("pong"),seq:me}),_u.extend({fm:U,type:m("answers"),seq:me.optional(),questions:ee().optional(),questionsGap:ir.optional()})]),re="app-frame",Au="images",zu="media",Ou={mp4:"video/mp4",gif:"image/gif"},Iu={png:"image/png",jpg:"image/jpeg",webp:"image/webp"},Tu=/^([A-Za-z0-9_-]{1,64})-([0-9a-f]{32})\.(png|jpg|webp)$/,$u=/^([A-Za-z0-9_-]{1,64})-([0-9a-f]{32})\.(mp4|gif)$/;function Nu(e){const t=Tu.exec(e);if(!t)return;const[,n,,r]=t;if(!(!n||!r))return{taskId:n,fileName:e,contentType:Iu[r]}}function Cu(e){const t=$u.exec(e);if(!t)return;const[,n,,r]=t;if(!n||!r)return;const o=r;return{taskId:n,fileName:e,kind:o,contentType:Ou[o]}}function Ru(e){const t=`${re}://${zu}/`;return e.startsWith(t)?Cu(e.slice(t.length))?.kind:void 0}const Uu=new RegExp(`data-(?:${Ze.join("|")})-demo="([^"]*)"`,"g");function Pu(e){return Ru(e)!==void 0}function Zu(e){const t=new Set;for(const n of e.matchAll(Uu)){const r=n[1]??"";Pu(r)&&t.add(r)}return t}const Du=/^data:image\/(png|jpeg|gif|webp)[;,]/;function Zr(e){if(Du.test(e))return!0;const t=`${re}://${Au}/`;return e.startsWith(t)&&Nu(e.slice(t.length))!==void 0}function Dr(e,t){const n=t[e];if(!n||!Zr(n.src))return;const r=t.filter(o=>Zr(o.src));return{index:r.indexOf(n),pictures:r}}const Mu=["allow-scripts"].join(" "),Fu=`${re}:`,Lu=`${re}://fonts`,qu=`data: ${re}:`;function Ot(e=[],t=Fu){const n=[wu,...e].map(r=>`'${r}'`).join(" ");return`default-src 'none'; style-src 'unsafe-inline'; font-src ${t}; img-src ${qu}; script-src ${n}`}Ot(),Ot([],Lu);const ju=/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,oe=a().min(2).max(48).regex(ju),Bu=["yours","installed"],It=128,_e=["computers.resources","quota.snapshot","tasks.board","tasks.detail","tasks.search","feed.recent","forge.changes","automation.list","knowledge.collections","knowledge.graph","knowledge.concepts","knowledge.directions","knowledge.findings","knowledge.entry","knowledge.direction"],Mr=h(_e),xe=Fn(()=>F([Pe(),x(),f().finite(),a(),v(xe),L(a(),xe)])),Wu=p({key:a(),value:xe,updatedAt:f()}),Ju=F([g({always:m(!0)}),g({store:a().min(1).max(It),when:m("nonEmpty")}),g({code:m(!0)})]),Fr=g({x:h(["left","right"]),y:h(["top","bottom"])}),Lr=a().min(1).max(32).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/,"kebab-case alias"),qr=v(h(ke)).min(1).max(ke.length).optional(),Vu=F([g({origin:a().refine(Ir,"an exact https origin (no path, wildcard, or private host)"),methods:qr}),g({userSupplied:m(!0),methods:qr})]),Gu=g({kind:h(["bearer","basic","header"]),label:a().min(1).max(80),header:a().min(1).max(64).regex(/^[A-Za-z0-9-]+$/).optional()});g({api:m(1,"this panel is written for a version of the panel API this app does not serve").optional(),name:a().min(1).max(40).optional(),version:a().regex(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/,"semver").optional(),title:a().min(1).max(40).optional(),placement:Fr.optional(),order:f().int().min(0).max(1e3).optional(),size:h(["content","fill"]).optional(),newestLast:x().optional(),presence:Ju.optional(),cards:_t.optional(),header:xt.optional(),commands:St.optional(),reads:v(Mr).max(_e.length).optional(),moves:m(!0).optional(),sql:v(ye).max(64).optional(),net:g({origins:L(Lr,Vu)}).optional(),secrets:L(Lr,Gu).optional(),storage:g({kv:g({maxBytes:f().int().positive().max(Or)})}).optional(),origin:g({taskId:a().min(1).max(64).optional()}).optional()}),new Set(_e),new Set(gr);const Ku=p({stage:h(["manifest","panel","server"]),message:a()}),jr=p({id:oe,source:h(Bu),by:a().min(1).max(40).nullable(),title:a().min(1).max(40),placement:Fr,order:f().int(),size:h(["content","fill"]),newestLast:x().optional(),present:x(),ownPresence:x(),moves:x(),running:x(),reads:v(Mr),sql:v(ye),panel:p({url:a(),version:a()}).nullable(),frame:p({version:a()}).nullable(),cardViews:v(a().regex(be)).max(Le),cards:_t,header:xt,commands:St,server:p({actions:v(a()),background:v(p({id:a(),everyMs:f()}))}).nullable(),error:Ku.nullable()});p({extensions:v(jr),drafts:v(jr).optional()}),p({extensionId:oe,key:a(),draft:m(!0).optional()});const Tt=a().min(1).max(It),Se=m(!0).optional();T("op",[p({op:m("get"),extensionId:oe,key:Tt,draft:Se}),p({op:m("set"),extensionId:oe,key:Tt,value:xe,draft:Se}),p({op:m("delete"),extensionId:oe,key:Tt,draft:Se}),p({op:m("list"),extensionId:oe,prefix:a().max(It).optional(),draft:Se})]),p({value:xe.optional(),entries:v(Wu).optional()}),p({draft:Se}),F([p({ok:m(!0),result:ee()}),p({ok:m(!1),error:a()})]);const Hu=["activity","automation","knowledge","now"],We=524288;function $t(e){const t=new RegExp(`</${e}`,"i");return n=>!t.test(n)}const Xu=g({html:a().max(We).refine($t("body"),"a </body> tag"),script:a().min(1).max(We).refine($t("script"),"a <\/script> tag").optional()}),Yu=g({html:a().max(We)}),Qu=h(["dark","light"]),Nt=g({title:a().min(1).max(120),theme:Qu,style:a().max(We).refine($t("style"),"a </style> tag")}),ed=Nt.extend({template:Xu,kind:hc().optional()}),td=Nt.extend({template:Yu,kind:m("card")}),nd=T("source",[g({source:m("builtin"),id:h(Hu),view:a().regex(be).optional()}),g({source:m("installed"),id:oe,version:a().regex(/^[0-9a-f]{16}$/),view:a().regex(be).optional()})]),rd=g({id:a().min(1).max(64).regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/),reads:v(h(_e)).max(_e.length),sql:v(ye).max(64),card:g({id:Ar}).optional(),moves:x().optional()}),od=Nt.extend({kind:m("panel"),panel:nd,config:rd});F([td,od,ed]),p({mountId:a().min(1).max(64),url:a().startsWith(`${re}://`)});function id(e){return`${re}://fonts/${e}`}function Ct(e){return e.replaceAll("&","&amp;").replaceAll('"',"&quot;").replaceAll("<","&lt;")}function ad(e){const t=Ct(e.theme);return["<!doctype html>",`<html data-theme="${t}"${e.held?" data-inf-held":""}>`,"<head>",`<meta http-equiv="Content-Security-Policy" content="${Ct(e.csp)}">`,'<meta charset="utf-8">',...e.title?[`<title>${Ct(e.title)}</title>`]:[],`<style>${e.style}</style>`,`<script>${vu}<\/script>`,"</head>",`<body data-theme="${t}">`,e.html,...e.script?[`<script>${e.script}<\/script>`]:[],"</body>","</html>"].join(`
`)}const sd=/https?:\/\/[^\s<>"'`]+/gi;function Rt(e,t,n){let r=0;for(const o of e)o===t?r+=1:o===n&&(r-=1);return r<0}function cd(e){let t=e,n="";for(;t.length>0;){const r=t[t.length-1];if(!r||!(/[.,;:!?']/.test(r)||r===")"&&Rt(t,"(",")")||r==="]"&&Rt(t,"[","]")||r==="}"&&Rt(t,"{","}")))break;t=t.slice(0,-1),n=r+n}return{url:t,trailing:n}}function ld(e){try{const t=new URL(e);return t.protocol==="http:"||t.protocol==="https:"}catch{return!1}}function ud(e){try{const t=new URL(e);if(t.protocol==="https:")return!0;if(t.protocol==="http:"){const n=t.hostname.toLowerCase();return n==="localhost"||n.endsWith(".localhost")||n==="127.0.0.1"||n==="::1"||n==="[::1]"}return!1}catch{return!1}}function dd(e){const t=[];let n=0;for(const r of e.matchAll(sd)){const o=r.index??0,{url:s}=cd(r[0]);!s||!ld(s)||(o>n&&t.push({type:"text",value:e.slice(n,o)}),t.push({type:"url",value:s}),n=o+s.length)}return n<e.length&&t.push({type:"text",value:e.slice(n)}),t}const fd=`/* Shared by the shell and frame documents; no geometry or close choreography. */
[data-in-place-reveal="drift"] {
  animation: in-place-reveal var(--dur-fast) var(--ease-out);
}
[data-in-place-reveal="fade"] {
  animation: in-place-fade var(--dur-fast) var(--ease-out);
}
@keyframes in-place-reveal {
  from {
    opacity: 0;
    transform: translateY(calc(-1 * var(--space-1)));
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
@keyframes in-place-fade {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}
/* Native details owns the hidden body, including bare text. No wrappers or
   author-script changes. Initial open markup has no previous style and is
   static; only a closed-to-open change transitions. Close removes transition.
   Content visibility never transitions: an opening one starts from hidden
   until the animation's first frame, and its controls cannot take focus. */
details::details-content {
  opacity: 0;
  transform: translateY(calc(-1 * var(--space-1)));
}
details[open]::details-content {
  opacity: 1;
  transform: translateY(0);
  transition:
    opacity var(--dur-fast) var(--ease-out),
    transform var(--dur-fast) var(--ease-out);
}
`,pd=`/* Infinitary — color system. Dark ("deep space") is the default theme; light opts in via [data-theme="light"]. */
:root {
  /* base */
  --bg-0: #05070d; /* void — the opaque fallback behind --material-tint */
  --material-tint: rgba(5, 7, 13, 1); /* opaque tint mixed toward clear by wash percentage */
  --bg-1: #0a0e18; /* surface — panels, input shell */
  --bg-2: #0f1424; /* raised — cards */
  --bg-3: #161c30; /* overlay hover */
  --line-1: rgba(150, 180, 255, 0.2); /* hairline borders, set for the material */
  --line-2: rgba(150, 180, 255, 0.24); /* focused / active borders */
  --fg-1: #e9eef8; /* primary text */
  --fg-2: #98a4bd; /* secondary text */
  --fg-3: #7a86a0; /* tertiary / placeholder, lifted for the material */
  /* accent — ice cyan, the Firstmate's light */
  --accent: #7fdcff;
  --accent-strong: #38aae6;
  --accent-dim: rgba(127, 220, 255, 0.14);
  --accent-glow: rgba(127, 220, 255, 0.35);
  /* semantic — two chromatic families only: ice cyan (calm) and ember (hot) */
  --ok: #7fdcff; /* calm cyan — done, pace ahead (same family as accent) */
  --ok-dim: rgba(127, 220, 255, 0.14);
  --hot: #ffa257; /* ember — the one hot color: energy, sun, fire */
  --hot-dim: rgba(255, 162, 87, 0.14);
  --hot-glow: rgba(255, 148, 66, 0.35);
  --warn: #ffa257; /* attention, pace behind — ember */
  --warn-dim: rgba(255, 162, 87, 0.14);
  --danger: #ff6b52; /* lava — errors, exhausted quota (hot family, redder) */
  --danger-dim: rgba(255, 107, 82, 0.12);
  --captain: #b99aff; /* violet — the captain's own activity */
  --captain-dim: rgba(185, 154, 255, 0.14);
  --idle: #5d6884; /* dormant crewmates, inactive */
  /* intelligence slots - celestial: supernova (lava) / sun / earth / moon.
     supernova sits above the sun and is the one slot the app never reaches
     for on its own. --bucket-* aliases keep older mocks working. */
  --slot-premium: #ff6b52;
  --slot-high: #ffa257;
  --slot-medium: #7fdcff;
  --slot-low: #8a93a8;
  --bucket-premium: var(--slot-premium);
  --bucket-high: var(--slot-high);
  --bucket-medium: var(--slot-medium);
  --bucket-low: var(--slot-low);
  /* wireframe characters (canvas) */
  --wire-accent: #7fdcff;
  --wire-hot: #ffa257;
  --wire-dim: #2e6a8c; /* far side — same cyan family, darker */
  --wire-boost: 1; /* @kind other */ /* alpha multiplier — raised in light theme where thin lines wash out */
  --halo-boost: 1.2; /* @kind other */ /* the Firstmate's halo, lifted so it reads over the material */
  color-scheme: dark;
}
[data-theme="light"] {
  --bg-0: #eef1f7;
  --material-tint: rgba(238, 241, 247, 1);
  --bg-1: #f7f9fc;
  --bg-2: #ffffff;
  --bg-3: #e7ecf5;
  --line-1: rgba(30, 50, 90, 0.18);
  --line-2: rgba(30, 50, 90, 0.26);
  --fg-1: #151b2b;
  --fg-2: #4d5a75;
  --fg-3: #6c7891;
  --accent: #0e8fd0;
  --accent-strong: #0a72a8;
  --accent-dim: rgba(14, 143, 208, 0.1);
  --accent-glow: rgba(14, 143, 208, 0.25);
  --ok: #0e8fd0;
  --ok-dim: rgba(14, 143, 208, 0.1);
  --hot: #d97a1f;
  --hot-dim: rgba(217, 122, 31, 0.12);
  --hot-glow: rgba(217, 122, 31, 0.28);
  --warn: #d97a1f;
  --warn-dim: rgba(217, 122, 31, 0.12);
  --danger: #cf4a2e;
  --danger-dim: rgba(207, 74, 46, 0.1);
  --captain: #7254c9;
  --captain-dim: rgba(114, 84, 201, 0.12);
  --idle: #8b96ad;
  --slot-premium: #cf4a2e;
  --slot-high: #d97a1f;
  --slot-medium: #0e8fd0;
  --slot-low: #8b96ad;
  --bucket-premium: var(--slot-premium);
  --bucket-high: var(--slot-high);
  --bucket-medium: var(--slot-medium);
  --bucket-low: var(--slot-low);
  --wire-accent: #0a72a8;
  --wire-hot: #e8760a;
  --wire-dim: #82b4cf; /* far side — same cyan family, lighter/desaturated */
  --wire-boost: 1.4; /* @kind other */
  --halo-boost: 1.2; /* @kind other */
  color-scheme: light;
}
/* Semantic aliases — declared on BOTH theme scopes so var() re-resolves inside [data-theme="light"] (aliases declared only on :root would freeze to dark values). */
:root,
[data-theme="light"] {
  --surface-card: var(--bg-2);
  --surface-input: var(--bg-1);
  --text-body: var(--fg-1);
  --text-muted: var(--fg-2);
  --text-faint: var(--fg-3);
  --focus-ring: 0 0 0 1px var(--line-2), 0 0 24px -6px var(--accent-glow);
  /* The same ring, drawn inside an edge that cuts it. */
  --focus-ring-inset: inset 0 0 0 1px var(--line-2), inset 0 0 24px -6px var(--accent-glow);
}
`,md=`/* Infinitary — radii, shadows, glow, blur, motion. */
:root {
  --radius-xs: 3px; /* small controls: a 14-16px box that must read square, not round */
  --radius-s: 6px; /* badges, keycaps */
  --radius-m: 10px; /* buttons, inputs */
  --radius-l: 16px; /* cards, panels */
  --radius-pill: 999px; /* voice input shell, pills */
  --shadow-1: 0 1px 2px rgba(0, 0, 0, 0.35);
  --shadow-2: 0 8px 30px -12px rgba(0, 0, 0, 0.6);
  --shadow-card: 0 12px 40px -16px rgba(0, 0, 0, 0.65), 0 1px 0 rgba(150, 180, 255, 0.06) inset;
  --glow-accent: 0 0 32px -8px var(--accent-glow);
  /* solid card material (legacy acrylic token names) */
  --acrylic-bg: var(--bg-2);
  --acrylic-blur: none; /* @kind other */
  --acrylic-border: var(--line-1);
  --acrylic-shadow: inset 0 1px 0 rgba(255, 255, 255, 0.1), 0 24px 48px -24px rgba(0, 0, 0, 0.6);
  --blur-overlay: blur(16px); /* @kind other */
  /* motion — 160 in place, 360 for a surface, 700 for a dissolve; the card
     stack, popovers, summaries and button labels have their own moves below */
  --ease-drift: cubic-bezier(0.25, 0.1, 0.25, 1); /* @kind other */
  --ease-out: cubic-bezier(0.32, 0.72, 0, 1); /* @kind other — the glide */
  --dur-fast: 160ms; /* @kind other */
  --dur-med: 360ms; /* @kind other */
  --dur-slow: 700ms; /* @kind other */
  --dur-fade: 160ms; /* @kind other — opacity-only opt-in, also under reduced motion */
  --dur-quick: 200ms; /* @kind other — a popover grows, a summary slides or moves, a closed card drops away */
  --dur-page: 300ms; /* @kind other — a card pages in, or comes forward after a close */
  --dur-arrive: 420ms; /* @kind other — a card arrives on an empty stage */
  --dur-popover-out: 120ms; /* @kind other */
  --dur-summary-out: 100ms; /* @kind other */
  --delay-label: 500ms; /* @kind other — the first icon-button label waits this long */
  --move-page: 32px; /* @kind other — paging slides this far, with the arrow */
  --move-arrive: 12px; /* @kind other */
  --move-drop: 10px; /* @kind other — a closed card drops this far */
  --move-stack: 8px; /* @kind other — the next card comes forward from this far up */
  --move-summary: 8px; /* @kind other — a summary slides this far from what it describes */
  --scale-arrive: 0.98; /* @kind other */
  --scale-stack: 0.97; /* @kind other — a card behind the shown one */
  --scale-pop: 0.94; /* @kind other — a popover grows from this size */
}
[data-theme="light"] {
  --shadow-1: 0 1px 2px rgba(20, 30, 60, 0.1);
  --shadow-2: 0 8px 30px -12px rgba(20, 30, 60, 0.18);
  --shadow-card: 0 12px 40px -16px rgba(20, 30, 60, 0.22);
  --acrylic-bg: var(--bg-2);
  --acrylic-blur: none; /* @kind other */
  --acrylic-border: var(--line-1);
  --acrylic-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9), 0 12px 32px -12px rgba(20, 30, 60, 0.28),
    0 2px 8px -2px rgba(20, 30, 60, 0.1);
}

/* Shared by the shell and every frame. Character motion has its own guard.
   Only short, explicitly opted-in opacity fades survive. */
@media (prefers-reduced-motion: reduce) {
  :root {
    --dur-fast: 0ms;
    --dur-med: 0ms;
    --dur-slow: 0ms;
    --dur-quick: 0ms;
    --dur-page: 0ms;
    --dur-arrive: 0ms;
    --dur-popover-out: 0ms;
    --dur-summary-out: 0ms;
  }
}
`,hd=`/* Infinitary webfonts - Space Grotesk (UI/display) + JetBrains Mono (data/code).
   Vendored locally from Google Fonts (SIL Open Font License 1.1) so the package is offline-complete.
   Binaries live in assets/fonts/; regenerate by re-fetching the css2 URL below with a woff2-capable UA.
   https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@300..700&family=JetBrains+Mono:ital,wght@0,300..700;1,300..700&display=swap */
/* JetBrains Mono italic cyrillic-ext */
@font-face {
  font-family: "JetBrains Mono";
  font-style: italic;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-italic-cyrillic-ext.woff2) format("woff2");
  unicode-range: U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F;
}
/* JetBrains Mono italic cyrillic */
@font-face {
  font-family: "JetBrains Mono";
  font-style: italic;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-italic-cyrillic.woff2) format("woff2");
  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
/* JetBrains Mono italic greek */
@font-face {
  font-family: "JetBrains Mono";
  font-style: italic;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-italic-greek.woff2) format("woff2");
  unicode-range: U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF;
}
/* JetBrains Mono italic vietnamese */
@font-face {
  font-family: "JetBrains Mono";
  font-style: italic;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-italic-vietnamese.woff2) format("woff2");
  unicode-range:
    U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB;
}
/* JetBrains Mono italic latin-ext */
@font-face {
  font-family: "JetBrains Mono";
  font-style: italic;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-italic-latin-ext.woff2) format("woff2");
  unicode-range:
    U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
/* JetBrains Mono italic latin */
@font-face {
  font-family: "JetBrains Mono";
  font-style: italic;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-italic-latin.woff2) format("woff2");
  unicode-range:
    U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* JetBrains Mono normal cyrillic-ext */
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-normal-cyrillic-ext.woff2) format("woff2");
  unicode-range: U+0460-052F, U+1C80-1C8A, U+20B4, U+2DE0-2DFF, U+A640-A69F, U+FE2E-FE2F;
}
/* JetBrains Mono normal cyrillic */
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-normal-cyrillic.woff2) format("woff2");
  unicode-range: U+0301, U+0400-045F, U+0490-0491, U+04B0-04B1, U+2116;
}
/* JetBrains Mono normal greek */
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-normal-greek.woff2) format("woff2");
  unicode-range: U+0370-0377, U+037A-037F, U+0384-038A, U+038C, U+038E-03A1, U+03A3-03FF;
}
/* JetBrains Mono normal vietnamese */
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-normal-vietnamese.woff2) format("woff2");
  unicode-range:
    U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB;
}
/* JetBrains Mono normal latin-ext */
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-normal-latin-ext.woff2) format("woff2");
  unicode-range:
    U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
/* JetBrains Mono normal latin */
@font-face {
  font-family: "JetBrains Mono";
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/jetbrainsmono-normal-latin.woff2) format("woff2");
  unicode-range:
    U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
/* Space Grotesk normal vietnamese */
@font-face {
  font-family: "Space Grotesk";
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/spacegrotesk-vietnamese.woff2) format("woff2");
  unicode-range:
    U+0102-0103, U+0110-0111, U+0128-0129, U+0168-0169, U+01A0-01A1, U+01AF-01B0, U+0300-0301, U+0303-0304, U+0308-0309, U+0323, U+0329, U+1EA0-1EF9, U+20AB;
}
/* Space Grotesk normal latin-ext */
@font-face {
  font-family: "Space Grotesk";
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/spacegrotesk-latin-ext.woff2) format("woff2");
  unicode-range:
    U+0100-02BA, U+02BD-02C5, U+02C7-02CC, U+02CE-02D7, U+02DD-02FF, U+0304, U+0308, U+0329, U+1D00-1DBF, U+1E00-1E9F, U+1EF2-1EFF, U+2020, U+20A0-20AB, U+20AD-20C0, U+2113, U+2C60-2C7F, U+A720-A7FF;
}
/* Space Grotesk normal latin */
@font-face {
  font-family: "Space Grotesk";
  font-style: normal;
  font-weight: 300 700;
  font-display: swap;
  src: url(../assets/fonts/spacegrotesk-latin.woff2) format("woff2");
  unicode-range:
    U+0000-00FF, U+0131, U+0152-0153, U+02BB-02BC, U+02C6, U+02DA, U+02DC, U+0304, U+0308, U+0329, U+2000-206F, U+20AC, U+2122, U+2191, U+2193, U+2212, U+2215, U+FEFF, U+FFFD;
}
`,gd=`/* Infinitary — spacing scale (4px base). Generous whitespace is the default; density is the exception. */
:root {
  --space-1: 4px;
  --space-2: 8px;
  --space-3: 12px;
  --space-4: 16px;
  --space-5: 24px;
  --space-6: 32px;
  --space-7: 48px;
  --space-8: 64px;
  --space-9: 96px;
  /* layout - dock rails are at least one fifth of the window, not resizable */
  --rail-width: max(300px, 20vw);
  /* layout - the voice input: one line is the pill, and the radius stays half of it at every height */
  --prompt-height: calc(var(--space-7) + var(--space-1));
  --prompt-radius: calc(var(--prompt-height) / 2);
  /* layout - a card's reply field: one line of --text-sm is the pill (2px is its hairline), and the radius stays half of it at every height */
  --reply-height: calc(var(--text-sm) * var(--leading-body) + 2 * var(--space-2) + 2px);
  --reply-radius: calc(var(--reply-height) / 2);
}
`,vd=`/* Infinitary — typography. Space Grotesk for UI and display, JetBrains Mono for data, keybinds, code. */
:root {
  --font-ui: "Space Grotesk", system-ui, sans-serif;
  --font-mono: "JetBrains Mono", ui-monospace, monospace;
  --text-xs: 11px; /* micro labels, uppercase tracked */
  --text-sm: 12.5px; /* secondary, metadata */
  --text-base: 14px; /* body */
  --text-md: 16px; /* card titles, input text */
  --text-lg: 20px; /* section titles */
  --text-xl: 28px; /* card headlines */
  --text-display: 44px; /* null-state greeting */
  --leading-tight: 1.15;
  --leading-body: 1.55;
  --tracking-label: 0.09em; /* uppercase micro labels */
  --tracking-display: -0.02em;
  --weight-light: 300;
  --weight-regular: 400;
  --weight-medium: 500;
  --weight-semibold: 600;
}
body {
  font-family: var(--font-ui);
  font-size: var(--text-base);
  line-height: var(--leading-body);
  color: var(--text-body);
  background: var(--bg-0);
  -webkit-font-smoothing: antialiased;
}
a {
  color: var(--accent);
  text-decoration: none;
}
a:hover {
  color: var(--accent-strong);
}
`,wd=/url\(\s*['"]?\.\.\/assets\/fonts\/([A-Za-z0-9._-]+)['"]?\s*\)/g;function yd(e=hd){return e.replaceAll(wd,(t,n)=>`url(${id(n)})`)}const bd=`
  * { box-sizing: border-box; }
  html, body { margin: 0; padding: 0; }
  body {
    font-family: var(--font-ui);
    font-size: var(--text-base);
    line-height: var(--leading-body);
    color: var(--fg-2);
    background: transparent;
    padding: var(--space-1);
  }
  h1, h2, h3, h4, h5, h6 { color: var(--fg-1); font-weight: 500; letter-spacing: var(--tracking-display); line-height: var(--leading-tight); margin: 0 0 var(--space-2); }
  h1 { font-size: var(--text-lg); }
  h2 { font-size: var(--text-md); }
  h3, h4 { font-size: var(--text-base); }
  h4 { color: var(--fg-2); }
  h5 { font-size: var(--text-sm); }
  h6 { font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; }
  p, ul, ol, pre, blockquote, figure, dl, table, details { margin: 0 0 var(--space-2); }
  figcaption { font-size: var(--text-sm); color: var(--fg-3); margin-top: var(--space-1); }
  mark { color: var(--fg-1); background: var(--accent-dim); border-radius: var(--radius-xs); padding: 0 var(--space-1); }
  kbd {
    font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-2);
    background: var(--bg-3); border: 1px solid var(--line-1); border-bottom-width: 2px;
    border-radius: var(--radius-s); padding: 0 var(--space-1);
  }
  details { border: 1px solid var(--line-1); border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); }
  summary {
    display: flex; align-items: center; gap: var(--space-2); list-style: none; cursor: pointer;
    color: var(--fg-1); font-weight: 500;
  }
  summary::-webkit-details-marker { display: none; }
  summary::before {
    content: ""; flex: none; border-left: 5px solid var(--fg-3);
    border-top: 4px solid transparent; border-bottom: 4px solid transparent;
    transition: transform var(--dur-fast) var(--ease-out);
  }
  summary:hover::before { border-left-color: var(--fg-1); }
  details[open] > summary { margin-bottom: var(--space-2); }
  details[open] > summary::before { transform: rotate(90deg); }
  details > :last-child { margin-bottom: 0; }
  svg { max-width: 100%; height: auto; color: var(--fg-2); fill: currentColor; font-family: var(--font-ui); font-size: var(--text-sm); }
  /* Inherited fill closes an open bend into a triangle. Leave intentional
     fills on paths (including arrowheads) and labels/shapes untouched. */
  svg :is(path, polyline, line):not([fill]):not([style*="fill"]) { fill: none; }
  body > svg, figure > svg, details > svg { display: block; }
  body > svg, details > svg { margin: 0 0 var(--space-2); }
  /* A picture never reaches past the body; one that would stand taller than
     360 px shrinks to fit 360 px, whole, letterboxed on --bg-1. A click opens
     it in the picture viewer (the bridge's image message), unless it sits in
     a control, which owns the click. */
  img {
    display: block; max-width: 100%; height: auto;
    max-height: 360px; object-fit: contain; background: var(--bg-1);
    cursor: zoom-in;
  }
  :is(a, button, summary, label, [data-inf-action]) img { cursor: inherit; }
  body > img, details > img { margin: 0 0 var(--space-2); }
  /* A group of pictures (card pictures, phase 2; layout C, lead and strip):
     <figure class="inf-pictures"> around several <img>. The first leads under
     the plain img rule, alone on its line; the rest are 88 x 60 thumbnails
     cropped to their top; five show, and past that a mono "+N" tile counts
     the ones not shown. The author's figcaption is the group's caption. All
     of it is this stylesheet, so a group a body builds from its own data:
     pictures looks the same as one the host verified. */
  .inf-pictures {
    display: flex; flex-wrap: wrap; align-items: flex-start; column-gap: var(--space-2);
    position: relative; margin: 0; counter-reset: inf-pictures-more;
  }
  .inf-pictures > img { flex: none; margin: 0 0 var(--space-2); }
  .inf-pictures > img:first-of-type { order: -2; }
  /* The line break after the lead: an empty line of its own. */
  .inf-pictures::before { content: ""; order: -1; flex: 0 0 100%; height: 0; }
  .inf-pictures > img:nth-of-type(n+2) {
    box-sizing: border-box; width: 88px; height: 60px; max-height: none;
    object-fit: cover; object-position: top;
    border: 1px solid var(--line-1); border-radius: var(--radius-s);
  }
  /* Past the fifth thumbnail a picture is not shown, but still counted and
     still read by a screen reader. */
  .inf-pictures > img:nth-of-type(n+7) {
    position: absolute; width: 1px; height: 1px; margin: 0; border: 0; overflow: hidden;
    clip-path: inset(50%); counter-increment: inf-pictures-more;
  }
  /* The tile takes what is left of the last thumbnail's line, up to a
     thumbnail's width, so it stays beside the fifth instead of wrapping. A
     click on it opens the group at the first picture it counts. */
  .inf-pictures:has(> img:nth-of-type(7))::after {
    content: "+" counter(inf-pictures-more); flex: 1 1 0; box-sizing: border-box;
    min-width: 28px; max-width: 88px; height: 60px; margin: 0 0 var(--space-2);
    display: flex; align-items: center; justify-content: center;
    font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-1);
    background: var(--bg-1); border: 1px solid var(--line-1); border-radius: var(--radius-s);
    cursor: zoom-in;
  }
  .inf-pictures > figcaption { order: 1; flex: 0 0 100%; margin: 0 0 var(--space-2); }
  /* A demo (docs/card-authoring.md "Demo recordings"): its poster shows like
     any picture, and the bridge draws one Play button under it, with the
     recording's length, which opens the viewer playing it. Nothing in the
     body moves. */
  [data-inf-demo-play] {
    display: flex; align-items: center; gap: var(--space-2); width: max-content;
    margin: var(--space-2) 0 0; background: var(--bg-2);
  }
  [data-inf-demo-play]::before {
    content: ""; flex: none; width: 0; height: 0;
    border-style: solid; border-width: 5px 0 5px 8px;
    border-color: transparent transparent transparent currentColor;
  }
  /* Something new (card pictures, contract v4.69): a figure marked
     data-inf-new carries a mono New tag over its first corner, so a picture
     with no before reads as new, never as an omission. */
  [data-inf-new] { position: relative; }
  [data-inf-new]::before {
    content: "New"; position: absolute; top: var(--space-1); left: var(--space-1); z-index: 1;
    padding: 1px var(--space-1); pointer-events: none;
    font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-1);
    background: var(--accent-dim); border: 1px solid var(--accent); border-radius: var(--radius-s);
  }
  /* One picture per theme (the startup note's hero pairs, docs/release-notes.md):
     an element marked data-inf-theme shows only while the frame is in that
     theme, so a dark and a light picture of one view swap when the theme does. */
  :root:not([data-theme="light"]) [data-inf-theme="light"],
  :root[data-theme="light"] [data-inf-theme="dark"] { display: none; }
  ul, ol { padding-left: var(--space-4); }
  li + li { margin-top: var(--space-1); }
  a { color: var(--accent); text-decoration: underline; text-underline-offset: 2px; }
  /* A task key the bridge linked (FI3-594) reads as a link in the words around it;
     resting on it marks it with a row's hover surface while its summary is open,
     and so does a rest on the same task elsewhere in the window (data-inf-lit, INF-237). */
  a[data-inf-task] { cursor: pointer; border-radius: var(--radius-s); }
  a[data-inf-task]:hover, a[data-inf-task][data-inf-lit] { background: var(--bg-3); }
  /* A knowledge reference the bridge linked (docs/knowledge.md, "References in an
     answer"): the entry's id as a link, led by a dot in its standing's state color -
     ok for checked with evidence, warn for one to recheck or with differing evidence. */
  a[data-inf-entry] { cursor: pointer; border-radius: var(--radius-s); font-family: var(--font-mono); white-space: nowrap; }
  a[data-inf-entry]:hover { background: var(--bg-3); }
  a[data-inf-entry]::before {
    content: ""; display: inline-block; width: 6px; height: 6px; margin: 0 4px 1px 1px;
    border-radius: 50%; background: var(--fg-3); vertical-align: middle;
  }
  a[data-inf-entry][data-inf-standing="ok"]::before { background: var(--ok); }
  a[data-inf-entry][data-inf-standing="warn"]::before { background: var(--warn); }
  code, pre, .inf-mono { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-1); }
  /* A link in mono - a pull request a body names by its number (FI3-1307) - reads as
     every pull request link the app draws: the accent, underlined only while rested on. */
  a.inf-mono { color: var(--accent); text-decoration: none; }
  a.inf-mono:hover { text-decoration: underline; }
  .inf-muted { color: var(--fg-3); }
  .inf-row { display: flex; align-items: center; gap: var(--space-2); }
  .inf-grid { display: grid; gap: var(--space-2); }
  .inf-panel { padding: var(--space-3); border: 1px solid var(--line-1); border-radius: var(--radius-m); }
  .inf-facts { display: flex; flex-wrap: wrap; gap: var(--space-2) var(--space-4); }
  /* Its hairline parts it from a body above; beside a card's buttons it stands alone. */
  * + .inf-facts { border-top: 1px solid var(--line-1); padding-top: var(--space-2); margin: var(--space-3) 0 0; }
  .inf-fact { display: flex; flex-direction: column; min-width: 0; max-width: 100%; }
  .inf-fact-k { font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; white-space: nowrap; }
  .inf-fact-v { font-size: var(--text-sm); color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  /* A pull request reads as every pull request link the app draws: underlined only while rested on. */
  .inf-fact-v a { text-decoration: none; }
  .inf-fact-v a:hover { text-decoration: underline; }
  .inf-followups { margin: var(--space-3) 0 0; }
  .inf-followups-k { font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; margin-bottom: 2px; }
  .inf-followup { display: grid; grid-template-columns: auto minmax(0, 1fr) auto; align-items: baseline; column-gap: var(--space-2); font-size: var(--text-sm); line-height: 1.8; }
  .inf-followup-key { font-family: var(--font-mono); font-size: var(--text-xs); color: var(--fg-3); }
  .inf-followup-title { color: var(--fg-2); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .inf-followup-word { color: var(--fg-3); white-space: nowrap; }
  .inf-followup[data-followup="hold"] .inf-followup-word { color: var(--warn); }
  .inf-fact-dot { vertical-align: -1px; margin-right: var(--space-1); }
  /* What a card's button sends where the project lives, drawn by the host (FI3-1571). */
  .inf-call { margin: var(--space-3) 0 0; padding: var(--space-2) var(--space-3); border: 1px solid var(--line-1); border-radius: var(--radius-m); }
  .inf-call-k { font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; margin-bottom: 2px; }
  .inf-call-line { font-family: var(--font-mono); font-size: var(--text-sm); color: var(--fg-1); overflow-wrap: anywhere; }
  .inf-call pre { margin: var(--space-1) 0 0; padding: var(--space-2); background: var(--bg-1); border-radius: var(--radius-s); max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; }
  .inf-call ul { margin: var(--space-1) 0 0; }
  .inf-call li[data-inf-skip="check"] { color: var(--warn); }
  .inf-call-gap details { border: 0; padding: 0; margin: var(--space-2) 0 0; }
  .inf-call-gap dt { font-size: var(--text-xs); color: var(--fg-3); letter-spacing: var(--tracking-label); text-transform: uppercase; margin-top: var(--space-2); }
  .inf-call-gap dd { margin: var(--space-1) 0 0; color: var(--fg-2); }
  .inf-call-gap dd.inf-mono { color: var(--fg-1); }
  .inf-call p { margin: var(--space-1) 0 0; font-size: var(--text-sm); }
  table { width: 100%; border-collapse: collapse; }
  th, td { padding: var(--space-2); border-bottom: 1px solid var(--line-1); text-align: left; }
  th { color: var(--fg-1); font-weight: 500; }
  input, select, textarea {
    font-family: var(--font-ui); font-size: var(--text-base); color: var(--fg-1);
    background: var(--surface-input); border: 1px solid var(--line-1);
    border-radius: var(--radius-m); padding: var(--space-2) var(--space-3); outline: none;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--line-2); box-shadow: var(--focus-ring); }
  /* Questions in the body (inline decisions, contract 4.22): a fieldset is
     one question, its legend the ask and each option a row of its own. The
     author may present a question however it reads best; these rules only
     keep a plain form on-brand. */
  fieldset {
    min-width: 0; margin: 0 0 var(--space-2); padding: var(--space-1) var(--space-3) var(--space-3);
    border: 1px solid var(--line-1); border-radius: var(--radius-m);
  }
  legend { padding: 0 var(--space-1); color: var(--fg-1); font-weight: 500; }
  input:is([type="radio"], [type="checkbox"], [type="range"]) {
    padding: 0; border: none; background: none; accent-color: var(--accent);
  }
  input:is([type="radio"], [type="checkbox"]) { flex: none; margin: 0; }
  label:has(> input:is([type="radio"], [type="checkbox"])) {
    display: flex; align-items: baseline; gap: var(--space-2); cursor: pointer;
  }
  label:has(> input:is([type="radio"], [type="checkbox"])) + label { margin-top: var(--space-1); }
  label:has(> input:is([type="radio"], [type="checkbox"]):checked) { color: var(--fg-1); }
  label > textarea, label > select, label > input:not([type="radio"], [type="checkbox"], [type="range"]) {
    display: block; margin-top: var(--space-1);
  }
  label[data-inf-recommended-label]::after, [data-inf-recommendation] {
    content: "Recommended"; display: inline-block; color: var(--accent);
    background: var(--accent-dim); border-radius: var(--radius-pill);
    padding: 0 var(--space-2); font-family: var(--font-mono); font-size: var(--text-xs);
  }
  [data-inf-recommendation] { margin-top: var(--space-1); }
  textarea { width: 100%; min-height: 64px; resize: vertical; }
  /* A question's Something else row (FI3-1002): the field the bridge opens
     under it while it is picked - one line, growing to three - indented to
     the row's words, or full width under a select. */
  textarea[data-inf-write-in-field] {
    display: block; min-height: 0; max-height: calc(3lh + 2 * var(--space-1) + 2px);
    margin: var(--space-1) 0 0 calc(13px + var(--space-2)); width: calc(100% - 13px - var(--space-2));
    padding: var(--space-1) var(--space-3); font-size: var(--text-sm); line-height: var(--leading-body);
    resize: none; field-sizing: content;
  }
  textarea[data-inf-write-in-field="select"] { margin-left: 0; width: 100%; }
  textarea[data-inf-write-in-field][hidden] { display: none; }
  button, [data-inf-action] {
    font-family: var(--font-ui); font-size: var(--text-sm); font-weight: 500;
    color: var(--fg-1); background: transparent; border: 1px solid var(--line-2);
    border-radius: var(--radius-m); padding: var(--space-1) var(--space-3); cursor: pointer;
    transition: background var(--dur-fast) var(--ease-out);
  }
  button:hover, [data-inf-action]:hover { background: var(--bg-3); }
  :focus-visible { outline: none; box-shadow: var(--focus-ring); }
`;let Br;function kd(){return Br??=[pd,vd,gd,md,fd,yd(),bd].join(`
`),Br}function _d(e){return/<[a-z][\s\S]*>/i.test(e)?e:Sd(e)}function xd(e){return e.replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;").replaceAll('"',"&quot;").replaceAll("'","&#39;")}function Sd(e){return dd(e).map(n=>{const r=xd(n.value);return n.type==="url"&&ud(n.value)?`<a href="${r}">${r}</a>`:r}).join("").split(/\n{2,}/).map(n=>`<p>${n.replaceAll(`
`,"<br>")}</p>`).join("")}const Ed=8,Ad=`
  /* HtmlCardBody owns the vertical inset outside this auto-sized viewport.
     flow-root keeps child margins in the measured body without padding. */
  body { padding-block: 0; display: flow-root; }
  :is(p, ul, ol, dl, blockquote, h1, h2, h3, h4, h5, h6, figcaption, summary) { max-width: 66ch; }
  /* A group's caption is its own line under the strip (flex-basis 100%): a
     narrower box would let it rise beside the thumbnails, so the line keeps
     the group's width and its text keeps the measure. */
  .inf-pictures > figcaption { max-width: none; padding-right: max(0px, calc(100% - 66ch)); }
`,zd=`
  body:has([data-inf-bars]) { padding-left: calc(var(--space-1) + ${Ed}px); }
  [data-inf-bar] {
    position: absolute; left: calc(var(--space-1) - 2px); width: 2px;
    top: anchor(top); bottom: anchor(bottom);
    position-visibility: anchors-visible;
    border-radius: var(--radius-pill); background: var(--accent); pointer-events: none;
  }
`,Od=`
  [data-inf-inset] {
    float: right; clear: right; margin: 0;
    width: max(0px, calc(var(--inf-inset-width, 0px) - var(--space-1)));
    height: var(--inf-inset-height, 0px);
  }
  [data-inf-inset] ~ :nth-child(n + 3 of :is(h1, h2, h3, h4, h5, h6, :has(:is(h1, h2, h3, h4, h5, h6)))) {
    clear: right;
  }
`;let Wr;function Id(){return Wr??=`${kd()}
${Ad}
${zd}
${Od}
${Td}`,Wr}const Td=`
  [data-inf-revision-highlight] { background-color: var(--accent-dim); box-shadow: var(--focus-ring-inset); }
`,X=e=>window.webkit.messageHandlers.cardHost.postMessage(e);let q,ie,ae,$d=0;const Je=new Map,Y=e=>q?.contentWindow?.postMessage({fm:2,...e},"*"),Jr=e=>new Error(e);window.addEventListener("message",e=>{if(!q||e.source!==q.contentWindow)return;const t=Eu.safeParse(e.data);if(!t.success)return;const n=t.data;if(n.type==="ready"){if(ie||!n.document)return;ie=n.document,Y({type:"form",fill:pe.parse(ae.fill??[]),readOnly:ae.readOnly}),Y({type:"keys",pictures:!0,escape:!1}),Y({type:"width",width:ae.width}),Y({type:"initialize",document:ie});return}if(!(!ie||"document"in n&&n.document&&n.document!==ie))switch(n.type){case"answers":{const{questions:r,...o}=n,s=pt.safeParse(r),i={...o,...s.success?{questions:s.data}:{questionsGap:"invalid"}};if(X({type:"answers",reading:i}).catch(()=>{}),n.seq!==void 0){const c=Je.get(n.seq);c&&(clearTimeout(c.timer),Je.delete(n.seq),c.resolve(i))}break}case"resize":q.style.height=`${Math.max(48,Math.min(1e6,n.height))}px`,n.initialized&&X({type:"drawn",height:n.height}).catch(()=>{});break;case"pong":X({type:"pong",seq:n.seq}).catch(()=>{});break;case"request":{const r=bu.safeParse(n),o=(i,c)=>Y({type:"response",document:ie,id:n.id,...i?{ok:i,result:c}:{ok:i,error:{code:"refused",message:String(c)}}});if(!r.success||r.data.verb!=="action"||ae.readOnly||!ae.actions.includes(r.data.action)){o(!1,"This card cannot do that.");return}const s=r.data.value;if(s!==void 0&&new TextEncoder().encode(JSON.stringify(s)).length>uu){o(!1,"The answer is too large.");return}X({type:"action",id:r.data.action,value:s??null}).then(i=>o(!0,i),i=>o(!1,i));break}case"image":{if(!document.hasFocus()||!navigator.userActivation.isActive)return;const r=Dr(n.index,n.pictures);r&&X({type:"image",...r}).catch(()=>{});break}case"demo":document.hasFocus()&&navigator.userActivation.isActive&&Zu(ae.body).has(n.src)&&Dr(0,[n.poster])&&X({type:"demo",src:n.src,poster:n.poster,caption:n.caption,play:n.play}).catch(()=>{});break;case"link":case"draft":case"task":case"entry":X({type:"mac-only"}).catch(()=>{});break}}),window.phoneCard={async mount(e){ae=e;const t=_d(e.body),n=new DOMParser().parseFromString(t,"text/html"),r=Array.from(n.querySelectorAll("script:not([src])"),i=>i.textContent??""),o=await X({type:"hash",scripts:r}),s=ad({csp:`${Ot(o)}; base-uri 'none'; form-action 'none'`,theme:e.theme,style:Id(),html:t});q=window.document.createElement("iframe"),q.title="Card body",q.setAttribute("sandbox",Mu),q.style.cssText="display:block;width:100%;height:48px;border:0",q.srcdoc=s,window.document.body.replaceChildren(q)},collect(){if(!ie)return Promise.reject(Jr("This card is still drawing. Try again once it is ready."));const e=++$d;return new Promise((t,n)=>{const r=setTimeout(()=>{Je.delete(e),n(Jr("This card did not answer. Your choice was not sent."))},3e3);Je.set(e,{resolve:t,reject:n,timer:r}),Y({type:"collect",seq:e,focusUnpicked:!0})})},theme(e){Y({type:"theme",theme:e})},ping(e){Y({type:"ping",seq:e})}}})();
