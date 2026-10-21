import { Client } from "ssh2";
import {
  CubbyConnectTimeoutError,
  CubbyHostKeyMismatchError,
  hostKeyMatches,
  type SshTransport,
} from "./cubbyRunJob.js";

/** Real `ssh2` transport: pinned host key, key auth only, output captured. */
export const ssh2Transport: SshTransport = (req) =>
  new Promise((resolve, reject) => {
    const conn = new Client();
    let hostKeyBad = false;
    let settled = false;
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      conn.end();
      fn();
    };

    conn
      .on("ready", () => {
        conn.exec(req.command, (err, stream) => {
          if (err) return done(() => reject(err));
          let output = "";
          stream.on("data", (d: Buffer) => (output += d.toString("utf8")));
          stream.stderr.on("data", (d: Buffer) => (output += d.toString("utf8")));
          stream.on("close", (code: number | null, signal: string | null) =>
            done(() =>
              resolve({
                exitCode: code ?? 255,
                output: signal ? `${output}\n[terminated by signal ${signal}]` : output,
              }),
            ),
          );
        });
      })
      .on("error", (err: Error & { level?: string; code?: string }) => {
        if (hostKeyBad) return done(() => reject(new CubbyHostKeyMismatchError("cubby host key does not match CUBBY_SSH_HOST_KEY")));
        // ssh2 reports connect-phase timeouts as level "client-timeout".
        if (err.level === "client-timeout") return done(() => reject(new CubbyConnectTimeoutError("ssh connect timeout")));
        done(() => reject(err));
      })
      .connect({
        host: req.host,
        port: 22,
        username: req.username,
        privateKey: req.privateKey,
        readyTimeout: req.connectTimeoutMs,
        hostVerifier: (key: Buffer) => {
          const ok = hostKeyMatches(req.hostKey, key);
          if (!ok) hostKeyBad = true;
          return ok;
        },
      });
  });
