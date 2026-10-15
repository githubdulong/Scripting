// node:net 的 TCP 客户端包装成 ByteStream。
//
// 只用于连接设备的 RemotePairing 端口（隧道外、经回环反射地址）。
// 隧道内的连接由 VPN.localDevVPN 提供，不走这里。

import { createConnection, type Socket } from "node:net";
import type { ByteStream } from "./stream";

export function wrapSocket(socket: Socket): ByteStream {
  const queue: Uint8Array[] = [];
  const waiters: {resolve: (chunk: Uint8Array | null) => void; reject: (error: Error) => void}[] = [];
  let queuedBytes = 0;
  let closed = false;
  let failure: Error | null = null;

  function push(chunk: Uint8Array) {
    if (closed) return;
    const waiter = waiters.shift();
    if (waiter) waiter.resolve(chunk);
    else {
      if (queuedBytes + chunk.length > 4 * 1024 * 1024) {
        finish(new Error("配对连接缓冲已超限")); socket.destroy(); return;
      }
      queue.push(chunk); queuedBytes += chunk.length;
    }
  }

  // 出错时要让挂起的 read() 抛出，而不是返回 null——返回 null 会被调用方
  // 当成正常 EOF，真正的错误就被吞掉了。
  function finish(error?: Error) {
    if (error && !failure) failure = error;
    closed = true;
    while (waiters.length > 0) {
      const waiter = waiters.shift()!;
      if (failure) waiter.reject(failure); else waiter.resolve(null);
    }
  }

  socket.on("data", (data: Buffer) => {
    // 必须拷贝而不是开视图：Node 的 Buffer 取自共享内存池，底层随时可能被
    // 回收复用，数据在队列里排队期间就可能被改掉。
    push(new Uint8Array(data));
  });
  socket.on("error", (error: Error) => finish(error));
  socket.on("close", () => finish());
  socket.on("end", () => finish());

  return {
    read(): Promise<Uint8Array | null> {
      const chunk = queue.shift();
      if (chunk) { queuedBytes -= chunk.length; return Promise.resolve(chunk); }
      if (closed) return failure ? Promise.reject(failure) : Promise.resolve(null);
      return new Promise((resolve, reject) => waiters.push({resolve, reject}));
    },
    write(data: Uint8Array): Promise<void> {
      return new Promise((resolve, reject) => {
        if (closed) {
          reject(failure ?? new Error("连接已关闭"));
          return;
        }
        socket.write(data, (error?: Error | null) => (error ? reject(error) : resolve()));
      });
    },
    close(): Promise<void> {
      socket.destroy();
      finish();
      return Promise.resolve();
    },
  };
}

export function connectTCP(host: string, port: number, timeoutMs = 5000): Promise<ByteStream> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host, port, noDelay: true });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error(`连接 ${host}:${port} 超时`));
    }, timeoutMs);

    socket.on("connect", () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(wrapSocket(socket));
    });

    socket.on("error", (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      reject(error);
    });
  });
}

/** 只测连通性，连上立刻断开。用于扫描设备的配对端口。 */
export function probeTCP(host: string, port: number, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;

    function settle(result: boolean) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    }

    const timer = setTimeout(() => settle(false), timeoutMs);
    socket.on("connect", () => settle(true));
    socket.on("error", () => settle(false));
  });
}
