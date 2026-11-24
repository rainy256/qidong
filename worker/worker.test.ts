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
  const env:Env={DB,TOKEN_PEPPER:'test-secret-0123456789abcdef0123456789abcdef'};
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
});
