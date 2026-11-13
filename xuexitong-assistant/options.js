import { parseEndpoint } from "./model.js";

const get = (id) => document.getElementById(id);
const form = get("settings");
const baseUrl = get("base-url");
const model = get("model");
const key = get("key");
const remember = get("remember");
const status = get("status");
const controls = [...form.elements];
let configuredBase;

function report(message, error = false) {
  status.textContent = message;
  status.classList.toggle("error", error);
}

async function send(type, value) {
  const reply = await chrome.runtime.sendMessage({ type, value });
  if (!reply?.ok) throw new Error(reply?.error || "扩展后台未响应。");
  return reply.data;
}

async function busy(action) {
  controls.forEach((control) => { control.disabled = true; });
  try {
    await action();
  } catch (error) {
    report(error.message, true);
  } finally {
    controls.forEach((control) => { control.disabled = false; });
  }
}

async function save() {
  const address = parseEndpoint(baseUrl.value);
  const inputKey = key.value.trim();
  const previousOrigin = configuredBase ? parseEndpoint(configuredBase).origin : undefined;
  if (previousOrigin && previousOrigin !== address.origin && !inputKey) {
    throw new Error("API 域名已更改，请重新输入该服务商的 API Key。");
  }
  const granted = await chrome.permissions.request({ origins: [address.origin] });
  if (!granted) throw new Error("请允许扩展访问配置的 API 域名。");
  await send("save-config", { baseUrl: address.base, model: model.value, key: inputKey, remember: remember.checked });
  if (previousOrigin && previousOrigin !== address.origin) {
    await chrome.permissions.remove({ origins: [previousOrigin] }).catch(() => {});
  }
  configuredBase = address.base;
  baseUrl.value = address.base;
  key.value = "";
  if (inputKey) key.placeholder = "已配置，留空以保留当前密钥";
}

form.addEventListener("submit", (event) => {
  event.preventDefault();
  busy(async () => {
    await save();
    report("设置已保存。");
  });
});

get("test").addEventListener("click", () => {
  if (!form.reportValidity()) return;
  busy(async () => {
    report("正在连接模型…");
    await save();
    await send("test-config");
    report("连接成功，模型已返回测试回复。");
  });
});

get("clear").addEventListener("click", () => busy(async () => {
  await send("clear-config-key");
  key.value = "";
  key.placeholder = "输入模型服务商签发的 Key";
  remember.checked = false;
  report("API Key 已清除。");
}));

busy(async () => {
  const config = await send("get-config");
  configuredBase = config.baseUrl;
  baseUrl.value = config.baseUrl || "";
  model.value = config.model || "";
  remember.checked = config.remember;
  if (config.hasKey) key.placeholder = "已配置，留空以保留当前密钥";
  report(config.hasKey ? "已配置 API Key。" : "填写模型信息后保存或测试连接。");
});
