import { runAppleScript } from "run-applescript";
import { Database } from "bun:sqlite";
import { execFile } from "child_process";
import { promisify } from "util";
import os from "os";
import fs from "fs";

const execFileAsync = promisify(execFile);

const CONFIG = {
  MAX_EMAILS: 20,
  MAX_CONTENT_PREVIEW: 300,
  ENVELOPE_DB: `${os.homedir()}/Library/Mail/V10/MailData/Envelope Index`,
};

/**
 * Run a read-only SQL query against the Mail Envelope Index.
 * Uses bun:sqlite in-process — requires bun to have Full Disk Access.
 */
function queryEnvelopeDb<T>(sql: string): T[] {
  const db = new Database(CONFIG.ENVELOPE_DB, { readonly: true });
  try {
    return db.query(sql).all() as T[];
  } finally {
    db.close();
  }
}


interface EmailAttachment {
  name: string;
  mimeType: string;
  path: string;
}

interface EmailMessage {
  subject: string;
  sender: string;
  dateSent: string;
  content: string;
  isRead: boolean;
  mailbox: string;
  attachments?: EmailAttachment[];
}

async function checkMailAccess(): Promise<boolean> {
  try {
    await runAppleScript(`
tell application "Mail"
    return count of messages of inbox
end tell`);
    return true;
  } catch (error) {
    console.error(
      `Cannot access Mail app: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function requestMailAccess(): Promise<{ hasAccess: boolean; message: string }> {
  try {
    const hasAccess = await checkMailAccess();
    if (hasAccess) {
      return { hasAccess: true, message: "Mail access is already granted." };
    }
    return {
      hasAccess: false,
      message:
        "Mail access is required but not granted. Please:\n" +
        "1. Open System Settings > Privacy & Security > Automation\n" +
        "2. Enable 'Mail' for your terminal app\n" +
        "3. Make sure Mail app is running\n" +
        "4. Restart your terminal and try again",
    };
  } catch (error) {
    return {
      hasAccess: false,
      message: `Error checking Mail access: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Get unread emails via Envelope Index SQLite database.
 */
async function getUnreadMails(limit = 10): Promise<EmailMessage[]> {
  try {
    const maxEmails = Math.min(limit, CONFIG.MAX_EMAILS);
    const contentLen = CONFIG.MAX_CONTENT_PREVIEW;

    const sql = `
SELECT s.subject, COALESCE(a.comment, '') || ' <' || a.address || '>' as sender,
       datetime(m.date_sent, 'unixepoch', '+31 years') as dt,
       m.read,
       REPLACE(REPLACE(SUBSTR(mb.url, INSTR(mb.url, '://') + LENGTH('://') + 37), '%20', ' '), '%2F', '/') as mailbox_name,
       SUBSTR(COALESCE(sum2.summary, ''), 1, ${contentLen}) as preview
FROM messages m
JOIN subjects s ON m.subject = s.ROWID
JOIN addresses a ON m.sender = a.ROWID
JOIN mailboxes mb ON m.mailbox = mb.ROWID
LEFT JOIN summaries sum2 ON m.summary = sum2.ROWID
WHERE m.read = 0
  AND mb.url NOT LIKE 'ews://%'
  AND mb.url NOT LIKE '%/All%20Mail'
  AND mb.url NOT LIKE '%/Alle%20e-mail'
  AND mb.url NOT LIKE '%/Spam'
  AND mb.url NOT LIKE '%/Trash'
ORDER BY m.date_sent DESC
LIMIT ${maxEmails};`;

    const rows = queryEnvelopeDb<{
      subject: string; sender: string; dt: string;
      read: number; mailbox_name: string; preview: string;
    }>(sql);

    return rows.map(row => ({
      subject: row.subject || "No subject",
      sender: row.sender || "Unknown sender",
      dateSent: row.dt || "",
      isRead: false,
      mailbox: row.mailbox_name || "Unknown",
      content: row.preview || "",
    }));
  } catch (error) {
    console.error(
      `Error getting unread emails: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

interface SearchMailsOpts {
  searchTerm?: string;
  searchSender?: string;
  searchSubject?: string;
  searchContent?: string;
  limit?: number;
}

/**
 * Search for emails via Mail.app's Envelope Index SQLite database.
 * ~100x faster than AppleScript `whose` clauses.
 * - searchTerm: searches subject, sender, AND content (broad OR)
 * - searchSender: searches sender only
 * - searchSubject: searches subject only
 * - searchContent: searches body content only
 * Multiple specific fields are combined with AND.
 */
async function searchMails(opts: SearchMailsOpts): Promise<EmailMessage[]> {
  try {
    const { searchTerm, searchSender, searchSubject, searchContent } = opts;
    const limit = opts.limit || 10;
    const maxEmails = Math.min(limit, CONFIG.MAX_EMAILS);
    const contentLen = CONFIG.MAX_CONTENT_PREVIEW;

    // Build WHERE conditions (SQL LIKE with % wildcards)
    const conditions: string[] = [];

    if (searchTerm) {
      const clean = searchTerm.replace(/'/g, "''");
      conditions.push(`(s.subject LIKE '%${clean}%' OR a.comment LIKE '%${clean}%' OR a.address LIKE '%${clean}%' OR sum2.summary LIKE '%${clean}%')`);
    }
    if (searchSender) {
      const clean = searchSender.replace(/'/g, "''");
      conditions.push(`(a.comment LIKE '%${clean}%' OR a.address LIKE '%${clean}%')`);
    }
    if (searchSubject) {
      const clean = searchSubject.replace(/'/g, "''");
      conditions.push(`s.subject LIKE '%${clean}%'`);
    }
    if (searchContent) {
      const clean = searchContent.replace(/'/g, "''");
      conditions.push(`sum2.summary LIKE '%${clean}%'`);
    }

    if (conditions.length === 0) return [];

    const whereClause = conditions.join(" AND ");

    const sql = `
SELECT s.subject, COALESCE(a.comment, '') || ' <' || a.address || '>' as sender,
       datetime(m.date_sent, 'unixepoch', '+31 years') as dt,
       m.read,
       REPLACE(REPLACE(SUBSTR(mb.url, INSTR(mb.url, '://') + LENGTH('://') + 37), '%20', ' '), '%2F', '/') as mailbox_name,
       SUBSTR(COALESCE(sum2.summary, ''), 1, ${contentLen}) as preview
FROM messages m
JOIN subjects s ON m.subject = s.ROWID
JOIN addresses a ON m.sender = a.ROWID
JOIN mailboxes mb ON m.mailbox = mb.ROWID
LEFT JOIN summaries sum2 ON m.summary = sum2.ROWID
WHERE ${whereClause}
  AND mb.url NOT LIKE 'ews://%'
  AND mb.url NOT LIKE '%/All%20Mail'
  AND mb.url NOT LIKE '%/Alle%20e-mail'
ORDER BY m.date_sent DESC
LIMIT ${maxEmails};`;

    const rows = queryEnvelopeDb<{
      subject: string; sender: string; dt: string;
      read: number; mailbox_name: string; preview: string;
    }>(sql);

    return rows.map(row => ({
      subject: row.subject || "No subject",
      sender: row.sender || "Unknown sender",
      dateSent: row.dt || "",
      isRead: row.read !== 0,
      mailbox: row.mailbox_name || "Unknown",
      content: row.preview || "",
    }));
  } catch (error) {
    console.error(
      `Error searching emails: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Get latest emails (regardless of read status) via Envelope Index SQLite database.
 */
async function getLatestMails(account?: string, limit = 5): Promise<EmailMessage[]> {
  try {
    const maxEmails = Math.min(limit, CONFIG.MAX_EMAILS);
    const contentLen = CONFIG.MAX_CONTENT_PREVIEW;

    const sql = `
SELECT s.subject, COALESCE(a.comment, '') || ' <' || a.address || '>' as sender,
       datetime(m.date_sent, 'unixepoch', '+31 years') as dt,
       m.read,
       REPLACE(REPLACE(SUBSTR(mb.url, INSTR(mb.url, '://') + LENGTH('://') + 37), '%20', ' '), '%2F', '/') as mailbox_name,
       SUBSTR(COALESCE(sum2.summary, ''), 1, ${contentLen}) as preview
FROM messages m
JOIN subjects s ON m.subject = s.ROWID
JOIN addresses a ON m.sender = a.ROWID
JOIN mailboxes mb ON m.mailbox = mb.ROWID
LEFT JOIN summaries sum2 ON m.summary = sum2.ROWID
WHERE mb.url NOT LIKE 'ews://%'
  AND mb.url NOT LIKE '%/All%20Mail'
  AND mb.url NOT LIKE '%/Alle%20e-mail'
  AND mb.url NOT LIKE '%/Spam'
  AND mb.url NOT LIKE '%/Trash'
  AND mb.url NOT LIKE '%/Drafts'
ORDER BY m.date_sent DESC
LIMIT ${maxEmails};`;

    const rows = queryEnvelopeDb<{
      subject: string; sender: string; dt: string;
      read: number; mailbox_name: string; preview: string;
    }>(sql);

    return rows.map(row => ({
      subject: row.subject || "No subject",
      sender: row.sender || "Unknown sender",
      dateSent: row.dt || "",
      isRead: row.read !== 0,
      mailbox: row.mailbox_name || "Unknown",
      content: row.preview || "",
    }));
  } catch (error) {
    console.error(
      `Error getting latest emails: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Send an email
 */
async function sendMail(
  to: string,
  subject: string,
  body: string,
  cc?: string,
  bcc?: string,
): Promise<string | undefined> {
  try {
    const accessResult = await requestMailAccess();
    if (!accessResult.hasAccess) throw new Error(accessResult.message);

    if (!to || !to.trim()) throw new Error("To address is required");
    if (!subject || !subject.trim()) throw new Error("Subject is required");
    if (!body || !body.trim()) throw new Error("Email body is required");

    const tmpFile = `${os.tmpdir()}/email-body-${Date.now()}.txt`;
    fs.writeFileSync(tmpFile, body.trim(), "utf8");

    const script = `
tell application "Mail"
    activate
    set emailBody to read file POSIX file "${tmpFile}" as «class utf8»
    set newMessage to make new outgoing message with properties {subject:"${subject.replace(/"/g, '\\"')}", content:emailBody, visible:true}
    tell newMessage
        make new to recipient with properties {address:"${to.replace(/"/g, '\\"')}"}
        ${cc ? `make new cc recipient with properties {address:"${cc.replace(/"/g, '\\"')}"}` : ""}
        ${bcc ? `make new bcc recipient with properties {address:"${bcc.replace(/"/g, '\\"')}"}` : ""}
    end tell
    send newMessage
    return "SUCCESS"
end tell`;

    const result = (await runAppleScript(script)) as string;

    try { fs.unlinkSync(tmpFile); } catch {}

    if (result === "SUCCESS") {
      return `Email sent to ${to} with subject "${subject}"`;
    }
    throw new Error("Failed to send email");
  } catch (error) {
    throw new Error(
      `Error sending email: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/**
 * Get list of mailboxes
 */
async function getMailboxes(): Promise<string[]> {
  try {
    const accessResult = await requestMailAccess();
    if (!accessResult.hasAccess) throw new Error(accessResult.message);

    const script = `
tell application "Mail"
    set output to ""
    repeat with mb in mailboxes
        set output to output & name of mb & "<<<SEP>>>"
    end repeat
    return output
end tell`;

    const result = (await runAppleScript(script)) as string;
    if (!result) return [];
    return result.split("<<<SEP>>>").map(s => s.trim()).filter(Boolean);
  } catch (error) {
    console.error(
      `Error getting mailboxes: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Get list of email accounts
 */
async function getAccounts(): Promise<string[]> {
  try {
    const accessResult = await requestMailAccess();
    if (!accessResult.hasAccess) throw new Error(accessResult.message);

    const script = `
tell application "Mail"
    set output to ""
    repeat with acct in accounts
        set output to output & full name of acct & "<<<SEP>>>"
    end repeat
    return output
end tell`;

    const result = (await runAppleScript(script)) as string;
    if (!result) return [];
    return result.split("<<<SEP>>>").map(s => s.trim()).filter(Boolean);
  } catch (error) {
    console.error(
      `Error getting accounts: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Get mailboxes for a specific account
 */
async function getMailboxesForAccount(accountName: string): Promise<string[]> {
  try {
    const accessResult = await requestMailAccess();
    if (!accessResult.hasAccess) throw new Error(accessResult.message);
    if (!accountName || !accountName.trim()) return [];

    const script = `
tell application "Mail"
    set output to ""
    try
        set targetAccount to first account whose full name is "${accountName.replace(/"/g, '\\"')}"
        repeat with mb in mailboxes of targetAccount
            set output to output & name of mb & "<<<SEP>>>"
        end repeat
    end try
    return output
end tell`;

    const result = (await runAppleScript(script)) as string;
    if (!result) return [];
    return result.split("<<<SEP>>>").map(s => s.trim()).filter(Boolean);
  } catch (error) {
    console.error(
      `Error getting mailboxes for account: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Extract HTML (or plain text fallback) from a raw MIME email source.
 * Splits by MIME boundaries and finds the text/html part.
 */
function decodeQP(text: string): string {
  return text
    .replace(/=\r?\n/g, "")
    .replace(/=([0-9A-Fa-f]{2})/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function extractHtmlFromMime(source: string): string {
  const lines = source.split(/\r?\n/);

  // Check if this is multipart
  const boundaryMatch = source.match(/boundary="?([^\s"]+)"?/);

  if (!boundaryMatch) {
    // Single-part email — extract body after headers, decode if needed
    const isHtml = /Content-Type:\s*text\/html/i.test(source);
    const isQP = /Content-Transfer-Encoding:\s*quoted-printable/i.test(source);
    const isBase64 = /Content-Transfer-Encoding:\s*base64/i.test(source);

    // Find the blank line separating headers from body
    let bodyStart = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].trim() === "" && i > 5) {
        // Check if previous lines look like headers
        const prevLine = lines[i - 1] || "";
        if (/^[A-Za-z-]+:/.test(prevLine) || /^\s/.test(prevLine)) {
          bodyStart = i + 1;
          break;
        }
      }
    }

    if (bodyStart > 0) {
      let body = lines.slice(bodyStart).join("\n");
      if (isQP) body = decodeQP(body);
      else if (isBase64) {
        try { body = Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf-8"); } catch {}
      }
      if (isHtml || body.includes("<!doctype") || body.includes("<html")) return body;
    }

    return source;
  }

  // Multipart — walk through lines, find text/html section
  let inHtmlPart = false;
  let pastHeaders = false;
  let htmlLines: string[] = [];
  let encoding = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    // MIME boundary starts a new part
    if (line.startsWith("--") && line.length > 10 && !line.startsWith("-->")) {
      if (inHtmlPart && htmlLines.length > 0) break; // done collecting HTML
      inHtmlPart = false;
      pastHeaders = false;
      encoding = "";
      continue;
    }

    if (!pastHeaders) {
      if (line.trim() === "") {
        pastHeaders = true;
        continue;
      }
      if (/Content-Type:\s*text\/html/i.test(line)) {
        inHtmlPart = true;
      }
      if (/Content-Transfer-Encoding:\s*quoted-printable/i.test(line)) {
        encoding = "qp";
      }
      if (/Content-Transfer-Encoding:\s*base64/i.test(line)) {
        encoding = "base64";
      }
      continue;
    }

    if (inHtmlPart) {
      htmlLines.push(line);
    }
  }

  if (htmlLines.length === 0) return source;

  let html = htmlLines.join("\n");
  if (encoding === "qp") {
    html = decodeQP(html);
  } else if (encoding === "base64") {
    try { html = Buffer.from(html.replace(/\s/g, ""), "base64").toString("utf-8"); } catch {}
  }

  return html;
}

/**
 * Read the full content of a specific email by subject (and optionally sender/date).
 * Reads the .emlx file directly from disk — no AppleScript needed.
 */
async function readMail(subject: string, sender?: string, mailbox?: string): Promise<EmailMessage | null> {
  try {
    if (!subject || !subject.trim()) throw new Error("Subject is required to identify the email");

    // Step 1: Find message via SQLite Envelope Index (instant)
    const cleanSubject = subject.replace(/'/g, "''");
    const conditions: string[] = [`s.subject LIKE '%${cleanSubject}%'`];
    if (sender) {
      const cleanSender = sender.replace(/'/g, "''");
      conditions.push(`(a.comment LIKE '%${cleanSender}%' OR a.address LIKE '%${cleanSender}%')`);
    }
    if (mailbox) {
      const cleanMailbox = mailbox.replace(/'/g, "''");
      conditions.push(`mb.url LIKE '%${cleanMailbox.replace(/ /g, "%20")}%'`);
    }

    const sql = `
SELECT m.ROWID as msg_id, s.subject, COALESCE(a.comment, '') || ' <' || a.address || '>' as sender,
       datetime(m.date_sent, 'unixepoch', '+31 years') as dt,
       m.read,
       mb.url as mailbox_url,
       REPLACE(REPLACE(SUBSTR(mb.url, INSTR(mb.url, '://') + LENGTH('://') + 37), '%20', ' '), '%2F', '/') as mailbox_name
FROM messages m
JOIN subjects s ON m.subject = s.ROWID
JOIN addresses a ON m.sender = a.ROWID
JOIN mailboxes mb ON m.mailbox = mb.ROWID
WHERE ${conditions.join(" AND ")}
  AND mb.url NOT LIKE 'ews://%'
  AND mb.url NOT LIKE '%/All%20Mail'
  AND mb.url NOT LIKE '%/Alle%20e-mail'
ORDER BY m.date_sent DESC
LIMIT 1;`;

    const rows = queryEnvelopeDb<{
      msg_id: number; subject: string; sender: string;
      dt: string; read: number; mailbox_url: string; mailbox_name: string;
    }>(sql);

    if (rows.length === 0) return null;

    const meta = rows[0];
    const msgId = meta.msg_id;

    // Step 2: Find .emlx file on disk (fast — scoped to account directory)
    const urlPath = meta.mailbox_url.substring(meta.mailbox_url.indexOf('://') + 3);
    const accountUuid = urlPath.substring(0, urlPath.indexOf('/'));
    const accountDir = `${os.homedir()}/Library/Mail/V10/${accountUuid}`;

    let emlxPath = '';
    try {
      const { stdout } = await execFileAsync('find', [
        accountDir, '-type', 'f', '(',
        '-name', `${msgId}.partial.emlx`,
        '-o', '-name', `${msgId}.emlx`,
        ')',
      ], { timeout: 5000 });
      emlxPath = stdout.trim().split('\n')[0] || '';
    } catch {}

    let content = '';
    const attachments: EmailAttachment[] = [];

    const mimeTypes: Record<string, string> = {
      pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg",
      png: "image/png", gif: "image/gif", doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      zip: "application/zip", txt: "text/plain", csv: "text/csv", html: "text/html",
    };

    if (emlxPath) {
      // .emlx format: first line is byte count, then MIME source, then Apple plist
      const rawBuffer = fs.readFileSync(emlxPath);
      const firstNewline = rawBuffer.indexOf(0x0A);
      const byteCount = parseInt(
        rawBuffer.subarray(0, firstNewline).toString('utf-8'), 10,
      );
      const mimeSource = rawBuffer
        .subarray(firstNewline + 1, firstNewline + 1 + byteCount)
        .toString('utf-8');
      content = extractHtmlFromMime(mimeSource.trim());

      // Find attachments in sibling Attachments directory
      const messagesDir = emlxPath.substring(0, emlxPath.lastIndexOf('/'));
      const dataLevelDir = messagesDir.substring(0, messagesDir.lastIndexOf('/'));
      const attDir = `${dataLevelDir}/Attachments/${msgId}`;

      if (fs.existsSync(attDir)) {
        try {
          const { stdout: attFiles } = await execFileAsync(
            'find', [attDir, '-type', 'f'], { timeout: 3000 },
          );
          for (const filePath of attFiles.trim().split('\n').filter(Boolean)) {
            const fileName = filePath.substring(filePath.lastIndexOf('/') + 1);
            const ext = fileName.split('.').pop()?.toLowerCase() || '';
            attachments.push({
              name: fileName,
              mimeType: mimeTypes[ext] || "application/octet-stream",
              path: filePath,
            });
          }
        } catch {}
      }
    } else {
      content = "[Email not downloaded locally]";
    }

    return {
      subject: meta.subject || "No subject",
      sender: meta.sender || "Unknown sender",
      dateSent: meta.dt || "",
      isRead: meta.read !== 0,
      mailbox: meta.mailbox_name || "Unknown",
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error reading email: ${msg}`);
    throw new Error(`Failed to open email: ${msg}`);
  }
}

/**
 * Get unread emails for a specific account (and optionally mailbox) via AppleScript.
 * Falls back to the general getUnreadMails if the account-specific query fails.
 */
async function getUnreadMailsForAccount(
  account: string,
  mailbox?: string,
  limit = 10,
): Promise<EmailMessage[]> {
  const script = `
tell application "Mail"
    set resultList to {}
    try
        set targetAccount to first account whose name is "${account.replace(/"/g, '\\"')}"

        set acctMailboxes to every mailbox of targetAccount

        set mailboxesToSearch to acctMailboxes
        ${
          mailbox
            ? `
        set mailboxesToSearch to {}
        repeat with mb in acctMailboxes
            if name of mb is "${mailbox.replace(/"/g, '\\"')}" then
                set mailboxesToSearch to {mb}
                exit repeat
            end if
        end repeat
        `
            : ""
        }

        repeat with mb in mailboxesToSearch
            try
                set unreadMessages to (messages of mb whose read status is false)
                if (count of unreadMessages) > 0 then
                    set msgLimit to ${limit}
                    if (count of unreadMessages) < msgLimit then
                        set msgLimit to (count of unreadMessages)
                    end if

                    repeat with i from 1 to msgLimit
                        try
                            set currentMsg to item i of unreadMessages
                            set msgData to {subject:(subject of currentMsg), sender:(sender of currentMsg), \u00ac
                                        date:(date sent of currentMsg) as string, mailbox:(name of mb)}

                            try
                                set msgContent to content of currentMsg
                                if length of msgContent > 500 then
                                    set msgContent to (text 1 thru 500 of msgContent) & "..."
                                end if
                                set msgData to msgData & {content:msgContent}
                            on error
                                set msgData to msgData & {content:"[Content not available]"}
                            end try

                            set end of resultList to msgData
                        on error
                            -- Skip problematic messages
                        end try
                    end repeat

                    if (count of resultList) \u2265 ${limit} then exit repeat
                end if
            on error
                -- Skip problematic mailboxes
            end try
        end repeat
    on error errMsg
        return "Error: " & errMsg
    end try

    return resultList
end tell`;

  try {
    const asResult = await runAppleScript(script);
    if (asResult && asResult.startsWith("Error:")) {
      throw new Error(asResult);
    }

    const emailData: EmailMessage[] = [];
    const matches = asResult.match(/\{([^}]+)\}/g);
    if (matches && matches.length > 0) {
      for (const match of matches) {
        try {
          const props = match.substring(1, match.length - 1).split(",");
          const email: any = {};
          props.forEach((prop) => {
            const parts = prop.split(":");
            if (parts.length >= 2) {
              const key = parts[0].trim();
              const value = parts.slice(1).join(":").trim();
              email[key] = value;
            }
          });
          if (email.subject || email.sender) {
            emailData.push({
              subject: email.subject || "No subject",
              sender: email.sender || "Unknown sender",
              dateSent: email.date || new Date().toString(),
              content: email.content || "[Content not available]",
              isRead: false,
              mailbox: `${account} - ${email.mailbox || "Unknown"}`,
            });
          }
        } catch (parseError) {
          console.error("Error parsing email match:", parseError);
        }
      }
    }

    return emailData;
  } catch (error) {
    console.error("Error getting account-specific emails:", error);
    // Fallback to general method
    return getUnreadMails(limit);
  }
}

export default {
  getUnreadMails,
  getUnreadMailsForAccount,
  searchMails,
  sendMail,
  getMailboxes,
  getAccounts,
  getMailboxesForAccount,
  getLatestMails,
  readMail,
  requestMailAccess,
};
