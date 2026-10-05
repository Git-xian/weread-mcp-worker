import worker from "../src/index.js";

async function call(body, headers = {}) {
  const req = new Request("http://localhost/mcp", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json, text/event-stream",
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const res = await worker.fetch(req, {});
  return { status: res.status, ct: res.headers.get("content-type"), text: await res.text() };
}

const init = await call({
  jsonrpc: "2.0", id: 1, method: "initialize",
  params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "0" } },
});
console.log("== initialize ==", init.status, init.ct);
console.log(init.text.slice(0, 300));

const list = await call({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });
console.log("\n== tools/list ==", list.status, list.ct);
try {
  const j = JSON.parse(list.text);
  console.log("tool count:", j.result.tools.length);
  console.log("tools:", j.result.tools.map((t) => t.name).join(", "));
} catch {
  console.log(list.text.slice(0, 400));
}

const bad = await call({ jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "nope", arguments: {} } });
console.log("\n== tools/call(unknown) ==", bad.status);
console.log(bad.text.slice(0, 300));
