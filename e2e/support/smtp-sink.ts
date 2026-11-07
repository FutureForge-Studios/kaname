import { createServer, type Server, type Socket } from "node:net";

/* ------------------------------------------------------------------ *
 * A mail server that only listens.
 *
 * Enough SMTP for nodemailer with `security: none`: EHLO, AUTH PLAIN and
 * LOGIN, MAIL, RCPT, DATA, QUIT. Every message it accepts is kept, with
 * the credentials the client authenticated with, so a spec can prove
 * that "Send test email" really sent one — through the stored, sealed
 * password — rather than that a button turned green.
 * ------------------------------------------------------------------ */

export interface ReceivedMail {
  from: string;
  to: string[];
  data: string;
  auth: { user: string; pass: string } | null;
}

export interface SmtpSink {
  port: number;
  received: ReceivedMail[];
  close(): Promise<void>;
}

export async function startSmtpSink(): Promise<SmtpSink> {
  const received: ReceivedMail[] = [];
  const sockets = new Set<Socket>();

  const server: Server = createServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.setEncoding("utf8");

    let buffer = "";
    let mode: "command" | "data" | "auth-user" | "auth-pass" = "command";
    let current: ReceivedMail = { from: "", to: [], data: "", auth: null };
    let auth: ReceivedMail["auth"] = null;
    let pendingUser = "";

    const reply = (line: string) => socket.write(`${line}\r\n`);
    reply("220 sink.kaname.test ESMTP");

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      for (;;) {
        if (mode === "data") {
          const end = buffer.indexOf("\r\n.\r\n");
          if (end < 0) return;
          current.data = buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          received.push({ ...current, auth });
          current = { from: "", to: [], data: "", auth: null };
          mode = "command";
          reply("250 2.0.0 queued");
          continue;
        }
        const newline = buffer.indexOf("\r\n");
        if (newline < 0) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);

        if (mode === "auth-user") {
          pendingUser = Buffer.from(line, "base64").toString("utf8");
          mode = "auth-pass";
          reply(`334 ${Buffer.from("Password:").toString("base64")}`);
          continue;
        }
        if (mode === "auth-pass") {
          auth = { user: pendingUser, pass: Buffer.from(line, "base64").toString("utf8") };
          mode = "command";
          reply("235 2.7.0 Authentication successful");
          continue;
        }

        const verb = line.split(" ")[0]!.toUpperCase();
        if (verb === "EHLO") {
          socket.write("250-sink.kaname.test\r\n250-AUTH PLAIN LOGIN\r\n250 8BITMIME\r\n");
        } else if (verb === "HELO") {
          reply("250 sink.kaname.test");
        } else if (verb === "AUTH") {
          const [, method, initial] = line.split(" ");
          if (method?.toUpperCase() === "PLAIN" && initial) {
            const [, user, pass] = Buffer.from(initial, "base64").toString("utf8").split("\u0000");
            auth = { user: user ?? "", pass: pass ?? "" };
            reply("235 2.7.0 Authentication successful");
          } else if (method?.toUpperCase() === "LOGIN") {
            mode = "auth-user";
            reply(`334 ${Buffer.from("Username:").toString("base64")}`);
          } else {
            reply("504 5.5.4 Unrecognized authentication type");
          }
        } else if (verb === "MAIL") {
          current.from = line.replace(/^MAIL FROM:\s*/i, "").replace(/[<>]/g, "").split(" ")[0]!;
          reply("250 2.1.0 OK");
        } else if (verb === "RCPT") {
          current.to.push(line.replace(/^RCPT TO:\s*/i, "").replace(/[<>]/g, "").split(" ")[0]!);
          reply("250 2.1.5 OK");
        } else if (verb === "DATA") {
          mode = "data";
          reply("354 End data with <CR><LF>.<CR><LF>");
        } else if (verb === "RSET") {
          current = { from: "", to: [], data: "", auth: null };
          reply("250 OK");
        } else if (verb === "NOOP") {
          reply("250 OK");
        } else if (verb === "QUIT") {
          reply("221 Bye");
          socket.end();
        } else {
          reply("502 5.5.2 Command not recognized");
        }
      }
    });
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("smtp sink did not bind");

  return {
    port: address.port,
    received,
    close: () =>
      new Promise((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}
