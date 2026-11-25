import Database from 'better-sqlite3';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import worker from './index';
import { buildNightWindow } from '../src/domain/time';
import type { RoomSnapshot } from '../src/domain/types';

type Env = Parameters<typeof worker.fetch>[1];
type Binding = Env['DB'];
type Values = (string | number | null)[];
type Result<T> = {results:T[];success:boolean};

// This adapter exercises the actual SQL/triggers using SQLite, not the remote
// D1 transport. Run wrangler dev separately to verify Cloudflare integration.
function harness() {
  const sqlite = new Database(':memory:');
  sqlite.pragma('foreign_keys = ON');
  sqlite.exec(readFileSync(new URL('./migrations/0001_initial.sql',import.meta.url),'utf8'));
  sqlite.exec(readFileSync(new URL('./migrations/0002_session_room_index.sql',import.meta.url),'utf8'));
  class LocalStatement {
    constructor(readonly sql:string,readonly values:Values=[]) {}
    bind(...values:Values) { return new LocalStatement(this.sql,values); }
    all<T>(): Result<T> {
      const stmt=sqlite.prepare(this.sql);
      if(stmt.reader) return {results:stmt.all(...this.values) as T[],success:true};
      stmt.run(...this.values); return {results:[],success:true};
    }
    async first<T>() { return this.all<T>().results[0]??null; }
    async run() { return this.all<unknown>(); }
  }
  const DB:Binding = {
    prepare:sql=>new LocalStatement(sql),
    async batch<T>(statements:Parameters<Binding['batch']>[0]) {
      return sqlite.transaction(()=>statements.map(s=>(s as LocalStatement).all<T>()))();
    },
  };
  const baseHtml = `<!doctype html>
<html lang="zh-CN">
  <head>
    <meta charset="UTF-8" />
    <title>约局 · 找个大家都能开的时间</title>
    <meta name="description" content="static" />
    <meta name="Description" content="stale" />
    <meta itemprop="Description" content="stale" />
    <meta property="og:title" content="static" />
    <meta property="og:image" content="/art/hero-runner.png" />
  </head>
  <body><div id="root"></div></body>
</html>`;
  const ASSETS: NonNullable<Env['ASSETS']> = {
    async fetch() {
      return new Response(baseHtml, {
        status: 200,
        headers: { 'Content-Type': 'text/html; charset=utf-8', ETag: '"v1"' },
      });
    },
  };
  const env:Env={DB,TOKEN_PEPPER:'test-secret-0123456789abcdef0123456789abcdef',ASSETS};
  const origin='https://qidong.test';
  async function request(path:string,method='GET',cookie='',payload?:unknown) {
    return worker.fetch(new Request(origin+path,{method,headers:{Origin:origin,Cookie:cookie,
      ...(payload!==undefined?{'Content-Type':'application/json'}:{})},
      ...(payload!==undefined?{body:JSON.stringify(payload)}:{})}),env);
  }
  async function session() {
    const response=await request('/api/session');
    expect(response.status).toBe(200);
    const header=response.headers.get('Set-Cookie')!;
    expect(header).toContain('HttpOnly');
    expect(header).toContain('Secure');
    return header.split(';')[0];
  }
  return {sqlite,request,session,env};
}
const disposers:(()=>void)[]=[];
afterEach(()=>{for(const close of disposers.splice(0))close();});
function setup(){const h=harness();disposers.push(()=>h.sqlite.close());return h;}
const night=buildNightWindow('2026-11-27',19,0,2,0);
const key=(n:number)=>n.toString(16).padStart(32,'0');
const spec={title:'开黑',gameTag:'apex',nights:[night],targetPlayers:3,durationSlots:4,mutationId:key(1)};
const save=(n:number,base=0,nickname='玩家')=>({nickname,answer:{kind:'available',picks:[{nightId:night.id,from:night.from,to:night.to}]},baseMineRevision:base,mutationId:key(n)});
async function snap(res:Response,status=200):Promise<RoomSnapshot>{
  const body=await res.json();
  expect(res.status,JSON.stringify(body)).toBe(status);return body as RoomSnapshot;
}

