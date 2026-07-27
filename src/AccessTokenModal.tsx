import { useEffect, useState } from "react";
import { fetchKiteAccessToken, type KiteAccessToken } from "./api.ts";

interface Props {
  onClose: () => void;
}

/**
 * Full-admin modal that displays the current Zerodha access token (and API key)
 * with one-click copy buttons, so it can be reused in other tools without a
 * second Zerodha login.
 */
export default function AccessTokenModal({ onClose }: Props) {
  const [data, setData] = useState<KiteAccessToken | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState<"token" | "key" | null>(null);

  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(null);
    fetchKiteAccessToken()
      .then((d) => {
        if (alive) setData(d);
      })
      .catch((err: unknown) => {
        if (alive)
          setError(err instanceof Error ? err.message : "Failed to load access token.");
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  async function copy(value: string, which: "token" | "key") {
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // Fallback for browsers without the async clipboard API.
      const ta = document.createElement("textarea");
      ta.value = value;
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      document.execCommand("copy");
      document.body.removeChild(ta);
    }
    setCopied(which);
    window.setTimeout(() => setCopied((c) => (c === which ? null : c)), 1500);
  }

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal modal--md" onClick={(e) => e.stopPropagation()}>
        <header className="modal-head">
          <div>
            <h2>Zerodha Access Token</h2>
            <p className="modal-sub">
              Today&apos;s token{data?.login_date ? ` · ${data.login_date}` : ""}
            </p>
          </div>
          <button className="modal-x" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </header>

        <div className="modal-body" style={{ padding: "1.25rem" }}>
          {loading ? (
            <div className="empty" style={{ padding: "1rem" }}>
              <span className="spinner" /> Loading access token…
            </div>
          ) : error ? (
            <div className="banner banner--error" style={{ margin: 0 }}>
              {error}
            </div>
          ) : data ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "1rem" }}>
              <TokenField
                label="Access Token"
                value={data.access_token}
                copied={copied === "token"}
                onCopy={() => void copy(data.access_token, "token")}
              />
              {data.api_key && (
                <TokenField
                  label="API Key"
                  value={data.api_key}
                  copied={copied === "key"}
                  onCopy={() => void copy(data.api_key, "key")}
                />
              )}
              <p className="token-note">
                Zerodha issues one access token per API key each day. It expires
                overnight, so copy a fresh one after each login.
              </p>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
}

function TokenField({
  label,
  value,
  copied,
  onCopy,
}: {
  label: string;
  value: string;
  copied: boolean;
  onCopy: () => void;
}) {
  return (
    <div>
      <div className="token-label">
        {label}
      </div>
      <div style={{ display: "flex", gap: "0.5rem", alignItems: "stretch" }}>
        <code className="token-field token-value" style={{ flex: 1 }}>
          {value}
        </code>
        <button
          className={`btn${copied ? " btn--primary" : ""}`}
          style={{ whiteSpace: "nowrap" }}
          onClick={onCopy}
        >
          {copied ? "Copied!" : "Copy"}
        </button>
      </div>
    </div>
  );
}
