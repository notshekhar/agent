const T = "96ea1dd4a52c8f2864e15a0e01007de56eac091c91abb74d";
const ws = new WebSocket(`ws://127.0.0.1:5699/ws?token=${T}`);
await new Promise<void>((r) => (ws.onopen = () => r()));
const call = (m: string, p: any = {}) => new Promise<any>((res) => {
  const id = Math.floor(Math.random() * 1e6);
  const h = (e: MessageEvent) => { const x = JSON.parse(String(e.data)); if (x.id === id) { ws.removeEventListener("message", h); res(x.result); } };
  ws.addEventListener("message", h); ws.send(JSON.stringify({ jsonrpc: "2.0", id, method: m, params: p }));
});
const cat = await call("catalog.list");
const custom = cat.filter((m: any) => String(m.provider).includes(":") || String(m.id).includes(":"));
console.log("custom models:", custom.length);
console.log(JSON.stringify(custom.slice(0, 3), null, 1));
const rows = await call("session.list");
const providers = new Set(rows.map((r: any) => r.provider));
console.log("session providers:", [...providers].join(", "));
process.exit(0);