describe('Cloudflare Worker with actual SQLite schema',()=>{
  it('requires a stable session, recovers owner on replay, isolates other sessions',async()=>{
    const h=setup();
    expect((await h.request('/api/rooms','POST','',spec)).status).toBe(401);
    const a=await h.session(),b=await h.session();
    const room=await snap(await h.request('/api/rooms','POST',a,spec),201);
    const replay=await snap(await h.request('/api/rooms','POST',a,spec));
    expect(replay.id).toBe(room.id);expect(replay.viewer.canClose).toBe(true);
    expect((await h.request('/api/rooms','POST',a,{...spec,title:'另一标题'})).status).toBe(409);
    const other=await snap(await h.request('/api/rooms','POST',b,spec),201);
    expect(other.id).not.toBe(room.id);
    const guest=await snap(await h.request('/api/rooms/'+room.id,'GET',b));
    expect(guest.viewer.canClose).toBe(false);expect(guest.submissions).toHaveLength(0);
  });

  it('serializes concurrent different members, rejects stale own revisions and replays save after closure',async()=>{
    const h=setup(),a=await h.session(),b=await h.session(),c=await h.session();
    const room=await snap(await h.request('/api/rooms','POST',a,spec),201);
    const url='/api/rooms/'+room.id;
    const both=await Promise.all([h.request(url+'/me','PUT',b,save(2)),h.request(url+'/me','PUT',c,save(3))]);
    expect(both.map(r=>r.status)).toEqual([200,200]);
    const competing=await Promise.all([h.request(url+'/me','PUT',b,save(4,1,'甲')),h.request(url+'/me','PUT',b,save(5,1,'乙'))]);
    expect(competing.map(r=>r.status).sort()).toEqual([200,409]);
    expect((await h.request(url+'/closure','PUT',b,{mutationId:key(6)})).status).toBe(403);
    const closed=await snap(await h.request(url+'/closure','PUT',a,{mutationId:key(6)}));
    expect(closed.roomRevision).toBe(5);expect(closed.closedAt).toBeTruthy();
    const replay=await snap(await h.request(url+'/me','PUT',b,save(2)));
    expect(replay.roomRevision).toBe(5);expect(replay.submissions).toHaveLength(2);
    expect((await h.request(url+'/me','PUT',b,save(7,2))).status).toBe(410);
    expect((await h.request(url+'/me','PUT',b,save(2,0,'篡改'))).status).toBe(409);
    expect((await snap(await h.request(url+'/closure','PUT',a,{mutationId:key(8)}))).roomRevision).toBe(5);
  });

  it('rejects cross-origin writes and expires rooms and their children',async()=>{
    const h=setup(),a=await h.session();
    const bad=await worker.fetch(new Request('https://qidong.test/api/rooms',{method:'POST',headers:{Origin:'https://elsewhere.test',Cookie:a,'Content-Type':'application/json'},body:JSON.stringify(spec)}),h.env);
    expect(bad.status).toBe(403);
    const room=await snap(await h.request('/api/rooms','POST',a,spec),201);
    await snap(await h.request('/api/rooms/'+room.id+'/me','PUT',a,save(2)));
    h.sqlite.prepare('UPDATE rooms SET expires_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',room.id);
    expect((await h.request('/api/rooms/'+room.id,'GET',a)).status).toBe(404);
    await worker.scheduled({},h.env);
    expect(h.sqlite.prepare('SELECT * FROM participants').all()).toHaveLength(0);
    expect(h.sqlite.prepare('SELECT * FROM mutations').all()).toHaveLength(0);
  });

  it('injects dynamic OG share metadata on /r/:id using request origin without side effects',async()=>{
    const h=setup(),a=await h.session(),b=await h.session();
    const room=await snap(await h.request('/api/rooms','POST',a,spec),201);
    const url='/api/rooms/'+room.id;
    await snap(await h.request(url+'/me','PUT',a,save(2,0,'阿哲')));
    await snap(await h.request(url+'/me','PUT',b,save(3,0,'小满')));

    const customOrigin='https://yueju.my-custom.com';
    const pageRes=await worker.fetch(
      new Request(`${customOrigin}/r/${room.id}?created=1`,{method:'GET'}),
      {...h.env,TOKEN_PEPPER:''},
    );
    expect(pageRes.status).toBe(200);
    expect(pageRes.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(pageRes.headers.get('Cache-Control')).toBe('no-store');
    expect(pageRes.headers.get('ETag')).toBeNull();

    const html=await pageRes.text();
    expect(html.match(/<title>/gi)).toHaveLength(1);
    expect(html.match(/property="og:title"/gi)).toHaveLength(1);
    expect(html).toContain('<title>【开黑】已有 2/3 人重合 · 还差 1 人</title>');
    expect(html).toContain('<meta property="og:title" content="【开黑】已有 2/3 人重合 · 还差 1 人" />');
    expect(html).toContain(`content="${customOrigin}/art/game-apex.png"`);
    expect(html).toContain(`<meta property="og:url" content="${customOrigin}/r/${room.id}" />`);
    expect(html).toContain('<meta itemprop="name" content="【开黑】已有 2/3 人重合 · 还差 1 人" />');
    expect(html).toContain('<meta name="description" content="周三 19:00–次日 00:00 可连玩满 2 小时（阿哲和小满）" />');
    expect(html).toContain('<meta name="Description" content="周三 19:00–次日 00:00 可连玩满 2 小时（阿哲和小满）" />');
    expect(html).toContain('<meta itemprop="description" content="周三 19:00–次日 00:00 可连玩满 2 小时（阿哲和小满）" />');
    expect(html).toContain('<meta itemprop="Description" content="周三 19:00–次日 00:00 可连玩满 2 小时（阿哲和小满）" />');
    expect(html.match(/<meta name="Description"/gi)).toHaveLength(1);
    expect(html.match(/<meta itemprop="Description"/gi)).toHaveLength(1);
    expect(html).not.toContain('content="stale"');
    expect(html.indexOf('charset="UTF-8"')).toBeLessThan(html.indexOf('<meta name="Description"'));
    expect(html.indexOf('<meta name="Description"')).toBeLessThan(html.indexOf('</head>'));
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image" />');
    expect((h.sqlite.prepare('SELECT COUNT(*) AS c FROM participants').get() as {c:number}).c).toBe(2);

    const headRes=await worker.fetch(new Request(`${customOrigin}/r/${room.id}`,{method:'HEAD'}),h.env);
    expect(headRes.status).toBe(200);
    expect(headRes.headers.get('Content-Type')).toBe('text/html; charset=utf-8');
    expect(await headRes.text()).toBe('');

    const missingRes=await worker.fetch(new Request(`${customOrigin}/r/r-${'0'.repeat(32)}`,{method:'GET'}),h.env);
    expect(missingRes.status).toBe(200);
    expect(await missingRes.text()).toContain('<title>找不到这张开黑车票 · 约局车票</title>');
  });

  it('escapes HTML and attribute special characters in injected room metadata',async()=>{
    const h=setup(),a=await h.session();
    const evilTitle='测试<script>"&\'';
    const evilSpec={...spec,title:evilTitle};
    const room=await snap(await h.request('/api/rooms','POST',a,evilSpec),201);
    await snap(await h.request(`/api/rooms/${room.id}/me`,'PUT',a,save(2,0,'小明"<b>&')));

    const res=await worker.fetch(new Request(`https://yueju.my-custom.com/r/${room.id}`),h.env);
    const html=await res.text();
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<b>');
    expect(html).toContain('测试&lt;script&gt;&quot;&amp;&#39;');
    expect(html).toContain('小明&quot;&lt;b&gt;&amp;');
  });

  it('recovers creator active rooms via GET /api/my-rooms with session isolation and expiry filtering',async()=>{
    const h=setup();
    const anonRes=await h.request('/api/my-rooms');
    expect(anonRes.status).toBe(200);
    expect(anonRes.headers.get('Cache-Control')).toBe('private, no-store');
    expect(anonRes.headers.get('Set-Cookie')).toBeNull();
    expect(await anonRes.json()).toEqual({rooms:[]});

    const a=await h.session(), b=await h.session();
    const roomA1=await snap(await h.request('/api/rooms','POST',a,{...spec,title:'周五夜战',mutationId:key(10)}),201);
    await snap(await h.request(`/api/rooms/${roomA1.id}/me`,'PUT',a,save(11,0,'阿哲')));
    await snap(await h.request(`/api/rooms/${roomA1.id}/me`,'PUT',b,save(12,0,'小满')));

    // Advance created_at slightly for deterministic newest-first ordering
    h.sqlite.prepare('UPDATE rooms SET created_at=? WHERE id=?').run('2026-11-24T10:00:00.000Z',roomA1.id);
    const roomA2=await snap(await h.request('/api/rooms','POST',a,{...spec,title:'周六二车',gameTag:'tarkov',mutationId:key(13)}),201);
    await snap(await h.request(`/api/rooms/${roomA2.id}/closure`,'PUT',a,{mutationId:key(14)}));

    const roomB1=await snap(await h.request('/api/rooms','POST',b,{...spec,title:'别人开的房',mutationId:key(15)}),201);
    // Legacy row without creator_session_hash should never leak or error
    h.sqlite.prepare(`INSERT INTO rooms(id,owner_hash,creator_session_hash,create_hash,title,game_tag,nights_json,target_players,duration_slots,expires_at,created_at)
      VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        `r-${'f'.repeat(32)}`,'legacy-owner',null,'legacy-hash','旧房',null,JSON.stringify([night]),3,4,'2099-01-01T00:00:00.000Z','2026-11-24T08:00:00.000Z',
      );

    const aRes=await h.request('/api/my-rooms','GET',a);
    expect(aRes.status).toBe(200);
    const aBody=await aRes.json() as {rooms:Array<{id:string;title:string;submissionCount:number;closedAt:string|null;role:string}>};
    expect(aBody.rooms.map(r=>r.id)).toEqual([roomA2.id,roomA1.id]);
    expect(aBody.rooms[0]).toMatchObject({id:roomA2.id,title:'周六二车',submissionCount:0,role:'owner'});
    expect(aBody.rooms[0].closedAt).toBeTruthy();
    expect(aBody.rooms[1]).toMatchObject({id:roomA1.id,title:'周五夜战',submissionCount:2,closedAt:null,role:'owner'});

    // Expired room is excluded
    h.sqlite.prepare('UPDATE rooms SET expires_at=? WHERE id=?').run('2020-01-01T00:00:00.000Z',roomA1.id);
    const aAfterExpire=await (await h.request('/api/my-rooms','GET',a)).json() as {rooms:Array<{id:string}>};
    expect(aAfterExpire.rooms.map(r=>r.id)).toEqual([roomA2.id]);

    const bBody=await (await h.request('/api/my-rooms','GET',b)).json() as {rooms:Array<{id:string}>};
    expect(bBody.rooms.map(r=>r.id)).toEqual([roomB1.id]);
  });

  it('allows owner to permanently delete a room via DELETE /api/rooms/:id while blocking unauthorized callers',async()=>{
    const h=setup(),a=await h.session(),b=await h.session();
    const room=await snap(await h.request('/api/rooms','POST',a,{...spec,title:'可删车队',mutationId:key(20)}),201);
    const url='/api/rooms/'+room.id;
    await snap(await h.request(url+'/me','PUT',a,save(21,0,'阿哲')));
    await snap(await h.request(url+'/me','PUT',b,save(22,0,'小满')));

    expect((await h.request(url,'DELETE')).status).toBe(401);
    const crossOrigin=await worker.fetch(new Request(`https://qidong.test${url}`,{method:'DELETE',headers:{Origin:'https://elsewhere.test',Cookie:a}}),h.env);
    expect(crossOrigin.status).toBe(403);
    expect((await h.request(url,'DELETE',b)).status).toBe(403);
    expect((h.sqlite.prepare('SELECT COUNT(*) AS c FROM participants WHERE room_id=?').get(room.id) as {c:number}).c).toBe(2);

    const delRes=await h.request(url,'DELETE',a);
    expect(delRes.status).toBe(200);
    expect(await delRes.json()).toEqual({ok:true,id:room.id});

    expect((await h.request(url,'GET',a)).status).toBe(404);
    expect((await h.request(url,'DELETE',a)).status).toBe(404);
    const listBody=await (await h.request('/api/my-rooms','GET',a)).json() as {rooms:Array<{id:string}>};
    expect(listBody.rooms).toHaveLength(0);
    const pageHtml=await (await worker.fetch(new Request(`https://yueju.my-custom.com/r/${room.id}`),h.env)).text();
    expect(pageHtml).toContain('<title>找不到这张开黑车票 · 约局车票</title>');
    expect((h.sqlite.prepare('SELECT COUNT(*) AS c FROM participants WHERE room_id=?').get(room.id) as {c:number}).c).toBe(0);
    expect((h.sqlite.prepare('SELECT COUNT(*) AS c FROM mutations WHERE room_id=?').get(room.id) as {c:number}).c).toBe(0);
  });
});
