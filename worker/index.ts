import { buildRoomShareMeta, normalizePicks, type RoomShareMeta } from '../src/domain/recommend';
import type { GameTag, MyRoomSummary, Night, Pick, RoomSnapshot, Submission } from '../src/domain/types';
import { slotToShanghaiParts } from '../src/domain/time';
import { validateCreateRoomBody, validateSaveMineBody, validateCloseRoomBody, ValidationError } from '../server/validation';

// The small structural types below match the D1 binding API; no Node-native SQLite in Workers.
interface D1Result<T> { results: T[]; success: boolean; }
interface Statement {
  bind(...values: (string | number | null)[]): Statement;
  first<T>(): Promise<T | null>;
  run(): Promise<D1Result<unknown>>;
}
interface D1 { prepare(sql: string): Statement; batch<T = unknown>(statements: Statement[]): Promise<D1Result<T>[]>; }
interface AssetsBinding {
  fetch(input: Request | URL | string): Promise<Response>;
}
interface Env { DB: D1; TOKEN_PEPPER: string; ROOM_TTL_DAYS?: string; ASSETS?: AssetsBinding; }
interface Room {
  id: string; owner_hash: string; create_hash: string; title: string; game_tag: GameTag | null;
  nights_json: string; target_players: number; duration_slots: number; room_revision: number;
  closed_at: string | null; expires_at: string;
}
interface MyRoomRow {
  id: string;
  title: string;
  game_tag: GameTag | null;
  nights_json: string;
  target_players: number;
  duration_slots: number;
  closed_at: string | null;
  created_at: string;
  submission_count: number;
}
interface Participant {
  id: string; member_hash: string; nickname: string; answer_kind: 'available' | 'unavailable';
  picks_json: string; participant_rev: number; updated_at: string;
}

