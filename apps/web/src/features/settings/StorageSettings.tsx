import { FolderOpen, RefreshCw } from "lucide-react";
import { useEffect, useState } from "react";

export function StorageSettings() {
  const storage = window.fathom?.storage;
  const [info, setInfo] = useState<FathomStorageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<"cache" | "data" | "restart" | null>(null);

  const refresh = async () => {
    if (storage === undefined) return;
    try {
      setInfo(await storage.getInfo());
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "无法读取存储位置");
    }
  };

  useEffect(() => {
    if (storage === undefined) return;
    let cancelled = false;
    storage
      .getInfo()
      .then((next) => {
        if (!cancelled) setInfo(next);
      })
      .catch((cause: unknown) => {
        if (!cancelled) setError(cause instanceof Error ? cause.message : "无法读取存储位置");
      });
    return () => {
      cancelled = true;
    };
  }, [storage]);

  if (storage === undefined) {
    return (
      <div className="settings-skeleton">
        数据和缓存目录只能在 Fathom 桌面客户端中修改；当前浏览器开发模式使用默认位置。
      </div>
    );
  }

  const choose = async (kind: "cache" | "data") => {
    setBusy(kind);
    setError(null);
    setNotice(null);
    try {
      const result =
        kind === "data"
          ? await storage.chooseDataDirectory()
          : await storage.chooseCacheDirectory();
      if (result.canceled === true) return;
      if (result.error !== undefined) {
        setError(result.error);
        return;
      }
      if (result.changed === true) {
        setNotice("位置已保存，重启 Fathom 后生效。");
        await refresh();
      }
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "更改存储位置失败");
    } finally {
      setBusy(null);
    }
  };

  const open = async (kind: "cache" | "data") => {
    try {
      if (kind === "data") await storage.openDataDirectory();
      else await storage.openCacheDirectory();
    } catch (cause: unknown) {
      setError(cause instanceof Error ? cause.message : "无法打开目录");
    }
  };

  return (
    <div className="storage-settings">
      {error !== null ? <p className="settings-inline-error">{error}</p> : null}
      {notice !== null ? <p className="settings-notice success">{notice}</p> : null}

      {info === null ? (
        <div className="settings-skeleton">正在读取存储位置…</div>
      ) : (
        <div className="storage-rows">
          <StorageRow
            busy={busy === "data"}
            configuredPath={info.configuredDataDir}
            currentPath={info.dataDir}
            description={
              info.migrationPending
                ? "重启后会先将当前数据复制到新目录；原目录不会自动删除。"
                : "会话、SQLite、文献、附件与模型凭据。"
            }
            label="数据目录"
            onChange={() => void choose("data")}
            onOpen={() => void open("data")}
          />
          <StorageRow
            busy={busy === "cache"}
            configuredPath={info.configuredCacheDir}
            currentPath={info.cacheDir}
            description="Electron 缓存、desktop.log 与可重新生成的缓存文件。"
            label="缓存目录"
            onChange={() => void choose("cache")}
            onOpen={() => void open("cache")}
          />
        </div>
      )}

      <div className="storage-footer">
        <span>更改位置后需要重启客户端。</span>
        <button
          className="btn btn-ghost"
          disabled={busy !== null}
          onClick={() => {
            setBusy("restart");
            void storage.restart().catch((cause: unknown) => {
              setBusy(null);
              setError(cause instanceof Error ? cause.message : "重启失败");
            });
          }}
          type="button"
        >
          <RefreshCw size={14} />
          {busy === "restart" ? "重启中…" : "立即重启"}
        </button>
      </div>
    </div>
  );
}

function StorageRow(props: {
  busy: boolean;
  configuredPath: string;
  currentPath: string;
  description: string;
  label: string;
  onChange: () => void;
  onOpen: () => void;
}) {
  const pending = props.configuredPath !== props.currentPath;
  return (
    <div className="storage-row">
      <div className="storage-row-copy">
        <strong>{props.label}</strong>
        <code title={props.configuredPath}>{props.configuredPath}</code>
        <small>{props.description}</small>
        {pending ? <span className="storage-pending">重启后切换到新目录</span> : null}
      </div>
      <div className="storage-row-actions">
        <button className="btn btn-ghost" onClick={props.onOpen} type="button">
          <FolderOpen size={14} />
          打开
        </button>
        <button
          className="btn btn-ghost"
          disabled={props.busy}
          onClick={props.onChange}
          type="button"
        >
          {props.busy ? "选择中…" : "更改…"}
        </button>
      </div>
    </div>
  );
}
