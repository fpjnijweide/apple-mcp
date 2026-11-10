import { type Tool } from "@modelcontextprotocol/sdk/types.js";

// --- Contacts ---

const CONTACTS_SEARCH: Tool = {
  name: "contacts-search",
  description: "Search contacts by name, or list all contacts if no name given. MANDATORY: Use this tool FIRST when user asks about messaging someone by name — returns real phone numbers needed for messages-send.",
  inputSchema: {
    type: "object",
    properties: {
      name: {
        type: "string",
        description: "Name to search for (partial match). Omit to list all contacts."
      }
    }
  }
};

const CONTACTS_EDIT: Tool = {
  name: "contacts-edit",
  description: "Update a contact's fields (birthday, phone, email, name). Must match exactly one contact.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the contact to edit (must match exactly one)" },
      birthday: { type: "string", description: "New birthday (e.g. '1996-02-24'). Pass empty string to clear." },
      phone: { type: "string", description: "Phone number to add. Pass empty string to clear all." },
      email: { type: "string", description: "Email to add. Pass empty string to clear all." },
      newName: { type: "string", description: "New name (to rename the contact)" }
    },
    required: ["name"]
  }
};

const CONTACTS_DELETE: Tool = {
  name: "contacts-delete",
  description: "Delete a contact by name. Must match exactly one contact.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the contact to delete (must match exactly one)" }
    },
    required: ["name"]
  }
};

// --- Notes ---

const NOTES_SEARCH: Tool = {
  name: "notes-search",
  description: "Search notes by text. Prioritizes title matches over content matches. Returns full note content with rich text formatting.",
  inputSchema: {
    type: "object",
    properties: {
      searchText: { type: "string", description: "Text to search for in notes" }
    },
    required: ["searchText"]
  }
};

const NOTES_LIST: Tool = {
  name: "notes-list",
  description: "List all notes with their full content.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

const NOTES_CREATE: Tool = {
  name: "notes-create",
  description: "Create a new note in Apple Notes. To update a note, create a new one with the same name. Supports tables, lists, headers, and all Apple Notes formatting.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Title of the note" },
      body: { type: "string", description: "Content of the note. Supports rich text formatting including tables, lists, headers." },
      folderName: { type: "string", description: "Folder to create the note in (default: 'Claude')" }
    },
    required: ["title", "body"]
  }
};

// --- Messages ---

const MESSAGES_READ: Tool = {
  name: "messages-read",
  description: "Read messages from a contact. Provide either contactName or phoneNumber.",
  inputSchema: {
    type: "object",
    properties: {
      contactName: { type: "string", description: "Name of the contact (phone number will be looked up)" },
      phoneNumber: { type: "string", description: "Phone number (ignored if contactName provided)" },
      limit: { type: "number", description: "Number of messages to read" }
    }
  }
};

const MESSAGES_SEND: Tool = {
  name: "messages-send",
  description: "Send a message to a contact. Provide either contactName or phoneNumber.",
  inputSchema: {
    type: "object",
    properties: {
      contactName: { type: "string", description: "Name of the contact" },
      phoneNumber: { type: "string", description: "Phone number" },
      message: { type: "string", description: "Message to send" }
    },
    required: ["message"]
  }
};

const MESSAGES_SCHEDULE: Tool = {
  name: "messages-schedule",
  description: "Schedule a message to be sent later. Provide either contactName or phoneNumber.",
  inputSchema: {
    type: "object",
    properties: {
      contactName: { type: "string", description: "Name of the contact" },
      phoneNumber: { type: "string", description: "Phone number" },
      message: { type: "string", description: "Message to send" },
      scheduledTime: { type: "string", description: "ISO string of when to send the message" }
    },
    required: ["message", "scheduledTime"]
  }
};

// --- Mail ---

const MAIL_UNREAD: Tool = {
  name: "mail-unread",
  description: "List unread emails with short previews. Optionally filter by account and/or mailbox.",
  inputSchema: {
    type: "object",
    properties: {
      account: { type: "string", description: "Email account to filter by" },
      mailbox: { type: "string", description: "Mailbox to filter by" },
      limit: { type: "number", description: "Number of emails to retrieve (default 10)" }
    }
  }
};

const MAIL_SEARCH: Tool = {
  name: "mail-search",
  description: "Search emails by keyword with short previews. Use searchTerm for broad searches, or searchSender/searchSubject/searchContent for precise filtering.",
  inputSchema: {
    type: "object",
    properties: {
      searchTerm: { type: "string", description: "General search across subject, sender, AND body content" },
      searchSender: { type: "string", description: "Search by sender name or email address only" },
      searchSubject: { type: "string", description: "Search by subject line only" },
      searchContent: { type: "string", description: "Search by email body content only" },
      account: { type: "string", description: "Email account to filter by" },
      mailbox: { type: "string", description: "Mailbox to filter by" },
      limit: { type: "number", description: "Number of emails to retrieve" }
    }
  }
};

