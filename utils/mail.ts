import { runAppleScript } from "run-applescript";

const CONFIG = {
  MAX_EMAILS: 20,
  MAX_CONTENT_PREVIEW: 300,
};

const MSG_SEP = "<<<M>>>";
const FIELD_SEP = "<<<F>>>";

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

function parseMailOutput(output: string): EmailMessage[] {
  const emails: EmailMessage[] = [];
  if (!output || output.trim() === "") return emails;

  const rawMsgs = output.split(MSG_SEP).filter(s => s.trim() !== "");
  for (const raw of rawMsgs) {
    const parts = raw.split(FIELD_SEP);
    emails.push({
      subject: (parts[0] || "").trim() || "No subject",
      sender: (parts[1] || "").trim() || "Unknown sender",
      dateSent: (parts[2] || "").trim(),
      isRead: (parts[3] || "").trim() !== "false",
      mailbox: (parts[4] || "").trim() || "Unknown",
      content: (parts[5] || "").trim() || "",
    });
  }
  return emails;
}

/**
 * Build AppleScript to extract emails from a set of messages.
 * Iterates messages, optionally filtering by read status or search term.
 */
function buildMailScript(opts: {
  source: string;
  limit: number;
  unreadOnly?: boolean;
  searchTerm?: string;
  mailboxName?: string;
  includeContent?: boolean;
}): string {
  const contentLen = CONFIG.MAX_CONTENT_PREVIEW;
  const mbName = opts.mailboxName ? `"${opts.mailboxName}"` : "mbName";

  // Build condition — combine read filter and search filter
  const conditions: string[] = [];
  if (opts.unreadOnly) conditions.push("read status of m is false");
  if (opts.searchTerm) conditions.push(`(subj contains "${opts.searchTerm}" or sndr contains "${opts.searchTerm}")`);

  const contentBlock = opts.includeContent !== false ? `
            set cont to ""
            try
                set cont to content of m
                if (length of cont) > ${contentLen} then
                    set cont to (text 1 thru ${contentLen} of cont) & "..."
                end if
            on error
                set cont to ""
            end try` : "";

  // If we need to check subject/sender for search, we must read them before the condition
  const needsPreRead = opts.searchTerm != null;

  return `
tell application "Mail"
    set output to ""
    set count_ to 0
    set lim to ${opts.limit}
    set msgs to ${opts.source}
    repeat with i from 1 to (count of msgs)
        if count_ >= lim then exit repeat
        set m to item i of msgs
        set subj to subject of m
        set sndr to sender of m
        ${conditions.length > 0 ? `if ${conditions.join(" and ")} then` : ""}
            set count_ to count_ + 1
            set dt to ((date sent of m) as string)
            set isRead to (read status of m) as string${contentBlock}
            set output to output & "${MSG_SEP}" & subj & "${FIELD_SEP}" & sndr & "${FIELD_SEP}" & dt & "${FIELD_SEP}" & isRead & "${FIELD_SEP}" & ${mbName} & "${FIELD_SEP}" & cont
        ${conditions.length > 0 ? "end if" : ""}
    end repeat
    return output
end tell`;
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
 * Get unread emails from inbox
 */
async function getUnreadMails(limit = 10): Promise<EmailMessage[]> {
  try {
    const accessResult = await requestMailAccess();
    if (!accessResult.hasAccess) throw new Error(accessResult.message);

    const maxEmails = Math.min(limit, CONFIG.MAX_EMAILS);
    const script = buildMailScript({
      source: "messages of inbox",
      limit: maxEmails,
      unreadOnly: true,
      mailboxName: "Inbox",
    });

    const result = (await runAppleScript(script)) as string;
    return parseMailOutput(result);
  } catch (error) {
    console.error(
      `Error getting unread emails: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Search for emails by search term (searches subject and sender)
 */
async function searchMails(searchTerm: string, limit = 10): Promise<EmailMessage[]> {
  try {
    const accessResult = await requestMailAccess();
    if (!accessResult.hasAccess) throw new Error(accessResult.message);

    if (!searchTerm || searchTerm.trim() === "") return [];

    const maxEmails = Math.min(limit, CONFIG.MAX_EMAILS);
    const cleanTerm = searchTerm.replace(/"/g, '\\"');
    const contentLen = CONFIG.MAX_CONTENT_PREVIEW;

    // Use whose clause for fast search — inbox first, then all enabled mailboxes
    const script = `
tell application "Mail"
    set output to ""
    set count_ to 0
    set lim to ${maxEmails}

    -- Search inbox first (fast)
    set matched to (messages of inbox whose subject contains "${cleanTerm}" or sender contains "${cleanTerm}")
    repeat with i from 1 to (count of matched)
        if count_ >= lim then exit repeat
        set m to item i of matched
        set count_ to count_ + 1
        set subj to subject of m
        set sndr to sender of m
        set dt to ((date sent of m) as string)
        set isRead to (read status of m) as string
        set cont to ""
        try
            set cont to content of m
            if (length of cont) > ${contentLen} then
                set cont to (text 1 thru ${contentLen} of cont) & "..."
            end if
        on error
            set cont to ""
        end try
        set output to output & "${MSG_SEP}" & subj & "${FIELD_SEP}" & sndr & "${FIELD_SEP}" & dt & "${FIELD_SEP}" & isRead & "${FIELD_SEP}" & "Inbox" & "${FIELD_SEP}" & cont
    end repeat

    -- If not enough results, search other mailboxes on enabled accounts
    if count_ < lim then
        repeat with acct in accounts
            if enabled of acct then
                repeat with mb in mailboxes of acct
                    set mbN to name of mb
                    if mbN is not "INBOX" and mbN is not "Inbox" and mbN is not "All Mail" and mbN is not "Alle e-mail" then
                        try
                            set matched to (messages of mb whose subject contains "${cleanTerm}" or sender contains "${cleanTerm}")
                            set mbName to name of mb
                            repeat with i from 1 to (count of matched)
                                if count_ >= lim then exit repeat
                                set m to item i of matched
                                set count_ to count_ + 1
                                set subj to subject of m
                                set sndr to sender of m
                                set dt to ((date sent of m) as string)
                                set isRead to (read status of m) as string
                                set cont to ""
                                try
                                    set cont to content of m
                                    if (length of cont) > ${contentLen} then
                                        set cont to (text 1 thru ${contentLen} of cont) & "..."
                                    end if
                                on error
                                    set cont to ""
                                end try
                                set output to output & "${MSG_SEP}" & subj & "${FIELD_SEP}" & sndr & "${FIELD_SEP}" & dt & "${FIELD_SEP}" & isRead & "${FIELD_SEP}" & mbName & "${FIELD_SEP}" & cont
                            end repeat
                        end try
                    end if
                    if count_ >= lim then exit repeat
                end repeat
            end if
            if count_ >= lim then exit repeat
        end repeat
    end if

    return output
end tell`;

    const result = (await runAppleScript(script)) as string;
    return parseMailOutput(result);
  } catch (error) {
    console.error(
      `Error searching emails: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Get latest emails (regardless of read status)
 */
async function getLatestMails(account?: string, limit = 5): Promise<EmailMessage[]> {
  try {
    const accessResult = await requestMailAccess();
    if (!accessResult.hasAccess) throw new Error(accessResult.message);

    const maxEmails = Math.min(limit, CONFIG.MAX_EMAILS);

    // If account specified, get from that account's inbox; otherwise use global inbox
    const source = account
      ? `messages of mailbox "INBOX" of account "${account.replace(/"/g, '\\"')}"`
      : "messages of inbox";
    const mbName = account || "Inbox";

    const script = buildMailScript({
      source,
      limit: maxEmails,
      mailboxName: mbName,
    });

    const result = (await runAppleScript(script)) as string;
    return parseMailOutput(result);
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

    const os = require("os");
    const tmpFile = `${os.tmpdir()}/email-body-${Date.now()}.txt`;
    const fs = require("fs");
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
 * Read the full content of a specific email by subject (and optionally sender/date)
 */
async function readMail(subject: string, sender?: string, mailbox?: string): Promise<EmailMessage | null> {
  try {
    const accessResult = await requestMailAccess();
    if (!accessResult.hasAccess) throw new Error(accessResult.message);

    if (!subject || !subject.trim()) throw new Error("Subject is required to identify the email");

    const cleanSubject = subject.replace(/"/g, '\\"');

    const os = require("os");
    const fs = require("fs");
    const tmpBase = os.tmpdir();
    const timestamp = Date.now();
    const tmpDir = `${tmpBase}/mail-attachments-${timestamp}`;
    const srcFile = `${tmpBase}/mail-source-${timestamp}.txt`;

    const senderWhose = sender
      ? ` and sender contains "${sender.replace(/"/g, '\\"')}"`
      : '';

    // Step 1: Get metadata + message ID (small return, no -10000 risk)
    const cleanMailbox = mailbox ? mailbox.replace(/"/g, '\\"') : '';

    let searchSource: string;
    if (cleanMailbox) {
      // Specific mailbox requested — search it across accounts
      searchSource = `set matched to {}
    repeat with acct in accounts
        if enabled of acct then
            try
                set mb to mailbox "${cleanMailbox}" of acct
                set matched to (messages of mb whose subject contains "${cleanSubject}"${senderWhose})
                if (count of matched) > 0 then exit repeat
            end try
        end if
    end repeat`;
    } else {
      // No mailbox specified — try inbox first, then fall back to all mailboxes
      searchSource = `set matched to (messages of inbox whose subject contains "${cleanSubject}"${senderWhose})
    if (count of matched) = 0 then
        repeat with acct in accounts
            if enabled of acct then
                repeat with mb in mailboxes of acct
                    set mbN to name of mb
                    if mbN is not "All Mail" and mbN is not "Alle e-mail" then
                        try
                            set matched to (messages of mb whose subject contains "${cleanSubject}"${senderWhose})
                            if (count of matched) > 0 then exit repeat
                        end try
                    end if
                end repeat
                if (count of matched) > 0 then exit repeat
            end if
        end repeat
    end if`;
    }

    const metaScript = `
tell application "Mail"
    ${searchSource}
    if (count of matched) = 0 then return ""
    set m to item 1 of matched
    set subj to subject of m
    set sndr to sender of m
    set dt to ((date sent of m) as string)
    set isRead to (read status of m) as string
    set msgId to id of m
    set mbName to ""
    set acctName to ""
    try
        set mb to mailbox of m
        set mbName to name of mb
        set acctName to name of account of mb
    end try
    return subj & "${FIELD_SEP}" & sndr & "${FIELD_SEP}" & dt & "${FIELD_SEP}" & isRead & "${FIELD_SEP}" & mbName & "${FIELD_SEP}" & msgId & "${FIELD_SEP}" & acctName
end tell`;

    const result = (await runAppleScript(metaScript)) as string;
    if (!result || result.trim() === "") return null;

    const parts = result.split(FIELD_SEP);
    const msgId = (parts[5] || "").trim();
    const acctName = (parts[6] || "").trim();
    const mbName = (parts[4] || "").trim();

    // Step 2: Get source + attachments via direct osascript (avoids AppleEvent size limit)
    const { execFile } = require("child_process");
    const { promisify } = require("util");
    const execFileAsync = promisify(execFile);

    const cleanAcct = acctName.replace(/"/g, '\\"');
    const cleanMb = mbName.replace(/"/g, '\\"');
    const attFile = `${tmpBase}/mail-att-info-${timestamp}.txt`;
    const srcScript = `
tell application "Mail"
    set msgs to (messages of mailbox "${cleanMb}" of account "${cleanAcct}" whose id is ${msgId})
    set m to item 1 of msgs
    set src to source of m
    do shell script "/usr/bin/printf '%s' " & quoted form of src & " > " & quoted form of "${srcFile}"

    set attCount to count of mail attachments of m
    if attCount > 0 then
        do shell script "mkdir -p " & quoted form of "${tmpDir}"
        -- Collect names first, then save (accessing properties after save can fail)
        set attNames to {}
        repeat with att in mail attachments of m
            set end of attNames to name of att
        end repeat
        repeat with i from 1 to attCount
            set attName to item i of attNames
            set savePath to "${tmpDir}/" & attName
            try
                save (mail attachment i of m) in POSIX file savePath
            end try
        end repeat
        -- Write info via shell (MIME type property causes -10000, derive from extension)
        repeat with attName in attNames
            do shell script "echo " & quoted form of (attName as text) & " >> " & quoted form of "${attFile}"
        end repeat
    end if
end tell`;

    try {
      await execFileAsync("osascript", ["-e", srcScript], { timeout: 30000, maxBuffer: 1024 * 1024 * 5 });
    } catch {}

    // Read source from temp file
    let rawSource = "";
    try {
      rawSource = fs.readFileSync(srcFile, "utf-8");
      fs.unlinkSync(srcFile);
    } catch {}

    const content = extractHtmlFromMime(rawSource.trim());

    // Parse attachment info from temp file
    const mimeTypes: Record<string, string> = {
      pdf: "application/pdf", jpg: "image/jpeg", jpeg: "image/jpeg",
      png: "image/png", gif: "image/gif", doc: "application/msword",
      docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      xls: "application/vnd.ms-excel", xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      zip: "application/zip", txt: "text/plain", csv: "text/csv", html: "text/html",
    };
    const attachments: EmailAttachment[] = [];
    try {
      const attData = fs.readFileSync(attFile, "utf-8").trim();
      fs.unlinkSync(attFile);
      if (attData) {
        for (const attName of attData.split("\n").filter(Boolean)) {
          const ext = attName.split(".").pop()?.toLowerCase() || "";
          attachments.push({
            name: attName.trim(),
            mimeType: mimeTypes[ext] || "application/octet-stream",
            path: `${tmpDir}/${attName.trim()}`,
          });
        }
      }
    } catch {}

    return {
      subject: (parts[0] || "").trim() || "No subject",
      sender: (parts[1] || "").trim() || "Unknown sender",
      dateSent: (parts[2] || "").trim(),
      isRead: (parts[3] || "").trim() !== "false",
      mailbox: (parts[4] || "").trim() || "Inbox",
      content,
      attachments: attachments.length > 0 ? attachments : undefined,
    };
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    console.error(`Error reading email: ${msg}`);
    throw new Error(`Failed to open email: ${msg}`);
  }
}

export default {
  getUnreadMails,
  searchMails,
  sendMail,
  getMailboxes,
  getAccounts,
  getMailboxesForAccount,
  getLatestMails,
  readMail,
  requestMailAccess,
};
