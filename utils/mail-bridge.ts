import { execFile } from "child_process";
import { promisify } from "util";
import nodemailer, { type Transporter } from "nodemailer";
import MailComposer from "nodemailer/lib/mail-composer/index.js";
import { ImapFlow } from "imapflow";

const execFileAsync = promisify(execFile);

/**
 * Sending through Proton Bridge's local SMTP/IMAP instead of Mail's compose
 * window: Mail wraps any script-set body in a quote block, and scripted drafts
 * do not reliably sync to Proton.
 *
 * The Bridge password lives in the login Keychain, created once by the user:
 *   security add-generic-password -s apple-mcp-proton-bridge -a <address> -w
 */
const KEYCHAIN_SERVICE = "apple-mcp-proton-bridge";

// Bridge listens on localhost only and presents a self-signed certificate.
// ponytail: default ports hardcoded; read them from env if Bridge is ever reconfigured.
const BRIDGE = {
  host: "127.0.0.1",
  smtpPort: 1025,
  imapPort: 1143,
  tls: { rejectUnauthorized: false },
};

export interface BridgeLogin {
  user: string;
  pass: string;
}

export interface BridgeMessage {
  from: string;
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  text: string;
  attachments: string[];
  inReplyTo?: string;
  references?: string;
}

/** Returns null when no Keychain entry exists, so callers can fall back to Mail scripting. */
export async function bridgeLogin(): Promise<BridgeLogin | null> {
  try {
    const { stdout: attrs } = await execFileAsync(
      "security", ["find-generic-password", "-s", KEYCHAIN_SERVICE],
    );
    const user = attrs.match(/"acct"<blob>="([^"]+)"/)?.[1];
    if (!user) return null;
    const { stdout: pass } = await execFileAsync(
      "security", ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-w"],
    );
    return { user, pass: pass.replace(/\n$/, "") };
  } catch {
    return null;
  }
}

export function mailOptions(m: BridgeMessage): Record<string, unknown> {
  return {
    from: m.from,
    to: m.to,
    cc: m.cc,
    bcc: m.bcc,
    subject: m.subject,
    text: m.text,
    attachments: m.attachments.map((path) => ({ path })),
    inReplyTo: m.inReplyTo,
    references: m.references,
  };
}

async function withImap<T>(login: BridgeLogin, fn: (c: ImapFlow) => Promise<T>): Promise<T> {
  const client = new ImapFlow({
    host: BRIDGE.host,
    port: BRIDGE.imapPort,
    secure: false,
    auth: { user: login.user, pass: login.pass },
    tls: BRIDGE.tls,
    logger: false,
  });
  await client.connect();
  try {
    return await fn(client);
  } finally {
    await client.logout().catch(() => {});
  }
}

/** Counts drafts with exactly this subject and optionally deletes them. */
async function matchingDrafts(
  login: BridgeLogin,
  subject: string,
  discard: boolean,
): Promise<number> {
  return withImap(login, async (client) => {
    const lock = await client.getMailboxLock("Drafts");
    try {
      if (!client.mailbox || client.mailbox.exists === 0) return 0;
      const uids: number[] = [];
      for await (const msg of client.fetch("1:*", { envelope: true, uid: true })) {
        if (msg.envelope?.subject === subject) uids.push(msg.uid);
      }
      if (discard && uids.length) await client.messageDelete(uids, { uid: true });
      return uids.length;
    } finally {
      lock.release();
    }
  });
}

/**
 * Bridge's SMTP port is either implicit TLS ("SSL") or STARTTLS, depending on its settings.
 * The mode is settled with verify() (connect and log in, nothing sent), so a wrong guess
 * can never lead to a second send attempt.
 */
async function smtpTransport(login: BridgeLogin): Promise<Transporter> {
  let lastError: unknown;
  for (const secure of [true, false]) {
    const transport = nodemailer.createTransport({
      host: BRIDGE.host,
      port: BRIDGE.smtpPort,
      secure,
      requireTLS: !secure,
      auth: { user: login.user, pass: login.pass },
      tls: BRIDGE.tls,
      greetingTimeout: 5000,
    });
    try {
      await transport.verify();
      return transport;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

export async function sendViaBridge(
  login: BridgeLogin,
  message: BridgeMessage,
  opts: { draft?: boolean; discardDrafts?: boolean },
): Promise<{ state: "DRAFT" | "SENT"; leftoverDrafts: number }> {
  if (opts.draft) {
    const composer = new MailComposer(mailOptions(message)).compile();
    composer.keepBcc = true;
    const raw: Buffer = await composer.build();
    await withImap(login, (client) => client.append("Drafts", raw, ["\\Draft", "\\Seen"]));
    return { state: "DRAFT", leftoverDrafts: 0 };
  }

  const transport = await smtpTransport(login);
  // Resolves only once Bridge has accepted the message for delivery.
  await transport.sendMail(mailOptions(message));
  // The mail is out; a failure while tidying drafts must not look like a failed send.
  const leftoverDrafts = await matchingDrafts(
    login, message.subject, !!opts.discardDrafts,
  ).catch(() => 0);
  return { state: "SENT", leftoverDrafts };
}
