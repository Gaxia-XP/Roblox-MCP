/**
 * server/lib/open-cloud.mjs
 * Roblox Open Cloud Assets API client (zero deps; global fetch/FormData/Blob, Node 18+).
 * uploadAsset: multipart POST /assets/v1/assets (assetType Model, .glb accepted as
 * model/gltf-binary, creator.userId as string). pollOperation: GET the operation
 * until done:true, return response.assetId. The x-api-key never reaches a log.
 */
import { readFile } from "node:fs/promises";
import { basename } from "node:path";
import { redactHeaders } from "./http-bridge.mjs";

const CONTENT_TYPE = { glb: "model/gltf-binary", gltf: "model/gltf+json", fbx: "model/fbx", obj: "model/obj" };

function logErr(scope, headers, msg) {
  // Headers are scrubbed before logging — x-api-key must never appear.
  console.error(`[open-cloud] ${scope}: ${msg} (headers: ${JSON.stringify(redactHeaders(headers))})`);
}

export async function uploadAsset({ apiKey, creatorId, creatorType = "User", filePath, displayName, description = "", baseUrl = "https://apis.roblox.com" }) {
  if (!apiKey) throw new Error("missing apiKey");
  if (!creatorId) throw new Error("missing creatorId");
  const ext = (filePath.split(".").pop() || "glb").toLowerCase();
  const bytes = await readFile(filePath);
  if (bytes.length > 20 * 1024 * 1024) throw new Error(`file ${bytes.length}B exceeds 20MB Open Cloud cap`);

  const creator = creatorType === "Group" ? { groupId: String(creatorId) } : { userId: String(creatorId) };
  const request = { assetType: "Model", displayName, description, creationContext: { creator } };

  const form = new FormData();
  form.append("request", JSON.stringify(request));
  form.append("fileContent", new Blob([bytes], { type: CONTENT_TYPE[ext] || "model/gltf-binary" }), basename(filePath));

  const headers = { "x-api-key": apiKey };
  const res = await fetch(`${baseUrl}/assets/v1/assets`, { method: "POST", headers, body: form });
  if (!res.ok) {
    logErr("upload", headers, `HTTP ${res.status}`);
    const text = await res.text().catch(() => "");
    throw new Error(`upload failed: HTTP ${res.status} ${text.slice(0, 200)}`);
  }
  const json = await res.json();
  const operationId = json.operationId || (json.path || "").split("/").pop();
  if (!operationId) throw new Error(`no operationId in upload response: ${JSON.stringify(json)}`);
  return { operationId, path: json.path };
}

export async function pollOperation({ apiKey, operationId, baseUrl = "https://apis.roblox.com", maxAttempts = 20, initialDelayMs = 1000 }) {
  const headers = { "x-api-key": apiKey };
  let delay = initialDelayMs;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    await new Promise((r) => setTimeout(r, delay));
    const res = await fetch(`${baseUrl}/assets/v1/operations/${operationId}`, { headers });
    if (res.status === 429) {
      const ra = Number(res.headers.get("retry-after"));
      delay = Number.isFinite(ra) && ra > 0 ? ra * 1000 : Math.min(delay * 2, 15000);
      continue;
    }
    if (!res.ok) {
      logErr("poll", headers, `HTTP ${res.status}`);
      throw new Error(`poll failed: HTTP ${res.status}`);
    }
    const json = await res.json();
    if (json.done) {
      if (json.error) throw new Error(`operation failed: ${JSON.stringify(json.error)}`);
      const assetId = json.response && json.response.assetId;
      if (!assetId) throw new Error(`done but no assetId: ${JSON.stringify(json)}`);
      return { assetId: String(assetId) };
    }
    delay = Math.min(delay * 1.5, 8000);
  }
  throw new Error(`operation ${operationId} not done after ${maxAttempts} polls`);
}
