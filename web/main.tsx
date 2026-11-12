import React, {
  useEffect,
  useState,
  useRef,
  createContext,
  useContext,
} from "react";
import { createRoot } from "react-dom/client";
import Hls from "hls.js";
import "./style.css";
type Video = {
  id: number;
  video_id?: number;
  title: string;
  description?: string;
  cover?: string;
  tags?: string[];
  episode_count?: number;
  total_episodes?: number;
  episodes?: { ep_num: number; title: string }[];
  author?: { id: number; name: string };
};
type Progress = { id: number; ep: number; t: number; dur: number; at: number };
type Shared = {
  favs: number[];
  likes: number[];
  follows: number[];
  history: Progress[];
  searchHist: string[];
  blockedTags: string[];
  blockedCreators: (number | string)[];
  hideWatched: boolean;
};
type Job = {
  key: string;
  id: number;
  ep: number;
  title: string;
  quality: string;
  status: string;
  progress: number;
  bytes: number;
  error?: string;
};
async function api<T = any>(
  url: string,
  data?: unknown,
  method?: string,
): Promise<T> {
  const r = await fetch(url, {
    method: method || (data === undefined ? "GET" : "POST"),
    headers: data === undefined ? {} : { "Content-Type": "application/json" },
    body: data === undefined ? undefined : JSON.stringify(data),
  });
  const v = await r.json();
  if (!r.ok) throw Error(v.error || `HTTP ${r.status}`);
  return v;
}
const catalog = (action: string, args: object = {}) =>
  api("/api/catalog", { action, ...args });
const Translation = createContext({
  enabled: true,
  configured: false,
  showOriginal: false,
});
const cache = new Map<string, string>(),
  pending = new Map<string, Promise<string>>();
function translated(text: string) {
  if (cache.has(text)) return Promise.resolve(cache.get(text)!);
  let p = pending.get(text);
  if (!p) {
    p = api("/api/translate", { text })
      .then((r) => {
        cache.set(text, r.text);
        return r.text;
      })
      .finally(() => pending.delete(text));
    pending.set(text, p);
  }
  return p;
}
function Text({
  text = "",
  as = "span",
}: {
  text?: string;
  as?: "span" | "p" | "h2";
}) {
  const config = useContext(Translation);
  const [value, setValue] = useState(cache.get(text) || text);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let alive = true;
    setFailed(false);
    setValue(text);
    if (config.enabled && config.configured && /[\u3400-\u9fff]/.test(text))
      translated(text)
        .then((v) => {
          if (alive) setValue(v);
        })
        .catch(() => {
          if (alive) setFailed(true);
        });
    return () => {
      alive = false;
    };
  }, [text, config.enabled, config.configured]);
  const Tag = as;
  return (
    <Tag title={text}>
      {value}
      {config.showOriginal && value !== text && (
        <small className="original">{text}</small>
      )}
      {failed && <small className="original">Translation unavailable</small>}
    </Tag>
  );
}
const media = (url: string, image = false) =>
  `/media?u=${encodeURIComponent(url)}${image ? "&image=1" : ""}`;
