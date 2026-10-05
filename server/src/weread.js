import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const GATEWAY = "https://i.weread.qq.com/api/agent/gateway";
export const SKILL_VERSION = "1.0.4";

// 本地兜底：默认找「当前用户桌面」的 wxds.txt（可用 WEREAD_KEY_FILE 覆盖）。
// 不写死绝对路径 / 用户名，避免把本机信息带进仓库。
const DEFAULT_KEY_FILE =
  process.env.WEREAD_KEY_FILE || path.join(os.homedir(), "Desktop", "wxds.txt");

// Key 只在服务端使用，绝不打印、绝不写进任何回包。
export function loadKey() {
  const envKey = process.env.WEREAD_API_KEY;
  if (envKey && envKey.trim()) return envKey.trim();
  const file = process.env.WEREAD_KEY_FILE || DEFAULT_KEY_FILE;
  try {
    const k = fs.readFileSync(file, "utf8").trim();
    if (k) return k;
  } catch {
    // 落到下面的统一报错
  }
  throw new Error(
    `未找到微信读书 API Key。请设置环境变量 WEREAD_API_KEY，或把 key 写入文件 ${file}（可用 WEREAD_KEY_FILE 指定其它路径）。`
  );
}

// 只保留有值的字段，避免把 null/undefined 平铺进 body 干扰后端默认值。
export function prune(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined && v !== null) out[k] = v;
  }
  return out;
}

export async function callGateway(apiName, params = {}) {
  const key = loadKey();
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
  if (json.upgrade_info) {
    console.error(`[weread] 网关提示需要升级 skill：${JSON.stringify(json.upgrade_info).slice(0, 300)}`);
  }
  return json;
}