const MAIL_OPEN: Tool = {
  name: "mail-open",
  description: "Get the FULL content of one email. Use subject from a previous list/search result.",
  inputSchema: {
    type: "object",
    properties: {
      subject: { type: "string", description: "Subject of the email to open (from a previous search/unread/latest result)" },
      searchTerm: { type: "string", description: "Additional search term to narrow results" },
      mailbox: { type: "string", description: "Mailbox to search in" }
    },
    required: ["subject"]
  }
};

const MAIL_LATEST: Tool = {
  name: "mail-latest",
  description: "List recent emails with short previews, regardless of read status.",
  inputSchema: {
    type: "object",
    properties: {
      account: { type: "string", description: "Email account to filter by" },
      limit: { type: "number", description: "Number of emails to retrieve (default 5)" }
    }
  }
};

const MAIL_MAILBOXES: Tool = {
  name: "mail-mailboxes",
  description: "List mailboxes. Optionally filter by account.",
  inputSchema: {
    type: "object",
    properties: {
      account: { type: "string", description: "Account to list mailboxes for" }
    }
  }
};

const MAIL_ACCOUNTS: Tool = {
  name: "mail-accounts",
  description: "List all email accounts configured in Mail.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

const MAIL_SEND: Tool = {
  name: "mail-send",
  description: "Send an email, save it as a draft, or reply in an existing thread. For a reply, give replyToSubject (and optionally replyToSender); 'to' and 'subject' are then taken from the original message. A reply contains only the new body, not the quoted original.",
  inputSchema: {
    type: "object",
    properties: {
      to: { type: "string", description: "Recipient address(es), comma-separated. Not needed for a reply." },
      subject: { type: "string", description: "Email subject. Not needed for a reply." },
      body: { type: "string", description: "Email body content (plain text)" },
      cc: { type: "string", description: "CC address(es), comma-separated" },
      bcc: { type: "string", description: "BCC address(es), comma-separated" },
      attachments: { type: "array", items: { type: "string" }, description: "Absolute paths of files to attach" },
      account: { type: "string", description: "Sender as configured in Mail, e.g. 'Name <me@example.com>' (default: Mail's default account)" },
      draft: { type: "boolean", description: "Save to Drafts instead of sending (default false)" },
      replyToSubject: { type: "string", description: "Reply to the most recent received message whose subject contains this text" },
      replyToSender: { type: "string", description: "With replyToSubject: only match messages whose sender contains this text" }
    },
    required: ["body"]
  }
};

// --- Reminders ---

const REMINDERS_LIST: Tool = {
  name: "reminders-list",
  description: "List all reminder lists and reminders.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

const REMINDERS_SEARCH: Tool = {
  name: "reminders-search",
  description: "Search for reminders by text.",
  inputSchema: {
    type: "object",
    properties: {
      searchText: { type: "string", description: "Text to search for in reminders" }
    },
    required: ["searchText"]
  }
};

const REMINDERS_LIST_BY_ID: Tool = {
  name: "reminders-list-by-id",
  description: "Get reminders from a specific list by its ID.",
  inputSchema: {
    type: "object",
    properties: {
      listId: { type: "string", description: "ID of the list to get reminders from" },
      props: { type: "array", items: { type: "string" }, description: "Properties to include" }
    },
    required: ["listId"]
  }
};

const REMINDERS_OPEN: Tool = {
  name: "reminders-open",
  description: "Open a reminder in the Reminders app.",
  inputSchema: {
    type: "object",
    properties: {
      searchText: { type: "string", description: "Text to search for to find the reminder" }
    },
    required: ["searchText"]
  }
};

const REMINDERS_CREATE: Tool = {
  name: "reminders-create",
  description: "Create a new reminder.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the reminder" },
      listName: { type: "string", description: "List to create the reminder in" },
      notes: { type: "string", description: "Additional notes" },
      dueDate: { type: "string", description: "Due date in ISO format" }
    },
    required: ["name"]
  }
};

// --- Calendar ---

const CALENDAR_LIST: Tool = {
  name: "calendar-list",
  description: "List upcoming calendar events.",
  inputSchema: {
    type: "object",
    properties: {
      limit: { type: "number", description: "Number of events (default 10)" },
      fromDate: { type: "string", description: "Start date in ISO format (default today)" },
      toDate: { type: "string", description: "End date in ISO format (default 7 days from now)" }
    }
  }
};

