import { request } from "./network.mjs";
export const BASE = "https://huangguoai.com";
export async function edge(path, method = "GET", body = null, token = "") {
  if (!path.startsWith("/api/") || path.includes("://"))
    throw Error("Invalid catalog request");
  const envelope = JSON.stringify({
    method,
    path,
    body:
      body === null ? "" : Buffer.from(JSON.stringify(body)).toString("base64"),
    content_type: body === null ? "" : "application/json",
  });
  const r = await request(`${BASE}/api/edge/request`, {
    method: "POST",
    body: envelope,
    max: 8 * 1024 * 1024,
    headers: {
      "Content-Type": "application/json",
      Referer: BASE + "/",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
  });
  const v = JSON.parse(r.bytes.toString());
  if (v.status !== 1)
    throw Error(
      typeof v.msg === "string" && !/[\u3400-\u9fff]/.test(v.msg)
        ? v.msg
        : "The video service rejected this request. Check your login or try another episode.",
    );
  return v.data;
}
export async function playback(id, ep, token) {
  let v;
  try {
    v = await edge(
      `/api/videos/${id}/episodes/${ep}/playback`,
      "POST",
      {},
      token,
    );
  } catch {}
  if (!(v?.streams?.main || v?.video_url))
    v = await edge(
      `/api/videos/${id}/play?ep=${ep}&page_texts=0`,
      "GET",
      null,
      token,
    );
  return {
    ...v,
    video_url: v.streams?.main || v.video_url,
    video_url_hevc: v.streams?.hevc || v.video_url_hevc,
  };
}
