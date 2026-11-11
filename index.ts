#!/usr/bin/env node

import { readFileSync, writeFileSync } from "fs";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";
import tools from "./tools";

// Safe mode implementation - lazy loading of modules
let useEagerLoading = true;
let loadingTimeout: ReturnType<typeof setTimeout> | null = null;
let safeModeFallback = false;

console.error("Starting apple-mcp server...");

// Placeholders for modules - will either be loaded eagerly or lazily
let contacts: typeof import("./utils/contacts").default | null = null;
let notes: typeof import("./utils/notes").default | null = null;
let message: typeof import("./utils/message").default | null = null;
let mail: typeof import("./utils/mail").default | null = null;
let reminders: typeof import("./utils/reminders").default | null = null;
let calendar: typeof import("./utils/calendar").default | null = null;
let maps: typeof import("./utils/maps").default | null = null;

// Type map for module names to their types
type ModuleMap = {
  contacts: typeof import("./utils/contacts").default;
  notes: typeof import("./utils/notes").default;
  message: typeof import("./utils/message").default;
  mail: typeof import("./utils/mail").default;
  reminders: typeof import("./utils/reminders").default;
  calendar: typeof import("./utils/calendar").default;
  maps: typeof import("./utils/maps").default;
};

// Helper function for lazy module loading
async function loadModule<
  T extends
    | "contacts"
    | "notes"
    | "message"
    | "mail"
    | "reminders"
    | "calendar"
    | "maps",
>(moduleName: T): Promise<ModuleMap[T]> {
  if (safeModeFallback) {
    console.error(`Loading ${moduleName} module on demand (safe mode)...`);
  }

  try {
    switch (moduleName) {
      case "contacts":
        if (!contacts) contacts = (await import("./utils/contacts")).default;
        return contacts as ModuleMap[T];
      case "notes":
        if (!notes) notes = (await import("./utils/notes")).default;
        return notes as ModuleMap[T];
      case "message":
        if (!message) message = (await import("./utils/message")).default;
        return message as ModuleMap[T];
      case "mail":
        if (!mail) mail = (await import("./utils/mail")).default;
        return mail as ModuleMap[T];
      case "reminders":
        if (!reminders) reminders = (await import("./utils/reminders")).default;
        return reminders as ModuleMap[T];
      case "calendar":
        if (!calendar) calendar = (await import("./utils/calendar")).default;
        return calendar as ModuleMap[T];
      case "maps":
        if (!maps) maps = (await import("./utils/maps")).default;
        return maps as ModuleMap[T];
      default:
        throw new Error(`Unknown module: ${moduleName}`);
    }
  } catch (e) {
    console.error(`Error loading module ${moduleName}:`, e);
    throw e;
  }
}

// Set a timeout to switch to safe mode if initialization takes too long
loadingTimeout = setTimeout(() => {
  console.error(
    "Loading timeout reached. Switching to safe mode (lazy loading...)",
  );
  useEagerLoading = false;
  safeModeFallback = true;

  contacts = null;
  notes = null;
  message = null;
  mail = null;
  reminders = null;
  calendar = null;

  initServer();
}, 5000);

// Eager loading attempt
async function attemptEagerLoading() {
  try {
    console.error("Attempting to eagerly load modules...");

    contacts = (await import("./utils/contacts")).default;
    console.error("- Contacts module loaded successfully");

    notes = (await import("./utils/notes")).default;
    console.error("- Notes module loaded successfully");

    message = (await import("./utils/message")).default;
    console.error("- Message module loaded successfully");

    mail = (await import("./utils/mail")).default;
    console.error("- Mail module loaded successfully");

    reminders = (await import("./utils/reminders")).default;
    console.error("- Reminders module loaded successfully");

    calendar = (await import("./utils/calendar")).default;
    console.error("- Calendar module loaded successfully");

    maps = (await import("./utils/maps")).default;
    console.error("- Maps module loaded successfully");

    if (loadingTimeout) {
      clearTimeout(loadingTimeout);
      loadingTimeout = null;
    }

    console.error("All modules loaded successfully, using eager loading mode");
    initServer();
  } catch (error) {
    console.error("Error during eager loading:", error);
    console.error("Switching to safe mode (lazy loading)...");

    if (loadingTimeout) {
      clearTimeout(loadingTimeout);
      loadingTimeout = null;
    }

    useEagerLoading = false;
    safeModeFallback = true;

    contacts = null;
    notes = null;
    message = null;
    mail = null;
    reminders = null;
    calendar = null;
    maps = null;

    initServer();
  }
}

