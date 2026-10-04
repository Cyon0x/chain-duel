const BASE = "https://chain-duel.vercel.app";
async function api(path, { method = "GET", body, cookie } = {}) {
  const r = await fetch(BASE + path, {
    method,
    headers: { "content-type": "application/json", ...(cookie ? { cookie } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await r.text();
  let json = null; try { json = text ? JSON.parse(text) : null; } catch { json = text; }
  const set = r.headers.getSetCookie?.() ?? [];
  return { status: r.status, body: json, cookie: set.length ? set[0].split(";")[0] : null, raw: text };
}
async function player(tag) {
  const name = `looptest${tag}${Math.random().toString(36).slice(2, 6)}`;
  const s = await api("/api/auth/demo", { method: "POST", body: { name } });
  if (s.status !== 200) throw new Error("demo signin " + s.raw);
  const o = await api("/api/onboarding", { method: "POST", cookie: s.cookie, body: { username: name, theme: "neon" } });
  if (o.status !== 200) throw new Error("onboard " + o.raw);
  return { cookie: s.cookie, name };
}
const a = await player("a"), b = await player("b");
const q1 = await api("/api/matchmaking", { method: "POST", cookie: a.cookie, body: { entryXlm: 0, demo: true } });
const q2 = await api("/api/matchmaking", { method: "POST", cookie: b.cookie, body: { entryXlm: 0, demo: true } });
const st = await api("/api/matchmaking", { cookie: a.cookie });
console.log("a queue:", q1.body.status, "| b queue:", q2.body.status, "| poll:", st.body.status, st.body.gameId);
const gameId = st.body.gameId;
if (!gameId) throw new Error("no match");

for (const p of [a, b]) {
  const e = await api(`/api/duels/${gameId}/entry`, { method: "POST", cookie: p.cookie, body: { action: "commit" } });
  if (e.status !== 200) throw new Error("entry " + e.raw);
}
const start = await api(`/api/matches/${gameId}/start`, { method: "POST", cookie: a.cookie });
if (start.status !== 200) throw new Error("start " + start.raw);
const view = await api(`/api/matches/${gameId}`, { cookie: a.cookie });
const hits = view.body.schedule.slice(0, 30).map(t => ({ targetId: t.id, atMs: t.spawnAtMs + 150 }));
const score = hits.length; // demo: last submit wins by seat order is enough; real score computed server-side check
// Use the real scoring helper via the server's own expectation: submit matching client score.
const scoreFor = (n) => view.body.schedule.slice(0, n).reduce((sum, t) => sum + t.points, 0);
const s1 = await api(`/api/matches/${gameId}/submit`, { method: "POST", cookie: a.cookie, body: { seat: 1, hits, misses: [], clientScore: scoreFor(30) } });
const s2 = await api(`/api/matches/${gameId}/submit`, { method: "POST", cookie: b.cookie, body: { seat: 2, hits: [], misses: [], clientScore: 0 } });
console.log("submit:", s1.status, s2.status, "settled:", s2.body?.settled);

const after = await api("/api/matchmaking", { cookie: a.cookie });
console.log("after match -> queue:", after.body.status, after.body.gameId);
const again = await api("/api/matchmaking", { method: "POST", cookie: a.cookie, body: { entryXlm: 0, demo: true } });
console.log("play again -> queue:", again.body.status, "newQueueId:", again.body.queueId !== q1.body.queueId, "gameId:", again.body.gameId);
const pass = s2.body?.settled === true && after.body.status === "idle" && again.body.status === "searching" && again.body.gameId === null;
console.log(pass ? "PASS: play again starts a fresh search" : "FAIL");
for (const p of [a, b]) await api("/api/matchmaking", { method: "DELETE", cookie: p.cookie });
