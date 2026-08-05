const T = "96ea1dd4a52c8f2864e15a0e01007de56eac091c91abb74d";
(globalThis as any).location = { protocol: "http:", host: "127.0.0.1:5699", search: `?token=${T}` };
const Effect = await import("effect/Effect");
const { buildShellSnapshot } = await import("./src/loop/handlers/shell.ts");
try {
  const snap: any = await Effect.runPromise(buildShellSnapshot() as any);
  console.log("OK projects:", snap.projects.length, "threads:", snap.threads.length);
  console.log("first project:", JSON.stringify(snap.projects[0]));
  console.log("first thread:", JSON.stringify(snap.threads[0]));
} catch (e) {
  console.log("FAILED:", String(e).slice(0, 2500));
}
process.exit(0);