const size = (n: number) => `${(n / 1024 ** 2).toFixed(1)} MB`;
function Player({
  url,
  onProgress,
  start = 0,
}: {
  url: string;
  onProgress?: (t: number, dur: number) => void;
  start?: number;
}) {
  const ref = useRef<HTMLVideoElement>(null);
  const [error, setError] = useState("");
  const last = useRef(0);
  useEffect(() => {
    const video = ref.current!;
    let hls: Hls | undefined;
    setError("");
    if (url.startsWith("/offline/")) video.src = url;
    else if (video.canPlayType("application/vnd.apple.mpegurl"))
      video.src = media(url);
    else if (Hls.isSupported()) {
      hls = new Hls({
        enableWorker: true,
        interstitialsController: undefined,
        contentSteeringController: undefined,
        enableInterstitialPlayback: false,
      });
      hls.loadSource(media(url));
      hls.attachMedia(video);
      hls.on(Hls.Events.ERROR, (_, d) => {
        if (d.fatal)
          setError(
            "Playback failed. Try another quality or reload the episode.",
          );
      });
    } else setError("This browser does not support this stream");
    return () => {
      if (Number.isFinite(video.duration) && video.currentTime > 0)
        onProgress?.(video.currentTime, video.duration);
      hls?.destroy();
      video.removeAttribute("src");
      video.load();
    };
  }, [url]);
  return (
    <>
      <video
        ref={ref}
        controls
        playsInline
        preload="metadata"
        onLoadedMetadata={() => {
          if (ref.current && start > 0) ref.current.currentTime = start;
        }}
        onTimeUpdate={() => {
          const v = ref.current!;
          if (Date.now() - last.current > 5000 && Number.isFinite(v.duration)) {
            last.current = Date.now();
            onProgress?.(v.currentTime, v.duration);
          }
        }}
        onError={() =>
          setError(
            "The browser could not decode this video. Try standard quality; HEVC support varies.",
          )
        }
      />
      {error && (
        <p role="alert" className="error">
          {error}
        </p>
      )}
    </>
  );
}
function App() {
  const [ready, setReady] = useState(false),
    [password, setPassword] = useState(""),
    [error, setError] = useState(""),
    [notice, setNotice] = useState("");
  const [status, setStatus] = useState<any>({
      translation: { configured: false },
    }),
    [shared, setShared] = useState<Shared>({
      favs: [],
      likes: [],
      follows: [],
      history: [],
      searchHist: [],
      blockedTags: [],
      blockedCreators: [],
      hideWatched: false,
    });
  const sharedRef = useRef(shared);
  sharedRef.current = shared;
  const [tab, setTab] = useState("browse"),
    [videos, setVideos] = useState<Video[]>([]),
    [loading, setLoading] = useState(false),
    [page, setPage] = useState(1),
    [pages, setPages] = useState(1),
    [query, setQuery] = useState(""),
    [search, setSearch] = useState(""),
    [scope, setScope] = useState("feed"),
    [category, setCategory] = useState(""),
    [tags, setTags] = useState<any[]>([]),
    [englishSearch, setEnglishSearch] = useState(true);
  const [detail, setDetail] = useState<Video | null>(null),
    [episode, setEpisode] = useState(1),
    [quality, setQuality] = useState("standard"),
    [stream, setStream] = useState(""),
    [playLoading, setPlayLoading] = useState(false),
    [jobs, setJobs] = useState<Job[]>([]),
    [offline, setOffline] = useState<Job | null>(null),
    [selection, setSelection] = useState<number[]>([]);
  const [translate, setTranslate] = useState(
      localStorage.getItem("english-translate") !== "false",
    ),
    [original, setOriginal] = useState(
      localStorage.getItem("english-original") === "true",
    );
  const [blockTags, setBlockTags] = useState(""),
    [blockCreators, setBlockCreators] = useState("");
  const tell = (e: unknown) =>
    setError(e instanceof Error ? e.message : String(e));
  async function bootstrap() {
    const [s, p] = await Promise.all([
      api("/api/status"),
      api<Shared>("/api/state"),
    ]);
    setStatus(s);
    setShared(p);
    setBlockTags(p.blockedTags.join(", "));
    setBlockCreators(p.blockedCreators.join(", "));
    setReady(true);
  }
  useEffect(() => {
    bootstrap().catch(() => {});
  }, []);
  async function patch(data: Partial<Shared>) {
    const next = await api<Shared>("/api/state", data);
    setShared(next);
    return next;
  }
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    const refresh = () =>
      api<Job[]>("/api/downloads")
        .then((v) => {
          if (alive) setJobs(v);
        })
        .catch(tell);
    refresh();
    const timer = setInterval(refresh, 3000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, [ready]);
  useEffect(() => {
    if (!ready) return;
    let alive = true;
    setLoading(true);
    setError("");
    (async () => {
      let r;
      if (tab === "favorites" || tab === "history") {
        const ids =
          tab === "favorites"
            ? sharedRef.current.favs
            : sharedRef.current.history.map((h) => h.id);
        const slice = ids.slice((page - 1) * 20, page * 20);
        const results = await Promise.allSettled(
          slice.map((id) => catalog("detail", { id })),
        );
        r = {
          items: results
            .filter(
              (x): x is PromiseFulfilledResult<any> => x.status === "fulfilled",
            )
            .map((x) => x.value),
          pagination: { pages: Math.ceil(ids.length / 20) || 1 },
        };
      } else if (tab === "browse")
        r = await catalog(
          search
            ? "search"
            : scope === "category"
              ? "category"
              : scope === "tag"
                ? "tag"
                : scope === "rank"
                  ? "rank"
                  : "feed",
          {
            page,
            size: 20,
            q: search,
            cate: category,
            tag: category,
            kind: "hot",
          },
        );
      else return;
      if (alive) {
        setVideos(
          (r.items || r.videos || []).map((v: Video) => ({
            ...v,
            id: v.id || v.video_id,
          })),
        );
        setPages(r.pagination?.pages || 1);
      }
    })()
      .catch((e) => {
        if (alive) tell(e);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [ready, tab, page, search, scope, category]);
  useEffect(() => {
    if (!detail) {
      setStream("");
      return;
    }
    let alive = true;
    setStream("");
    setPlayLoading(true);
    setError("");
    catalog("play", { id: detail.id, ep: episode })
      .then((info) => {
        if (alive) {
          const url =
            quality === "hevc"
              ? info.video_url_hevc || info.video_url
              : info.video_url;
          if (!url) throw Error("This episode has no playable stream");
          setStream(url);
        }
      })
      .catch((e) => {
        if (alive) tell(e);
      })
      .finally(() => {
        if (alive) setPlayLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [detail?.id, episode, quality]);
  async function open(v: Video) {
    setError("");
    setOffline(null);
    try {
      const latest = await api<Shared>("/api/state");
      setShared(latest);
      const d = await catalog("detail", { id: v.id });
      setSelection([]);
      setEpisode(latest.history.find((h) => h.id === v.id)?.ep || 1);
      setDetail(d);
    } catch (e) {
      tell(e);
    }
  }
  async function find(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    let q = query.trim();
    if (!q) {
      setSearch("");
      return;
    }
    try {
      if (
        englishSearch &&
        status.translation.configured &&
        !/[\u3400-\u9fff]/.test(q)
      )
        q = (await api("/api/translate", { text: q, language: "Chinese" }))
          .text;
      setSearch(q);
      setTab("browse");
      setPage(1);
      await patch({
        searchHist: [
          query,
          ...sharedRef.current.searchHist.filter((x) => x !== query),
        ].slice(0, 12),
      });
    } catch (e) {
      tell(e);
    }
  }
  async function download(episodes: number[]) {
    if (!detail) return;
    setError("");
    try {
      for (const ep of episodes)
        await api("/api/downloads", {
          id: detail.id,
          ep,
          title: cache.get(detail.title) || detail.title,
          quality,
        });
      setNotice(`${episodes.length} episode(s) added to the download queue`);
      setJobs(await api("/api/downloads"));
    } catch (e) {
      tell(e);
    }
  }
  async function jobAction(j: Job, action: string) {
    try {
      if (action === "retry")
        await api("/api/downloads", {
          id: j.id,
          ep: j.ep,
          title: j.title,
          quality: j.quality,
        });
      else
        await api(
          `/api/downloads/${j.key}${action === "cancel" ? "/cancel" : ""}`,
          action === "cancel" ? {} : undefined,
          action === "cancel" ? "POST" : "DELETE",
        );
      setJobs(await api("/api/downloads"));
    } catch (e) {
      tell(e);
    }
  }
  const progress = (id: number, ep: number, t: number, dur: number) => {
    void patch({ history: [{ id, ep, t, dur, at: Date.now() }] }).catch(tell);
  };
  const visible = videos.filter(
    (v) =>
      (tab === "history" ||
        !shared.hideWatched ||
        !shared.history.some((h) => h.id === v.id)) &&
      !v.tags?.some((t) => shared.blockedTags.includes(t)) &&
      !shared.blockedCreators.some(
        (c) => String(c) === String(v.author?.id) || c === v.author?.name,
      ),
  );
  if (!ready)
    return (
      <main className="signin">
        <h1>
          HGhubX <em>English</em>
        </h1>
        <p>Your private video library, shared across your PC and iPad.</p>
        <form
          onSubmit={async (e) => {
            e.preventDefault();
            setError("");
            try {
              await api("/auth", { password });
              setPassword("");
              await bootstrap();
            } catch (e) {
              tell(e);
            }
          }}
        >
          <label>
            Server access password
            <input
              autoFocus
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </label>
          <button>Sign in</button>
        </form>
        <p className="muted">
          Use the password printed on the Windows server’s first launch.
        </p>
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
      </main>
    );
  return (
    <Translation.Provider
      value={{
        enabled: translate,
        configured: status.translation.configured,
        showOriginal: original,
      }}
    >
      <div className="app">
        <header>
          <a href="/" className="brand">
            HGhubX <em>English</em>
          </a>
          <span className="muted">Private library</span>
        </header>
        <nav>
          {[
            ["browse", "Browse"],
            ["favorites", "Favorites"],
            ["history", "Continue watching"],
            ["downloads", "Downloads"],
            ["settings", "Settings"],
          ].map(([k, label]) => (
            <button
              className={tab === k ? "active" : ""}
              key={k}
              onClick={() => {
                setTab(k);
                setDetail(null);
                setOffline(null);
                setPage(1);
              }}
            >
              {label}
            </button>
          ))}
        </nav>
        {error && (
          <div role="alert" className="error">
            {error}
            <button onClick={() => setError("")}>Dismiss</button>
          </div>
        )}
        {notice && (
          <div role="status" className="notice">
            {notice}
            <button onClick={() => setNotice("")}>Dismiss</button>
          </div>
        )}
        <main>
          {!status.translation.configured && (
            <p className="notice">
              English menus are ready. Catalog translation needs an Ollama or
              hosted provider configured on the Windows server. See the setup
              guide.
            </p>
          )}
          {offline && (
            <section className="detail">
              <button onClick={() => setOffline(null)}>Close player</button>
              <h2>
                <Text text={offline.title} />
              </h2>
              <Player
                key={offline.key}
                url={`/offline/${offline.key}`}
                start={
                  shared.history.find(
                    (h) => h.id === offline.id && h.ep === offline.ep,
                  )?.t || 0
                }
                onProgress={(t, d) => progress(offline.id, offline.ep, t, d)}
              />
            </section>
          )}
          {detail && (
            <section className="detail">
              <div className="toolbar">
                <button onClick={() => setDetail(null)}>Back to library</button>
                <button
                  onClick={() =>
                    patch({
                      favs: shared.favs.includes(detail.id)
                        ? shared.favs.filter((x) => x !== detail.id)
                        : [detail.id, ...shared.favs],
                    }).catch(tell)
                  }
                >
                  {shared.favs.includes(detail.id) ? "★ Saved" : "☆ Favorite"}
                </button>
              </div>
              <Text as="h2" text={detail.title} />
              <Text as="p" text={detail.description} />
              <div className="toolbar">
                <label>
                  Episode
                  <select
                    value={episode}
                    onChange={(e) => setEpisode(Number(e.target.value))}
                  >
                    {Array.from(
                      {
                        length: Math.min(
                          detail.episode_count || detail.total_episodes || 1,
                          10000,
                        ),
                      },
                      (_, i) => (
                        <option key={i} value={i + 1}>
                          Episode {i + 1}
                        </option>
                      ),
                    )}
                  </select>
                </label>
                <label>
                  Quality
                  <select
                    value={quality}
                    onChange={(e) => setQuality(e.target.value)}
                  >
                    <option value="standard">Standard (most compatible)</option>
                    <option value="hevc">
                      HEVC / high quality if available
                    </option>
                  </select>
                </label>
                <button onClick={() => download([episode])}>
                  Download episode
                </button>
              </div>
              {playLoading ? (
                <p>Loading stream…</p>
              ) : (
                stream && (
                  <Player
                    key={`${detail.id}-${episode}-${quality}`}
                    url={stream}
                    start={
                      shared.history.find(
                        (h) => h.id === detail.id && h.ep === episode,
                      )?.t || 0
                    }
                    onProgress={(t, d) => progress(detail.id, episode, t, d)}
                  />
                )
              )}
              <details>
                <summary>Select episodes to download</summary>
                <div className="episodes">
                  {Array.from(
                    {
                      length: Math.min(
                        detail.episode_count || detail.total_episodes || 1,
                        10000,
                      ),
                    },
                    (_, i) => (
                      <label key={i}>
                        <input
                          type="checkbox"
                          checked={selection.includes(i + 1)}
                          onChange={(e) =>
                            setSelection(
                              e.target.checked
                                ? [...selection, i + 1]
                                : selection.filter((n) => n !== i + 1),
                            )
                          }
                        />
                        {i + 1}
                      </label>
                    ),
                  )}
                </div>
                <button
                  disabled={!selection.length}
                  onClick={() => download(selection)}
                >
                  Queue {selection.length} selected
                </button>
              </details>
            </section>
          )}
          {["browse", "favorites", "history"].includes(tab) && !detail && (
            <>
              <div className="toolbar">
                <h1>
                  {tab === "favorites"
                    ? "Favorites"
                    : tab === "history"
                      ? "Continue watching"
                      : "Discover"}
                </h1>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={shared.hideWatched}
                    onChange={(e) =>
                      patch({ hideWatched: e.target.checked }).catch(tell)
                    }
                  />
                  Hide watched
                </label>
              </div>
              {tab === "browse" && (
                <>
                  <form className="search" onSubmit={find}>
                    <input
                      aria-label="Search videos"
                      placeholder="Search videos…"
                      value={query}
                      onChange={(e) => setQuery(e.target.value)}
                    />
                    <button>Search</button>
                    <button
                      type="button"
                      onClick={() => {
                        setSearch("");
                        setQuery("");
                        setPage(1);
                      }}
                    >
                      Clear
                    </button>
                  </form>
                  <label className="check">
                    <input
                      type="checkbox"
                      checked={englishSearch}
                      onChange={(e) => setEnglishSearch(e.target.checked)}
                    />
                    Translate English searches to Chinese
                  </label>
                  <div className="toolbar">
                    <button
                      onClick={() => {
                        setScope("feed");
                        setSearch("");
                        setPage(1);
                      }}
                    >
                      Latest
                    </button>
                    <button
                      onClick={() => {
                        setScope("rank");
                        setSearch("");
                        setPage(1);
                      }}
                    >
                      Popular
                    </button>
                    <button
                      onClick={async () => {
                        try {
                          const r = await catalog("tags");
                          setTags(r.categories || []);
                        } catch (e) {
                          tell(e);
                        }
                      }}
                    >
                      Browse tags
                    </button>
                    <select
                      aria-label="Category"
                      value={scope === "category" ? category : ""}
                      onChange={(e) => {
                        setCategory(e.target.value);
                        setScope(e.target.value ? "category" : "feed");
                        setSearch("");
                        setPage(1);
                      }}
                    >
                      <option value="">All categories</option>
                      <option value="ai-duanju">AI short dramas</option>
                      <option value="ai-manju">AI animated dramas</option>
                    </select>
                  </div>
                  {tags.length > 0 && (
                    <details open>
                      <summary>Tags</summary>
                      {tags.map((group, i) => (
                        <div key={i}>
                          <Text text={group.name} />
                          <div className="toolbar">
                            {(group.tags || []).map((t: any, j: number) => (
                              <button
                                key={j}
                                onClick={() => {
                                  setCategory(t.name);
                                  setScope("tag");
                                  setSearch("");
                                  setPage(1);
                                  setTags([]);
                                }}
                              >
                                <Text text={t.name} />
                              </button>
                            ))}
                          </div>
                        </div>
                      ))}
                    </details>
                  )}
                </>
              )}
              {loading ? (
                <p role="status">Loading videos…</p>
              ) : (
                <>
                  <div className="grid">
                    {visible.map((v) => (
                      <article key={v.id}>
                        <button className="card" onClick={() => open(v)}>
                          {v.cover && (
                            <img
                              src={media(v.cover, true)}
                              alt=""
                              loading="lazy"
                            />
                          )}
                          <div>
                            <Text as="h2" text={v.title} />
                            <p className="muted">
                              {v.episode_count || v.total_episodes || 1}{" "}
                              episodes · {v.author?.name || "HGhubX"}
                            </p>
                            <p>
                              {v.tags?.slice(0, 3).map((t) => (
                                <Text key={t} text={t} />
                              ))}
                            </p>
                            {shared.history.find((h) => h.id === v.id) && (
                              <small>
                                Resume episode{" "}
                                {shared.history.find((h) => h.id === v.id)?.ep}
                              </small>
                            )}
                          </div>
                        </button>
                        <button
                          className="favorite"
                          aria-label={`Favorite ${v.title}`}
                          onClick={() =>
                            patch({
                              favs: shared.favs.includes(v.id)
                                ? shared.favs.filter((x) => x !== v.id)
                                : [v.id, ...shared.favs],
                            }).catch(tell)
                          }
                        >
                          {shared.favs.includes(v.id) ? "★ Saved" : "☆ Save"}
                        </button>
                      </article>
                    ))}
                  </div>
                  {!visible.length && (
                    <p>
                      No videos here. Try another search or change your filters.
                    </p>
                  )}
                  <div className="toolbar pagination">
                    <button
                      disabled={page <= 1}
                      onClick={() => setPage(page - 1)}
                    >
                      Previous
                    </button>
                    <span>
                      Page {page} of {pages}
                    </span>
                    <button
                      disabled={page >= pages}
                      onClick={() => setPage(page + 1)}
                    >
                      Next
                    </button>
                  </div>
                </>
              )}
            </>
          )}
          {tab === "downloads" && (
            <>
              <h1>Downloads</h1>
              <p className="muted">
                Files are stored on the Windows server. Standard quality is best
                for iPad playback.
              </p>
              {!jobs.length && <p>Open a video and choose Download episode.</p>}
              {jobs.map((j) => (
                <article className="job" key={j.key}>
                  <Text as="h2" text={j.title} />
                  <p>
                    Episode {j.ep} · {j.quality} · {j.status} · {size(j.bytes)}
                  </p>
                  <progress max="100" value={j.progress} />
                  {j.error && <p className="error">{j.error}</p>}
                  <div className="toolbar">
                    {j.status === "complete" ? (
                      <>
                        <button onClick={() => setOffline(j)}>
                          Play offline copy
                        </button>
                        <a
                          className="button"
                          href={`/offline/${j.key}`}
                          download={`${j.title}-ep${j.ep}.mp4`}
                        >
                          Save MP4 to this device
                        </a>
                        <button
                          onClick={() => {
                            if (confirm("Delete this downloaded file?"))
                              jobAction(j, "delete");
                          }}
                        >
                          Delete
                        </button>
                      </>
                    ) : ["failed", "cancelled"].includes(j.status) ? (
                      <>
                        <button onClick={() => jobAction(j, "retry")}>
                          Retry
                        </button>
                        <button onClick={() => jobAction(j, "delete")}>
                          Remove
                        </button>
                      </>
                    ) : (
                      <button onClick={() => jobAction(j, "cancel")}>
                        Cancel
                      </button>
                    )}
                  </div>
                </article>
              ))}
            </>
          )}
          {tab === "settings" && (
            <>
              <h1>Settings</h1>
              <section>
                <h2>English translation</h2>
                <p>
                  Provider: {status.translation.provider || "off"} · Model:{" "}
                  {status.translation.model}
                </p>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={translate}
                    onChange={(e) => {
                      setTranslate(e.target.checked);
                      localStorage.setItem(
                        "english-translate",
                        String(e.target.checked),
                      );
                    }}
                  />
                  Automatically translate titles, descriptions, and tags
                </label>
                <label className="check">
                  <input
                    type="checkbox"
                    checked={original}
                    onChange={(e) => {
                      setOriginal(e.target.checked);
                      localStorage.setItem(
                        "english-original",
                        String(e.target.checked),
                      );
                    }}
                  />
                  Show original text below translations
                </label>
                <p className="muted">
                  Translations run in the background and are cached on the
                  server. Hosted providers receive the catalog text. Configure
                  provider settings in the Windows environment, then restart.
                </p>
              </section>
              <section>
                <h2>Filters</h2>
                <label>
                  Blocked tags (original names, separated by commas)
                  <input
                    value={blockTags}
                    onChange={(e) => setBlockTags(e.target.value)}
                  />
                </label>
                <label>
                  Blocked creator names or IDs (separated by commas)
                  <input
                    value={blockCreators}
                    onChange={(e) => setBlockCreators(e.target.value)}
                  />
                </label>
                <button
                  onClick={() =>
                    patch({
                      blockedTags: blockTags
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                      blockedCreators: blockCreators
                        .split(",")
                        .map((x) => x.trim())
                        .filter(Boolean),
                    })
                      .then(() => setNotice("Filters saved"))
                      .catch(tell)
                  }
                >
                  Save filters
                </button>
              </section>
              <section>
                <h2>Storage</h2>
                <p>
                  {size(jobs.reduce((n, j) => n + j.bytes, 0))} recorded ·{" "}
                  {status.quotaGB} GB limit · 1 GB minimum free space
                </p>
                <p>
                  Set HGHUB_DATA and HGHUB_QUOTA_GB before starting the server
                  to change location and limit.
                </p>
              </section>
              <section>
                <h2>Upstream account</h2>
                <p>
                  {status.user
                    ? "Signed in. The upstream session stays in server memory until restart."
                    : "Guest browsing. Your local server access password is separate from the video service account."}
                </p>
                <form
                  onSubmit={async (e) => {
                    e.preventDefault();
                    const form = e.currentTarget;
                    const f = new FormData(form);
                    try {
                      await catalog("login", {
                        username: f.get("username"),
                        password: f.get("password"),
                      });
                      form.reset();
                      setStatus(await api("/api/status"));
                      setNotice("Signed in to the video service");
                    } catch (e) {
                      tell(e);
                    }
                  }}
                >
                  <input
                    name="username"
                    placeholder="Service username"
                    autoComplete="username"
                    required
                  />
                  <input
                    name="password"
                    type="password"
                    placeholder="Service password"
                    autoComplete="current-password"
                    required
                  />
                  <button>Sign in to service</button>
                </form>
                <button
                  onClick={() =>
                    catalog("logout")
                      .then(async () => setStatus(await api("/api/status")))
                      .catch(tell)
                  }
                >
                  Sign out of service
                </button>
              </section>
            </>
          )}
        </main>
        <footer>
          HGhubX English · Personal use · One private household library
        </footer>
      </div>
    </Translation.Provider>
  );
}
createRoot(document.getElementById("root")!).render(<App />);