class ApiError extends Error {
  constructor(readonly status: number, readonly code: string, message: string) { super(message); }
}
const fail = {
  missing: () => new ApiError(404,'NOT_FOUND','找不到这个约局房间，可能链接有误或已过期。'),
  closed: () => new ApiError(410,'ROOM_CLOSED','房主已结束本次收集，当前仅可查看结果。'),
  revision: () => new ApiError(409,'REVISION_CONFLICT','你的填写已在其他窗口更新，请刷新查看。'),
  conflict: () => new ApiError(409,'IDEMPOTENCY_CONFLICT','请求编号已被不同内容占用，请重新提交。'),
  owner: () => new ApiError(403,'OWNER_REQUIRED','只有房主可以结束收集。'),
  session: () => new ApiError(401,'SESSION_REQUIRED','浏览器身份已失效，请刷新页面后再试。'),
};
function json(body: unknown, status = 200, extra: Record<string,string> = {}): Response {
  return Response.json(body,{status,headers:{'Cache-Control':'private, no-store','X-Content-Type-Options':'nosniff',...extra}});
}
const encoder = new TextEncoder();
function hex(value: ArrayBuffer | Uint8Array): string {
  return Array.from(value instanceof Uint8Array ? value : new Uint8Array(value),b=>b.toString(16).padStart(2,'0')).join('');
}
function randomToken(): string { return hex(crypto.getRandomValues(new Uint8Array(32))); }
async function digest(value: unknown): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256',encoder.encode(JSON.stringify(value))));
}
async function signer(pepper: string): Promise<(parts: string[])=>Promise<string>> {
  if (typeof pepper !== 'string' || pepper.length < 32 || /replace|change.in.production|example/i.test(pepper)) {
    throw new ApiError(503,'CONFIG_ERROR','服务尚未配置安全密钥。');
  }
  const key=await crypto.subtle.importKey('raw',encoder.encode(pepper),{name:'HMAC',hash:'SHA-256'},false,['sign']);
  return async parts=>hex(await crypto.subtle.sign('HMAC',key,encoder.encode(JSON.stringify(parts))));
}
function cookieName(url: URL): string { return url.protocol==='https:' ? '__Host-yj_cloud_session' : 'yj_cloud_dev_session'; }
function session(request: Request,url: URL): string | null {
  const prefix=cookieName(url)+'=';
  const value=(request.headers.get('Cookie')||'').split(';').map(s=>s.trim()).find(s=>s.startsWith(prefix))?.slice(prefix.length);
  return value && /^[a-f0-9]{64}$/.test(value) ? value : null;
}
function sameOrigin(request: Request,url: URL): boolean {
  const origin=request.headers.get('Origin');
  if (origin!==null) return origin===url.origin;
  try { return new URL(request.headers.get('Referer')||'').origin===url.origin; } catch { return false; }
}
function mutationKey(id: string): void {
  // 32 hex characters from crypto.getRandomValues, never Math.random.
  if (!/^[a-f0-9]{32}$/.test(id)) throw new ValidationError('请求编号不合法，请刷新后重试。');
}
async function body(request: Request): Promise<unknown> {
  if (!request.headers.get('Content-Type')?.toLowerCase().startsWith('application/json')) {
    throw new ApiError(415,'INVALID_INPUT','请求必须是 JSON。');
  }
  const reader=request.body?.getReader();
  if (!reader) throw new ValidationError('缺少请求体。');
  const decoder=new TextDecoder(); let size=0, text='';
  while (true) {
    const part=await reader.read(); if(part.done) break;
    size+=part.value.byteLength;
    if(size>65536) { await reader.cancel(); throw new ApiError(413,'INVALID_INPUT','请求体过大。'); }
    text+=decoder.decode(part.value,{stream:true});
  }
  try { return JSON.parse(text+decoder.decode()); } catch { throw new ValidationError('JSON 格式不正确。'); }
}
function translateError(err: unknown): ApiError {
  if(err instanceof ApiError) return err;
  if(err instanceof ValidationError) return new ApiError(400,'INVALID_INPUT',err.message);
  const message=String(err);
  if(message.includes('QIDONG_NOT_FOUND')) return fail.missing();
  if(message.includes('QIDONG_OWNER_REQUIRED')) return fail.owner();
  if(message.includes('QIDONG_ROOM_CLOSED')) return fail.closed();
  if(message.includes('QIDONG_REVISION_CONFLICT')) return fail.revision();
  console.error('qidong worker error',err);
  return new ApiError(500,'INTERNAL_ERROR','服务器开小差了，请稍后重试。');
}
const roomSql='SELECT * FROM rooms WHERE id=? AND expires_at>?';
async function activeRoom(db: D1,id: string, now: string): Promise<Room> {
  const room=await db.prepare(roomSql).bind(id,now).first<Room>();
  if(!room) throw fail.missing();
  return room;
}
async function snapshot(db: D1,id: string,member: string|null,owner: string|null): Promise<RoomSnapshot> {
  const now=new Date().toISOString();
  const [roomResult,peopleResult]=await db.batch([
    db.prepare(roomSql).bind(id,now),
    db.prepare('SELECT * FROM participants WHERE room_id=? ORDER BY rowid').bind(id),
  ]);
  const room=roomResult.results[0] as Room|undefined;
  if(!room) throw fail.missing();
  const people=peopleResult.results as Participant[];
  const mine=people.find(p=>p.member_hash===member);
  const submissions: Submission[]=people.map(p=>({
    memberId:p.id,nickname:p.nickname,updatedAt:p.updated_at,
    answer:p.answer_kind==='available'?{kind:'available',picks:JSON.parse(p.picks_json) as Pick[]}:{kind:'unavailable'},
  }));
  return {id:room.id,title:room.title,...(room.game_tag?{gameTag:room.game_tag}:{}),tzid:'Asia/Shanghai',
    nights:JSON.parse(room.nights_json) as Night[],targetPlayers:room.target_players,durationSlots:room.duration_slots,
    roomRevision:room.room_revision,closedAt:room.closed_at,submissions,
    viewer:{memberId:mine?.id??null,mineRevision:mine?.participant_rev??0,canClose:owner!==null&&owner===room.owner_hash},syncedAt:now};
}
async function mutate(db:D1, data:{roomId:string;actor:string;action:'save'|'close';key:string;hash:string;
  base:number|null;memberId:string|null;nickname:string|null;kind:string|null;picks:string|null;now:string}):Promise<void>{
  // SELECT-WHERE-NOT-EXISTS avoids firing the guard on replay. The mutation key and
  // triggers protect concurrent writes in a single SQLite statement, even across isolates.
  await db.prepare(`INSERT INTO mutations(room_id,actor_hash,action,mutation_id,request_hash,base_rev,member_id,nickname,answer_kind,picks_json,created_at)
    SELECT ?,?,?,?,?,?,?,?,?,?,? WHERE NOT EXISTS(
      SELECT 1 FROM mutations WHERE room_id=? AND actor_hash=? AND action=? AND mutation_id=?
    )`).bind(data.roomId,data.actor,data.action,data.key,data.hash,data.base,data.memberId,data.nickname,data.kind,data.picks,data.now,
      data.roomId,data.actor,data.action,data.key).run();
  const row=await db.prepare('SELECT request_hash FROM mutations WHERE room_id=? AND actor_hash=? AND action=? AND mutation_id=?')
    .bind(data.roomId,data.actor,data.action,data.key).first<{request_hash:string}>();
  if(!row) throw fail.missing();
  if(row.request_hash!==data.hash) throw fail.conflict();
}

