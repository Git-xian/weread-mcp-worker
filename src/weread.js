export const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
export const SKILL_VERSION = "1.0.4";

// 只保留有值的字段，避免 null/undefined 平铺进 body 干扰后端默认值。
export function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

// 统一走官方网关。key 来自 Worker Secret，绝不打印、绝不写进任何回包。
export async function callGateway(apiName, params = {}, env) {
  const key = env?.WEREAD_API_KEY;
  if (!key) {
    throw new Error("未配置 WEREAD_API_KEY。请在 Cloudflare 用 `wrangler secret put WEREAD_API_KEY` 设置。");
  }

  const body = JSON.stringify({
    api_name: apiName,
    skill_version: SKILL_VERSION,
    ...prune(params),
  });

  const res = await fetch(GATEWAY, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${key}`,
      "Content-Type": "application/json",
    },
    body,
  });

  const text = await res.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    throw new Error(`${apiName} 返回非 JSON（HTTP ${res.status}）：${text.slice(0, 300)}`);
  }

  if (json.errcode && json.errcode !== 0) {
    throw new Error(
      `${apiName} 调用失败 errcode=${json.errcode}：${json.errmsg || JSON.stringify(json).slice(0, 200)}`
    );
  }
  return json;
}