const CALENDAR_SEARCH: Tool = {
  name: "calendar-search",
  description: "Search calendar events by text in titles, locations, and notes.",
  inputSchema: {
    type: "object",
    properties: {
      searchText: { type: "string", description: "Text to search for" },
      limit: { type: "number", description: "Number of events (default 10)" },
      fromDate: { type: "string", description: "Start of search range in ISO format (default today)" },
      toDate: { type: "string", description: "End of search range in ISO format (default 30 days from now)" }
    },
    required: ["searchText"]
  }
};

const CALENDAR_OPEN: Tool = {
  name: "calendar-open",
  description: "Open a calendar event by its ID.",
  inputSchema: {
    type: "object",
    properties: {
      eventId: { type: "string", description: "ID of the event to open" }
    },
    required: ["eventId"]
  }
};

const CALENDAR_CREATE: Tool = {
  name: "calendar-create",
  description: "Create a new calendar event.",
  inputSchema: {
    type: "object",
    properties: {
      title: { type: "string", description: "Title of the event" },
      startDate: { type: "string", description: "Start date/time in ISO format" },
      endDate: { type: "string", description: "End date/time in ISO format" },
      location: { type: "string", description: "Location" },
      notes: { type: "string", description: "Additional notes" },
      isAllDay: { type: "boolean", description: "Whether it's an all-day event (default false)" },
      calendarName: { type: "string", description: "Calendar to create in (uses default if not specified)" }
    },
    required: ["title", "startDate", "endDate"]
  }
};

// --- Maps ---

const MAPS_SEARCH: Tool = {
  name: "maps-search",
  description: "Search for locations in Apple Maps.",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string", description: "Search query" },
      limit: { type: "number", description: "Maximum results" }
    },
    required: ["query"]
  }
};

const MAPS_DIRECTIONS: Tool = {
  name: "maps-directions",
  description: "Get directions between two locations.",
  inputSchema: {
    type: "object",
    properties: {
      fromAddress: { type: "string", description: "Starting address" },
      toAddress: { type: "string", description: "Destination address" },
      transportType: { type: "string", enum: ["driving", "walking", "transit"], description: "Transport type" }
    },
    required: ["fromAddress", "toAddress"]
  }
};

const MAPS_LIST_GUIDES: Tool = {
  name: "maps-list-guides",
  description: "List all guides in Apple Maps.",
  inputSchema: {
    type: "object",
    properties: {}
  }
};

const MAPS_SAVE: Tool = {
  name: "maps-save",
  description: "Save a location as a favorite in Apple Maps.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the location" },
      address: { type: "string", description: "Address of the location" }
    },
    required: ["name", "address"]
  }
};

const MAPS_PIN: Tool = {
  name: "maps-pin",
  description: "Drop a pin at a location in Apple Maps.",
  inputSchema: {
    type: "object",
    properties: {
      name: { type: "string", description: "Name of the location" },
      address: { type: "string", description: "Address of the location" }
    },
    required: ["name", "address"]
  }
};

const MAPS_ADD_TO_GUIDE: Tool = {
  name: "maps-add-to-guide",
  description: "Add a location to an existing guide in Apple Maps.",
  inputSchema: {
    type: "object",
    properties: {
      address: { type: "string", description: "Address of the location" },
      guideName: { type: "string", description: "Name of the guide" }
    },
    required: ["address", "guideName"]
  }
};

const MAPS_CREATE_GUIDE: Tool = {
  name: "maps-create-guide",
  description: "Create a new guide in Apple Maps.",
  inputSchema: {
    type: "object",
    properties: {
      guideName: { type: "string", description: "Name of the guide" }
    },
    required: ["guideName"]
  }
};

const tools = [
  // Contacts
  CONTACTS_SEARCH, CONTACTS_EDIT, CONTACTS_DELETE,
  // Notes
  NOTES_SEARCH, NOTES_LIST, NOTES_CREATE,
  // Messages
  MESSAGES_READ, MESSAGES_SEND, MESSAGES_SCHEDULE,
  // Mail
  MAIL_UNREAD, MAIL_SEARCH, MAIL_OPEN, MAIL_LATEST, MAIL_MAILBOXES, MAIL_ACCOUNTS, MAIL_SEND,
  // Reminders
  REMINDERS_LIST, REMINDERS_SEARCH, REMINDERS_LIST_BY_ID, REMINDERS_OPEN, REMINDERS_CREATE,
  // Calendar
  CALENDAR_LIST, CALENDAR_SEARCH, CALENDAR_OPEN, CALENDAR_CREATE,
  // Maps
  MAPS_SEARCH, MAPS_DIRECTIONS, MAPS_LIST_GUIDES, MAPS_SAVE, MAPS_PIN, MAPS_ADD_TO_GUIDE, MAPS_CREATE_GUIDE,
];

export default tools;