function escapeHtml(value: string): string {
  return value
    .replace(/[\r\n\t]+/g, ' ')
    .trim()
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function injectRoomMeta(html: string, meta: RoomShareMeta): string {
  const cleaned = html
    .replace(/<title\b[^>]*>[\s\S]*?<\/title>\s*/gi, '')
    .replace(
      /<meta\b[^>]*(?:name=["'](?:description|twitter:[^"']+)["']|property=["']og:[^"']+["']|itemprop=["'](?:name|description|image)["'])[^>]*>\s*/gi,
      '',
    );
  const t = escapeHtml(meta.title);
  const d = escapeHtml(meta.description);
  const img = escapeHtml(meta.imageUrl);
  const canonical = escapeHtml(meta.canonicalUrl);
  const tags = [
    `<title>${t}</title>`,
    `<meta name="description" content="${d}" />`,
    `<meta itemprop="name" content="${t}" />`,
    `<meta itemprop="description" content="${d}" />`,
    `<meta itemprop="image" content="${img}" />`,
    `<meta property="og:type" content="website" />`,
    `<meta property="og:site_name" content="约局车票" />`,
    `<meta property="og:url" content="${canonical}" />`,
    `<meta property="og:title" content="${t}" />`,
    `<meta property="og:description" content="${d}" />`,
    `<meta property="og:image" content="${img}" />`,
    `<meta name="twitter:card" content="summary_large_image" />`,
    `<meta name="twitter:title" content="${t}" />`,
    `<meta name="twitter:description" content="${d}" />`,
    `<meta name="twitter:image" content="${img}" />`,
  ].join('\n    ');
  if (/<\/head>/i.test(cleaned)) {
    return cleaned.replace(/<\/head>/i, `    ${tags}\n  </head>`);
  }
  return `${tags}\n${cleaned}`;
}

async function handleRoomPage(url: URL, method: string, env: Env): Promise<Response> {
  if (method !== 'GET' && method !== 'HEAD') {
    return new Response('Method Not Allowed', { status: 405, headers: { Allow: 'GET, HEAD' } });
  }
  if (!env.ASSETS) {
    return new Response('Static assets binding unavailable', { status: 500 });
  }
  const assetRes = await env.ASSETS.fetch(new Request(new URL('/', url), { method: 'GET' }));
  if (!assetRes.ok) {
    return assetRes;
  }
  const html = await assetRes.text();
  let meta: RoomShareMeta = {
    title: '找不到这张开黑车票 · 约局车票',
    description: '可能链接有误或房间已过期，点击发起新的约局车票。',
    imageUrl: `${url.origin}/art/hero-runner.png`,
    canonicalUrl: `${url.origin}${url.pathname}`,
  };
  const roomMatch = /^\/r\/(r-[a-f0-9]{32})\/?$/.exec(url.pathname);
  if (roomMatch) {
    try {
      const roomSnap = await snapshot(env.DB, roomMatch[1], null, null);
      meta = buildRoomShareMeta(roomSnap, url.origin);
    } catch (err) {
      if (!(err instanceof ApiError && err.status === 404)) {
        console.error('qidong meta lookup error', err);
      }
    }
  }
  const rendered = injectRoomMeta(html, meta);
  const headers = new Headers(assetRes.headers);
  headers.delete('etag');
  headers.delete('content-length');
  headers.set('Content-Type', 'text/html; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  headers.set('X-Content-Type-Options', 'nosniff');
  return new Response(method === 'HEAD' ? null : rendered, { status: 200, headers });
}

export default {
  async fetch(request: Request,env: Env): Promise<Response> {
    try {
      const url=new URL(request.url), path=url.pathname, method=request.method;
      if(url.protocol!=='https:' && !['localhost','127.0.0.1','[::1]'].includes(url.hostname)) {
        throw new ApiError(400,'HTTPS_REQUIRED','请使用 HTTPS 访问。');
      }
      if(path.startsWith('/r/')) {
        return await handleRoomPage(url, method, env);
      }
      const sign=await signer(env.TOKEN_PEPPER);
      if(path==='/api/health' && method==='GET') {
        await env.DB.prepare('SELECT id FROM rooms LIMIT 1').first();
        return json({ok:true,syncMode:'poll'});
      }
      const token=session(request,url);
      if(path==='/api/session' && method==='GET') {
        if(token) return json({ok:true});
        const secure=url.protocol==='https:'?'; Secure':'';
        return json({ok:true},200,{'Set-Cookie':cookieName(url)+'='+randomToken()+'; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000'+secure});
      }
      if(path==='/api/my-rooms' && method==='GET') {
        if(!token) return json({rooms:[]});
        const creatorSession=await sign(['creator_session',token]);
        const nowIso=new Date().toISOString();
        const [result]=await env.DB.batch([
          env.DB.prepare(
            `SELECT r.id, r.title, r.game_tag, r.nights_json, r.target_players,
                    r.duration_slots, r.closed_at, r.created_at,
                    (SELECT COUNT(*) FROM participants p WHERE p.room_id = r.id) AS submission_count
             FROM rooms r
             WHERE r.creator_session_hash = ? AND r.expires_at > ?
             ORDER BY r.created_at DESC
             LIMIT 20`,
          ).bind(creatorSession,nowIso),
        ]);
        const rows=(result?.results??[]) as MyRoomRow[];
        const rooms: MyRoomSummary[]=rows.map(row=>({
          id:row.id,
          title:row.title,
          ...(row.game_tag?{gameTag:row.game_tag}:{}),
          nights:JSON.parse(row.nights_json) as Night[],
          targetPlayers:row.target_players,
          durationSlots:row.duration_slots,
          submissionCount:Number(row.submission_count??0),
          closedAt:row.closed_at,
          createdAt:row.created_at,
          role:'owner',
        }));
        return json({rooms});
      }
      if(!['GET','HEAD'].includes(method) && !sameOrigin(request,url))
        throw new ApiError(403,'ORIGIN_FORBIDDEN','来源校验失败，仅允许同源请求。');
      if(path==='/api/rooms' && method==='POST') {
        if(!token) throw fail.session();
        const input=validateCreateRoomBody(await body(request)); mutationKey(input.mutationId);
        const dates=new Set<string>();
        for(const n of input.nights) {
          if(!Number.isSafeInteger(n.from)||!Number.isSafeInteger(n.to)||n.from<0||n.to>10_000_000||
            slotToShanghaiParts(n.from).dateKey!==n.dateKey||dates.has(n.dateKey))
            throw new ValidationError('晚间日期与时段不匹配或重复。');
          dates.add(n.dateKey);
        }
        const id='r-'+(await sign(['room',token,input.mutationId])).slice(0,32);
        const creatorSession=await sign(['creator_session',token]);
        const owner=await sign(['owner',token,id]), member=await sign(['member',token,id]);
        const hash=await digest({title:input.title,gameTag:input.gameTag??null,nights:input.nights,targetPlayers:input.targetPlayers,durationSlots:input.durationSlots});
        const now=Date.now(), iso=new Date(now).toISOString();
        const ttl=Number(env.ROOM_TTL_DAYS??30);
        if(!Number.isInteger(ttl)||ttl<1||ttl>365) throw new ApiError(503,'CONFIG_ERROR','房间有效期配置不正确。');
        const result=await env.DB.prepare(`INSERT INTO rooms(id,owner_hash,creator_session_hash,create_hash,title,game_tag,nights_json,target_players,duration_slots,expires_at,created_at)
          VALUES(?,?,?,?,?,?,?,?,?,?,?) ON CONFLICT(id) DO NOTHING RETURNING id`)
          .bind(id,owner,creatorSession,hash,input.title,input.gameTag??null,JSON.stringify(input.nights),input.targetPlayers,input.durationSlots,new Date(now+ttl*86400000).toISOString(),iso).first<{id:string}>();
        const room=await activeRoom(env.DB,id,iso);
        if(room.owner_hash!==owner || room.create_hash!==hash) throw fail.conflict();
        return json(await snapshot(env.DB,id,member,owner),result?201:200);
      }
      const match=/^\/api\/rooms\/(r-[a-f0-9]{32})(?:\/(me|closure|events))?$/.exec(path);
      if(!match) throw fail.missing();
      const [,id,action]=match;
      const member=token?await sign(['member',token,id]):null;
      const owner=token?await sign(['owner',token,id]):null;
      if(method==='GET'&&!action) return json(await snapshot(env.DB,id,member,owner));
      if(method==='GET'&&action==='events') {
        await activeRoom(env.DB,id,new Date().toISOString());
        // Cloudflare MVP uses visible-tab polling, not an in-memory SSE hub.
        return new Response(null,{status:204,headers:{'Cache-Control':'no-store'}});
      }
      if(method==='DELETE'&&!action) {
        if(!token||!owner) throw fail.session();
        const room=await activeRoom(env.DB,id,new Date().toISOString());
        if(room.owner_hash!==owner) throw new ApiError(403,'OWNER_REQUIRED','只有房主可以删除这个车队。');
        await env.DB.batch([
          env.DB.prepare('DELETE FROM participants WHERE room_id=? AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND owner_hash=?)').bind(id,id,owner),
          env.DB.prepare('DELETE FROM mutations WHERE room_id=? AND EXISTS(SELECT 1 FROM rooms WHERE id=? AND owner_hash=?)').bind(id,id,owner),
          env.DB.prepare('DELETE FROM rooms WHERE id=? AND owner_hash=?').bind(id,owner),
        ]);
        return json({ok:true,id});
      }
      if(method!=='PUT'||(action!=='me'&&action!=='closure')) throw fail.missing();
      if(!token||!member||!owner) throw fail.session();
      const now=new Date().toISOString();
      const room=await activeRoom(env.DB,id,now);
      if(action==='me') {
        const input=validateSaveMineBody(await body(request)); mutationKey(input.mutationId);
        const picks=input.answer.kind==='available'?normalizePicks(input.answer.picks,JSON.parse(room.nights_json) as Night[]):[];
        if(input.answer.kind==='available'&&!picks.length) throw new ValidationError('请至少选择一个有效时段。');
        if(!Number.isSafeInteger(input.baseMineRevision)) throw new ValidationError('版本号不合法。');
        const hash=await digest({nickname:input.nickname,kind:input.answer.kind,picks,base:input.baseMineRevision});
        await mutate(env.DB,{roomId:id,actor:member,action:'save',key:input.mutationId,hash,base:input.baseMineRevision,
          memberId:'m_'+randomToken().slice(0,32),nickname:input.nickname,kind:input.answer.kind,picks:JSON.stringify(picks),now});
      } else {
        if(room.owner_hash!==owner) throw fail.owner();
        const input=validateCloseRoomBody(await body(request)); mutationKey(input.mutationId);
        await mutate(env.DB,{roomId:id,actor:owner,action:'close',key:input.mutationId,hash:await digest({action:'close'}),base:null,
          memberId:null,nickname:null,kind:null,picks:null,now});
      }
      return json(await snapshot(env.DB,id,member,owner));
    } catch(err) { const e=translateError(err); return json({error:{code:e.code,message:e.message}},e.status); }
  },
  async scheduled(_event: unknown,env: Env): Promise<void> {
    // Cascading FK deletion also removes participant and mutation rows.
    await env.DB.prepare('DELETE FROM rooms WHERE id IN (SELECT id FROM rooms WHERE expires_at<=? ORDER BY expires_at LIMIT 100)')
      .bind(new Date().toISOString()).run();
  },
};
