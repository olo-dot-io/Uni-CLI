/**
 * WebSocket pipeline step — connect, send, receive.
 * For OBS Studio (obs-websocket 5.x) and similar WebSocket services.
 */

import WebSocket from "ws";
import { createHash } from "node:crypto";

export interface WebsocketStepConfig {
  url: string;
  auth?: {
    password_env?: string;
    password?: string;
  };
  send: string;
  parse?: "json" | "text";
  timeout?: number;
}

/**
 * OBS WebSocket 5.x authentication handshake.
 * obs-websocket uses SHA256 challenge-response.
 */
async function obsAuth(
  ws: WebSocket,
  password: string,
  challenge: string,
  salt: string,
): Promise<void> {
  const secret = createHash("sha256")
    .update(password + salt)
    .digest("base64");
  const authResponse = createHash("sha256")
    .update(secret + challenge)
    .digest("base64");

  ws.send(
    JSON.stringify({
      op: 1, // Identify
      d: { rpcVersion: 1, authentication: authResponse },
    }),
  );

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("OBS auth timeout")), 5000);
    ws.once("message", (raw) => {
      clearTimeout(timer);
      const msg = JSON.parse(String(raw));
      if (msg.op === 2)
        resolve(); // Identified response
      else reject(new Error(`OBS auth failed: ${JSON.stringify(msg)}`));
    });
  });
}

/**
 * Execute a WebSocket request: connect → optional auth → send → receive → close.
 */
export async function executeWebsocket(
  config: WebsocketStepConfig,
): Promise<unknown> {
  const timeout = config.timeout ?? 5000;

  return new Promise((resolve, reject) => {
    const ws = new WebSocket(config.url);
    const timer = setTimeout(() => {
      ws.close();
      reject(new Error(`WebSocket timeout after ${timeout}ms`));
    }, timeout);

    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    ws.on("open", async () => {
      try {
        // Handle OBS-style auth if configured
        if (config.auth) {
          const password =
            (config.auth.password_env
              ? process.env[config.auth.password_env]
              : undefined) ??
            config.auth.password ??
            "";

          // Wait for Hello message (op: 0) from OBS
          const hello = await new Promise<Record<string, unknown>>(
            (res, rej) => {
              const helloTimer = setTimeout(
                () => rej(new Error("No Hello from OBS")),
                5000,
              );
              ws.once("message", (raw) => {
                clearTimeout(helloTimer);
                res(JSON.parse(String(raw)));
              });
            },
          );

          if ((hello as { op: number }).op === 0) {
            const data = (
              hello as {
                d: { authentication?: { challenge: string; salt: string } };
              }
            ).d;
            if (data.authentication) {
              await obsAuth(
                ws,
                password,
                data.authentication.challenge,
                data.authentication.salt,
              );
            }
          }
        }

        // Send the message
        ws.send(config.send);

        // Wait for response
        ws.once("message", (raw) => {
          clearTimeout(timer);
          ws.close();
          const text = String(raw);
          if (config.parse === "text") {
            resolve(text);
          } else {
            // Default: try JSON parse, fall back to text
            try {
              resolve(JSON.parse(text));
            } catch {
              resolve(text);
            }
          }
        });
      } catch (err) {
        clearTimeout(timer);
        ws.close();
        reject(err);
      }
    });
  });
}