attemptEagerLoading();

// --- Helpers ---

function errorResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: true };
}

function successResult(text: string) {
  return { content: [{ type: "text" as const, text }], isError: false };
}

async function resolvePhoneNumber(
  args: { contactName?: string; phoneNumber?: string },
): Promise<string> {
  if (args.phoneNumber) return args.phoneNumber;
  if (!args.contactName) {
    throw new Error("No phone number or contact name provided");
  }
  const contactsModule = await loadModule("contacts");
  const numbers = await contactsModule.findNumber(args.contactName);
  if (numbers.length === 0) {
    throw new Error(`Contact not found: "${args.contactName}"`);
  }
  const phoneStr = numbers[0];
  const phoneNumbers = phoneStr.split(", ").map((p: string) => p.trim());
  return phoneNumbers.find((p: string) => p.startsWith("+")) || phoneNumbers[0];
}

// --- Server ---

let server: Server;

function initServer() {
  console.error(
    `Initializing server in ${safeModeFallback ? "safe" : "standard"} mode...`,
  );

  server = new Server(
    {
      name: "Apple MCP tools",
      version: "1.0.0",
    },
    {
      capabilities: {
        tools: {},
      },
    },
  );

  // --- Reddit helpers (cookie-based; see reddit-fetch / reddit-set-cookie) ---
  const REDDIT_UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36";
  // accept either "reddit_session=<token>" or a bare "<token>" pasted from DevTools
  const redditCookie = (raw: string) => { raw = raw.trim(); return raw.includes("=") ? raw : `reddit_session=${raw}`; };
  const redditGet = (cookie: string, path: string) =>
    fetch(`https://old.reddit.com${path}`, { headers: { cookie, "user-agent": REDDIT_UA, accept: "application/json" } });
  const redditRejected = (res: Response) => res.status === 403 || res.url.includes("/login");

  server.setRequestHandler(ListToolsRequestSchema, async () => {
    console.error("DEBUG: Available tools:", tools.map(t => t.name));
    return { tools };
  });

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    try {
      const { name, arguments: args } = request.params;
      if (!args) throw new Error("No arguments provided");

      switch (name) {

        // ==================== Contacts ====================

        case "contacts-search": {
          const mod = await loadModule("contacts");
          if (args.name) {
            const found = await mod.findContacts(args.name as string);
            if (found.length === 0) {
              return successResult(
                `No contact found for "${args.name}". Try a different name or omit name to list all.`,
              );
            }
            const formatted = found.map((c: any) => {
              const parts = [c.name];
              if (c.phones.length > 0) parts.push(`Phone: ${c.phones.join(", ")}`);
              if (c.emails.length > 0) parts.push(`Email: ${c.emails.join(", ")}`);
              if (c.birthday) parts.push(`Birthday: ${c.birthday}`);
              return parts.join("\n");
            });
            return successResult(
              `Found ${found.length} contact${found.length > 1 ? "s" : ""} matching "${args.name}":\n\n${formatted.join("\n\n")}`,
            );
          }
          const allNumbers = await mod.getAllNumbers();
          const contactCount = Object.keys(allNumbers).length;
          if (contactCount === 0) {
            return successResult(
              "No contacts found in the address book. Please make sure you have granted access to Contacts.",
            );
          }
          const formattedContacts = Object.entries(allNumbers)
            .filter(([_, phones]: [string, any]) => phones.length > 0)
            .map(([cName, phones]: [string, any]) => `${cName}: ${phones.join(", ")}`);
          return successResult(
            formattedContacts.length > 0
              ? `Found ${contactCount} contacts:\n\n${formattedContacts.join("\n")}`
              : "Found contacts but none have phone numbers. Try searching by name to see more details.",
          );
        }

        case "contacts-edit": {
          const mod = await loadModule("contacts");
          if (!args.name) return errorResult("Name is required for edit operation.");
          const updates: Record<string, string | null> = {};
          if ("birthday" in args) updates.birthday = args.birthday === "" ? null : args.birthday as string;
          if ("phone" in args) updates.phone = args.phone === "" ? null : args.phone as string;
          if ("email" in args) updates.email = args.email === "" ? null : args.email as string;
          if ("newName" in args) updates.newName = args.newName as string;
          const result = await mod.editContact(args.name as string, updates);
          return result.success
            ? successResult(result.message)
            : errorResult(result.message);
        }

        case "contacts-delete": {
          const mod = await loadModule("contacts");
          if (!args.name) return errorResult("Name is required for delete operation.");
          const result = await mod.deleteContact(args.name as string);
          return result.success
            ? successResult(result.message)
            : errorResult(result.message);
        }

        // ==================== Notes ====================

        case "notes-search": {
          const mod = await loadModule("notes");
          if (!args.searchText) return errorResult("Search text is required.");
          const foundNotes = await mod.findNote(args.searchText as string);
          return successResult(
            foundNotes.length
              ? foundNotes.map((note) => {
                  const priority = note.priority === "title" ? "TITLE MATCH" : "CONTENT MATCH";
                  return `${priority}\n${note.name}:\n${note.content}`;
                }).join("\n\n")
              : `No notes found for "${args.searchText}"`,
          );
        }

        case "notes-list": {
          const mod = await loadModule("notes");
          const allNotes = await mod.getAllNotes();
          return successResult(
            allNotes.length
              ? allNotes.map((note) => `${note.name}:\n${note.content}`).join("\n\n")
              : "No notes exist.",
          );
        }

        case "notes-create": {
          const mod = await loadModule("notes");
          if (!args.title || !args.body) {
            return errorResult("Title and body are required for create operation.");
          }
          const result = await mod.createNote(
            args.title as string,
            args.body as string,
            args.folderName as string | undefined,
          );
          return result.success
            ? successResult(
                `Created note "${args.title}" in folder "${result.folderName}"${result.usedDefaultFolder ? " (created new folder)" : ""}.`,
              )
            : errorResult(`Failed to create note: ${result.message}`);
        }

        // ==================== Messages ====================

        case "messages-read": {
          const phone = await resolvePhoneNumber(args as any);
          const mod = await loadModule("message");
          const messages = await mod.readMessages(phone, args.limit as number | undefined);
          return successResult(
            messages.length > 0
              ? messages
                  .map(
                    (msg) =>
                      `[${new Date(msg.date).toLocaleString()}] ${msg.is_from_me ? "Me" : msg.sender}: ${msg.content}`,
                  )
                  .join("\n")
              : "No messages found",
          );
        }

        case "messages-send": {
          const phone = await resolvePhoneNumber(args as any);
          if (!args.message) return errorResult("Message is required.");
          const mod = await loadModule("message");
          await mod.sendMessage(phone, args.message as string);
          return successResult(`Message sent to ${phone}`);
        }

        case "messages-schedule": {
          const phone = await resolvePhoneNumber(args as any);
          if (!args.message || !args.scheduledTime) {
            return errorResult("Message and scheduledTime are required.");
          }
          const mod = await loadModule("message");
          const scheduledMsg = await mod.scheduleMessage(
            phone,
            args.message as string,
            new Date(args.scheduledTime as string),
          );
          return successResult(
            `Message scheduled to be sent to ${phone} at ${scheduledMsg.scheduledTime}`,
          );
        }

        // ==================== Mail ====================

        case "mail-unread": {
          const mod = await loadModule("mail");
          let emails;
          if (args.account) {
            emails = await mod.getUnreadMailsForAccount(
              args.account as string,
              args.mailbox as string | undefined,
              args.limit as number | undefined,
            );
          } else {
            emails = await mod.getUnreadMails(args.limit as number | undefined);
          }
          return successResult(
            emails.length > 0
              ? `Found ${emails.length} unread email(s)${args.account ? ` in account "${args.account}"` : ""}${args.mailbox ? ` and mailbox "${args.mailbox}"` : ""}:\n\n` +
                emails
                  .map(
                    (email: any) =>
                      `[${email.dateSent}] From: ${email.sender}\nMailbox: ${email.mailbox}\nSubject: ${email.subject}\n${email.content.substring(0, 500)}${email.content.length > 500 ? "..." : ""}`,
                  )
                  .join("\n\n")
              : `No unread emails found${args.account ? ` in account "${args.account}"` : ""}${args.mailbox ? ` and mailbox "${args.mailbox}"` : ""}`,
          );
        }

        case "mail-search": {
          const mod = await loadModule("mail");
          const searchDesc = (args.searchTerm || args.searchSender || args.searchSubject || args.searchContent || "") as string;
          const emails = await mod.searchMails({
            searchTerm: args.searchTerm as string | undefined,
            searchSender: args.searchSender as string | undefined,
            searchSubject: args.searchSubject as string | undefined,
            searchContent: args.searchContent as string | undefined,
            limit: args.limit as number | undefined,
          });
          return successResult(
            emails.length > 0
              ? `Found ${emails.length} email(s) for "${searchDesc}"${args.account ? ` in account "${args.account}"` : ""}${args.mailbox ? ` and mailbox "${args.mailbox}"` : ""}:\n\n` +
                emails
                  .map(
                    (email: any) =>
                      `[${email.dateSent}] From: ${email.sender}\nMailbox: ${email.mailbox}\nSubject: ${email.subject}\n${email.content.substring(0, 200)}${email.content.length > 200 ? "..." : ""}`,
                  )
                  .join("\n\n")
              : `No emails found for "${searchDesc}"${args.account ? ` in account "${args.account}"` : ""}${args.mailbox ? ` and mailbox "${args.mailbox}"` : ""}`,
          );
        }

        case "mail-open": {
          const mod = await loadModule("mail");
          if (!args.subject) {
            return errorResult("Subject is required (use subject from a search/unread/latest result).");
          }
          const email = await mod.readMail(
            args.subject as string,
            args.searchTerm as string | undefined,
            args.mailbox as string | undefined,
          );
          const attSection = email?.attachments?.length
            ? `\n\nAttachments (${email.attachments.length}):\n` +
              email.attachments.map((a: any) => `- ${a.name} (${a.mimeType}) -> ${a.path}`).join("\n")
            : "";
          return successResult(
            email
              ? `From: ${email.sender}\n${email.to ? `To: ${email.to}\n` : ""}${email.cc ? `Cc: ${email.cc}\n` : ""}Date: ${email.dateSent}\nSubject: ${email.subject}\nMailbox: ${email.mailbox}${attSection}\n\n${email.content}`
              : `No email found with subject "${args.subject}"`,
          );
        }

        case "mail-latest": {
          const mod = await loadModule("mail");
          const account = (args.account as string) || undefined;
          const emails = await mod.getLatestMails(account, args.limit as number | undefined);
          return successResult(
            emails.length > 0
              ? `Found ${emails.length} latest email(s)${account ? ` in account "${account}"` : ""}:\n\n` +
                emails
                  .map(
                    (email: any) =>
                      `[${email.dateSent}] From: ${email.sender}\nMailbox: ${email.mailbox}\nSubject: ${email.subject}\n${email.content.substring(0, 500)}${email.content.length > 500 ? "..." : ""}`,
                  )
                  .join("\n\n")
              : `No latest emails found${account ? ` in account "${account}"` : ""}`,
          );
        }

        case "mail-mailboxes": {
          const mod = await loadModule("mail");
          if (args.account) {
            const mailboxes = await mod.getMailboxesForAccount(args.account as string);
            return successResult(
              mailboxes.length > 0
                ? `Found ${mailboxes.length} mailboxes for account "${args.account}":\n\n${mailboxes.join("\n")}`
                : `No mailboxes found for account "${args.account}". Make sure the account name is correct.`,
            );
          }
          const mailboxes = await mod.getMailboxes();
          return successResult(
            mailboxes.length > 0
              ? `Found ${mailboxes.length} mailboxes:\n\n${mailboxes.join("\n")}`
              : "No mailboxes found. Make sure Mail app is running and properly configured.",
          );
        }

        case "mail-accounts": {
          const mod = await loadModule("mail");
          const accounts = await mod.getAccounts();
          return successResult(
            accounts.length > 0
              ? `Found ${accounts.length} email accounts:\n\n${accounts.join("\n")}`
              : "No email accounts found. Make sure Mail app is configured with at least one account.",
          );
        }

        case "mail-send": {
          const mod = await loadModule("mail");
          if (!args.body || (!args.replyToSubject && (!args.to || !args.subject))) {
            return errorResult("Body is required, plus either to and subject, or replyToSubject.");
          }
          const result = await mod.sendMail(
            (args.to as string | undefined) ?? "",
            (args.subject as string | undefined) ?? "",
            args.body as string,
            args.cc as string | undefined,
            args.bcc as string | undefined,
            {
              attachments: args.attachments as string[] | undefined,
              account: args.account as string | undefined,
              draft: args.draft as boolean | undefined,
              replyToSubject: args.replyToSubject as string | undefined,
              replyToSender: args.replyToSender as string | undefined,
              discardDrafts: args.discardDrafts as boolean | undefined,
            },
          );
          return successResult(result!);
        }

        // ==================== Reminders ====================

        case "reminders-list": {
          const mod = await loadModule("reminders");
          const lists = await mod.getAllLists();
          const allReminders = await mod.getAllReminders();
          return {
            content: [{
              type: "text" as const,
              text: `Found ${lists.length} lists and ${allReminders.length} reminders.`,
            }],
            lists,
            reminders: allReminders,
            isError: false,
          };
        }

        case "reminders-search": {
          const mod = await loadModule("reminders");
          if (!args.searchText) return errorResult("Search text is required.");
          const results = await mod.searchReminders(args.searchText as string);
          return {
            content: [{
              type: "text" as const,
              text: results.length > 0
                ? `Found ${results.length} reminders matching "${args.searchText}".`
                : `No reminders found matching "${args.searchText}".`,
            }],
            reminders: results,
            isError: false,
          };
        }

        case "reminders-list-by-id": {
          const mod = await loadModule("reminders");
          if (!args.listId) return errorResult("List ID is required.");
          const results = await mod.getRemindersFromListById(
            args.listId as string,
            args.props as string[] | undefined,
          );
          return {
            content: [{
              type: "text" as const,
              text: results.length > 0
                ? `Found ${results.length} reminders in list with ID "${args.listId}".`
                : `No reminders found in list with ID "${args.listId}".`,
            }],
            reminders: results,
            isError: false,
          };
        }

        case "reminders-open": {
          const mod = await loadModule("reminders");
          if (!args.searchText) return errorResult("Search text is required.");
          const result = await mod.openReminder(args.searchText as string);
          return {
            content: [{
              type: "text" as const,
              text: result.success
                ? `Opened Reminders app. Found reminder: ${result.reminder?.name}`
                : result.message,
            }],
            ...result,
            isError: !result.success,
          };
        }

        case "reminders-create": {
          const mod = await loadModule("reminders");
          if (!args.name) return errorResult("Name is required.");
          const result = await mod.createReminder(
            args.name as string,
            args.listName as string | undefined,
            args.notes as string | undefined,
            args.dueDate as string | undefined,
          );
          return {
            content: [{
              type: "text" as const,
              text: `Created reminder "${result.name}" ${args.listName ? `in list "${args.listName}"` : ""}.`,
            }],
            success: true,
            reminder: result,
            isError: false,
          };
        }

        // ==================== Calendar ====================

        case "calendar-list": {
          const mod = await loadModule("calendar");
          const events = await mod.getEvents(
            args.limit as number | undefined,
            args.fromDate as string | undefined,
            args.toDate as string | undefined,
          );
          const startDateText = args.fromDate
            ? new Date(args.fromDate as string).toLocaleDateString()
            : "today";
          const endDateText = args.toDate
            ? new Date(args.toDate as string).toLocaleDateString()
            : "next 7 days";
          return successResult(
            events.length > 0
              ? `Found ${events.length} events from ${startDateText} to ${endDateText}:\n\n${events
                  .map(
                    (event) =>
                      `${event.title} (${new Date(event.startDate!).toLocaleString()} - ${new Date(event.endDate!).toLocaleString()})\n` +
                      `Location: ${event.location || "Not specified"}\n` +
                      `Calendar: ${event.calendarName}\n` +
                      `ID: ${event.id}\n` +
                      `Occurrence: ${event.startDate}`,
                  )
                  .join("\n\n")}`
              : `No events found from ${startDateText} to ${endDateText}.`,
          );
        }

        case "calendar-search": {
          const mod = await loadModule("calendar");
          if (!args.searchText) return errorResult("Search text is required.");
          const events = await mod.searchEvents(
            args.searchText as string,
            args.limit as number | undefined,
            args.fromDate as string | undefined,
            args.toDate as string | undefined,
          );
          return successResult(
            events.length > 0
              ? `Found ${events.length} events matching "${args.searchText}":\n\n${events
                  .map(
                    (event) =>
                      `${event.title} (${new Date(event.startDate!).toLocaleString()} - ${new Date(event.endDate!).toLocaleString()})\n` +
                      `Location: ${event.location || "Not specified"}\n` +
                      `Calendar: ${event.calendarName}\n` +
                      `ID: ${event.id}\n` +
                      `Occurrence: ${event.startDate}\n` +
                      `${event.notes ? `Notes: ${event.notes}\n` : ""}`,
                  )
                  .join("\n\n")}`
              : `No events found matching "${args.searchText}".`,
          );
        }

        case "calendar-open": {
          const mod = await loadModule("calendar");
          if (!args.eventId) return errorResult("Event ID is required.");
          const result = await mod.openEvent(args.eventId as string);
          return result.success
            ? successResult(result.message)
            : errorResult(`Error opening event: ${result.message}`);
        }

        case "calendar-create": {
          const mod = await loadModule("calendar");
          if (!args.title || !args.startDate || !args.endDate) {
            return errorResult("Title, startDate, and endDate are required.");
          }
          const result = await mod.createEvent(
            args.title as string,
            args.startDate as string,
            args.endDate as string,
            args.location as string | undefined,
            args.notes as string | undefined,
            args.isAllDay as boolean | undefined,
            args.calendarName as string | undefined,
          );
          return result.success
            ? successResult(
                `${result.message} Event scheduled from ${new Date(args.startDate as string).toLocaleString()} to ${new Date(args.endDate as string).toLocaleString()}${result.eventId ? `\nEvent ID: ${result.eventId}` : ""}`,
              )
            : errorResult(`Error creating event: ${result.message}`);
        }

        case "calendar-delete": {
          const mod = await loadModule("calendar");
          if (!args.eventId || !args.occurrence) {
            return errorResult("eventId and occurrence are required (both from calendar-list or calendar-search).");
          }
          const result = await mod.deleteEvent(
            args.eventId as string,
            args.occurrence as string,
            (args.span as "this" | "future" | undefined) ?? "this",
          );
          return result.success
            ? successResult(result.message)
            : errorResult(`Error deleting event: ${result.message}`);
        }

        // ==================== Maps ====================

        case "maps-search": {
          const mod = await loadModule("maps");
          if (!args.query) return errorResult("Search query is required.");
          const result = await mod.searchLocations(
            args.query as string,
            args.limit as number | undefined,
          );
          return result.success
            ? successResult(
                `${result.message}\n\n${result.locations
                  .map(
                    (location) =>
                      `Name: ${location.name}\n` +
                      `Address: ${location.address}\n` +
                      `${location.latitude && location.longitude ? `Coordinates: ${location.latitude}, ${location.longitude}\n` : ""}`,
                  )
                  .join("\n\n")}`,
              )
            : errorResult(result.message);
        }

        case "maps-save": {
          const mod = await loadModule("maps");
          if (!args.name || !args.address) {
            return errorResult("Name and address are required.");
          }
          const result = await mod.saveLocation(args.name as string, args.address as string);
          return result.success
            ? successResult(result.message)
            : errorResult(result.message);
        }

        case "maps-pin": {
          const mod = await loadModule("maps");
          if (!args.name || !args.address) {
            return errorResult("Name and address are required.");
          }
          const result = await mod.dropPin(args.name as string, args.address as string);
          return result.success
            ? successResult(result.message)
            : errorResult(result.message);
        }

        case "maps-directions": {
          const mod = await loadModule("maps");
          if (!args.fromAddress || !args.toAddress) {
            return errorResult("From and to addresses are required.");
          }
          const result = await mod.getDirections(
            args.fromAddress as string,
            args.toAddress as string,
            args.transportType as "driving" | "walking" | "transit" | undefined,
          );
          return result.success
            ? successResult(result.message)
            : errorResult(result.message);
        }

        case "maps-list-guides": {
          const mod = await loadModule("maps");
          const result = await mod.listGuides();
          return result.success
            ? successResult(result.message)
            : errorResult(result.message);
        }

        case "maps-add-to-guide": {
          const mod = await loadModule("maps");
          if (!args.address || !args.guideName) {
            return errorResult("Address and guideName are required.");
          }
          const result = await mod.addToGuide(args.address as string, args.guideName as string);
          return result.success
            ? successResult(result.message)
            : errorResult(result.message);
        }

        case "maps-create-guide": {
          const mod = await loadModule("maps");
          if (!args.guideName) return errorResult("Guide name is required.");
          const result = await mod.createGuide(args.guideName as string);
          return result.success
            ? successResult(result.message)
            : errorResult(result.message);
        }

        case "reddit-fetch": {
          // ponytail: re-read .env on every call so a pasted-in fresh cookie works without restarting start.sh
          const envFile = process.env.MCP_TUNNEL_ENV;
          const raw = (envFile && readFileSync(envFile, "utf-8").match(/^REDDIT_COOKIE=(.+)$/m)?.[1]) || process.env.REDDIT_COOKIE;
          if (!raw) return errorResult("REDDIT_COOKIE not set.");
          let path = String(args.path ?? "");
          if (!path.startsWith("/")) return errorResult("path must start with /");
          if (!/\.json(\?|$)/.test(path)) path = path.replace(/\/?(\?|$)/, ".json$1");
          // ponytail: Reddit's edge 403s these URL patterns for this access path; fail fast instead of hammering it. Drop if Reddit lifts it.
          const BLOCKED_HINT = "Reddit blocks /search, /hot, /new and /rising here. Instead: /r/<sub>?limit=N for hot, /r/<sub>/top?t=day|week|month|year for top, /r/<sub>/controversial, /?limit=N for the front page, /r/<sub>/comments/<id> for a thread, /user/<name>/submitted. To find threads on a topic, use web search with 'site:reddit.com <topic>' and then fetch the thread's /r/<sub>/comments/<id> path.";
          if (/\/(search|hot|new|rising)\.json/.test(path)) return errorResult(BLOCKED_HINT);
          const res = await redditGet(redditCookie(raw), path);
          if (redditRejected(res)) {
            // 403 is ambiguous: dead cookie, or Reddit's edge blocking this URL pattern. One probe tells them apart.
            const me = res.status === 403 ? await redditGet(redditCookie(raw), "/api/me.json") : null;
            if (me?.ok) return errorResult(`Reddit blocked this endpoint (HTTP 403 "network security" page) although the login cookie is valid. ${BLOCKED_HINT}`);
            return errorResult("Reddit rejected the login cookie (HTTP " + res.status + "): refresh it with reddit-set-cookie or update REDDIT_COOKIE in .env.");
          }
          if (!res.ok) return errorResult(`Reddit returned HTTP ${res.status}`);
          // ponytail: keep only the fields Claude needs; pass raw if trimming ever loses something important
          const KEEP = new Set(["id","title","author","score","num_comments","permalink","url","selftext","body","created_utc","subreddit","link_flair_text","over_18","after","subscribers","public_description","display_name"]);
          const trim = (v: any): any => {
            if (Array.isArray(v)) return v.map(trim);
            if (v && typeof v === "object") {
              if ("kind" in v && "data" in v) v = v.data;
              const out: any = {};
              for (const [k, val] of Object.entries(v)) {
                if (k === "children" || k === "replies") { if (val && typeof val === "object") out[k] = trim(val); }
                else if (KEEP.has(k) && val !== null && val !== "") out[k] = typeof val === "string" && val.length > 4000 ? val.slice(0, 4000) + "…" : val;
              }
              return out;
            }
            return v;
          };
          return successResult(JSON.stringify(trim(await res.json())));
        }

        case "reddit-set-cookie": {
          const envFile = process.env.MCP_TUNNEL_ENV;
          if (!envFile) return errorResult("MCP_TUNNEL_ENV not set; cannot persist the cookie.");
          const cookie = redditCookie(String(args.cookie ?? ""));
          if (!/^reddit_session=[A-Za-z0-9%._~-]+$/.test(cookie)) return errorResult("Expected the reddit_session cookie value (letters, digits, % . _ - ~ only).");
          const res = await redditGet(cookie, "/api/me.json");
          if (redditRejected(res) || !res.ok) return errorResult(`Reddit rejected this cookie (HTTP ${res.status}); .env left unchanged.`);
          const me: any = await res.json();
          const line = `REDDIT_COOKIE=${cookie}`;
          const env = readFileSync(envFile, "utf-8");
          writeFileSync(envFile, /^REDDIT_COOKIE=.*$/m.test(env) ? env.replace(/^REDDIT_COOKIE=.*$/m, line) : env.replace(/\n?$/, `\n${line}\n`));
          return successResult(`Cookie saved; logged in as u/${me?.data?.name ?? "?"}.`);
        }

        default:
          return errorResult(`Unknown tool: ${name}`);
      }
    } catch (error) {
      return errorResult(
        `Error: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  });

  // Start the server transport
  console.error("Setting up MCP server transport...");

  (async () => {
    try {
      console.error("Initializing transport...");
      const transport = new StdioServerTransport();

      console.error("Setting up stdout filter...");
      const originalStdoutWrite = process.stdout.write.bind(process.stdout);
      process.stdout.write = (chunk: any, encoding?: any, callback?: any) => {
        if (typeof chunk === "string" && !chunk.startsWith("{")) {
          console.error("Filtering non-JSON stdout message");
          return true;
        }
        return originalStdoutWrite(chunk, encoding, callback);
      };

      console.error("Connecting transport to server...");
      await server.connect(transport);
      console.error("Server connected successfully!");
    } catch (error) {
      console.error("Failed to initialize MCP server:", error);
      process.exit(1);
    }
  })();
}
