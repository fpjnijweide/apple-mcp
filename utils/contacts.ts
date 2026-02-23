import { runAppleScript } from "run-applescript";

const CONFIG = {
  MAX_CONTACTS: 100,
  TIMEOUT_MS: 10000,
};

const FIELD_SEP = "<<<F>>>";
const RECORD_SEP = "<<<R>>>";

async function checkContactsAccess(): Promise<boolean> {
  try {
    await runAppleScript(`
tell application "Contacts"
    return count of people
end tell`);
    return true;
  } catch (error) {
    console.error(
      `Cannot access Contacts app: ${error instanceof Error ? error.message : String(error)}`,
    );
    return false;
  }
}

async function requestContactsAccess(): Promise<{ hasAccess: boolean; message: string }> {
  try {
    const hasAccess = await checkContactsAccess();
    if (hasAccess) {
      return { hasAccess: true, message: "Contacts access is already granted." };
    }
    return {
      hasAccess: false,
      message:
        "Contacts access is required but not granted. Please:\n" +
        "1. Open System Settings > Privacy & Security > Contacts\n" +
        "2. Enable access for your terminal app\n" +
        "3. Restart your terminal and try again",
    };
  } catch (error) {
    return {
      hasAccess: false,
      message: `Error checking Contacts access: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Build AppleScript to extract contact details from a list of person references.
 * Returns a delimited string: name<<<F>>>phone1,phone2<<<F>>>email1,email2<<<R>>>...
 */
function contactExtractionScript(peopleExpr: string, limit: number): string {
  return `
tell application "Contacts"
    set matchingPeople to ${peopleExpr}
    set output to ""
    set i to 0
    repeat with p in matchingPeople
        if i >= ${limit} then exit repeat
        set i to i + 1

        set personName to name of p

        set phoneStr to ""
        try
            repeat with ph in phones of p
                set phoneStr to phoneStr & value of ph & ","
            end repeat
        end try
        if phoneStr ends with "," then set phoneStr to text 1 thru -2 of phoneStr

        set emailStr to ""
        try
            repeat with em in emails of p
                set emailStr to emailStr & value of em & ","
            end repeat
        end try
        if emailStr ends with "," then set emailStr to text 1 thru -2 of emailStr

        set bdayStr to ""
        try
            set bday to birth date of p
            if bday is not missing value then
                set bdayStr to (year of bday as string) & "-" & (month of bday as integer as string) & "-" & (day of bday as string)
            end if
        end try

        set output to output & personName & "${FIELD_SEP}" & phoneStr & "${FIELD_SEP}" & emailStr & "${FIELD_SEP}" & bdayStr & "${RECORD_SEP}"
    end repeat
    return output
end tell`;
}

interface Contact {
  name: string;
  phones: string[];
  emails: string[];
  birthday: string | null;
}

function parseContactOutput(output: string): Contact[] {
  const contacts: Contact[] = [];
  if (!output || output.trim() === "") return contacts;

  const records = output.split(RECORD_SEP).filter(s => s.trim() !== "");
  for (const record of records) {
    const parts = record.split(FIELD_SEP);
    const name = (parts[0] || "").trim();
    if (!name) continue;

    const phones = (parts[1] || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    const emails = (parts[2] || "")
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    const birthday = (parts[3] || "").trim() || null;

    contacts.push({ name, phones, emails, birthday });
  }
  return contacts;
}

/**
 * Search contacts by name using Contacts.app's native search (fast).
 */
async function findContacts(name: string): Promise<Contact[]> {
  try {
    const accessResult = await requestContactsAccess();
    if (!accessResult.hasAccess) {
      throw new Error(accessResult.message);
    }

    if (!name || name.trim() === "") {
      return [];
    }

    const searchName = name.replace(/"/g, '\\"');
    const script = contactExtractionScript(
      `(every person whose name contains "${searchName}")`,
      CONFIG.MAX_CONTACTS,
    );

    const result = (await runAppleScript(script)) as string;
    return parseContactOutput(result);
  } catch (error) {
    console.error(
      `Error finding contacts: ${error instanceof Error ? error.message : String(error)}`,
    );
    return [];
  }
}

/**
 * Get all contacts (with phones). Used by messages module for phone lookup.
 */
async function getAllNumbers(): Promise<{ [key: string]: string[] }> {
  try {
    const accessResult = await requestContactsAccess();
    if (!accessResult.hasAccess) {
      throw new Error(accessResult.message);
    }

    const script = contactExtractionScript(
      "every person",
      CONFIG.MAX_CONTACTS,
    );

    const result = (await runAppleScript(script)) as string;
    const contacts = parseContactOutput(result);

    const phoneNumbers: { [key: string]: string[] } = {};
    for (const contact of contacts) {
      if (contact.phones.length > 0) {
        phoneNumbers[contact.name] = contact.phones;
      }
    }
    return phoneNumbers;
  } catch (error) {
    console.error(
      `Error getting all contacts: ${error instanceof Error ? error.message : String(error)}`,
    );
    return {};
  }
}

/**
 * Find phone numbers for a contact by name. Used by messages module.
 */
async function findNumber(name: string): Promise<string[]> {
  const contacts = await findContacts(name);
  // Return phones from all matching contacts
  return contacts.flatMap(c => c.phones);
}

/**
 * Find a contact name by phone number.
 */
async function findContactByPhone(phoneNumber: string): Promise<string | null> {
  try {
    const accessResult = await requestContactsAccess();
    if (!accessResult.hasAccess) {
      throw new Error(accessResult.message);
    }

    if (!phoneNumber || phoneNumber.trim() === "") {
      return null;
    }

    const searchNumber = phoneNumber.replace(/[^0-9+]/g, "");

    const script = `
tell application "Contacts"
    set foundName to ""
    set allPeople to every person
    repeat with p in allPeople
        if foundName is not "" then exit repeat
        try
            repeat with ph in phones of p
                set phoneVal to value of ph
                if phoneVal contains "${searchNumber}" or "${searchNumber}" contains phoneVal then
                    set foundName to name of p
                    exit repeat
                end if
            end repeat
        end try
    end repeat
    return foundName
end tell`;

    const result = (await runAppleScript(script)) as string;
    if (result && result.trim() !== "") {
      return result;
    }
    return null;
  } catch (error) {
    console.error(
      `Error finding contact by phone: ${error instanceof Error ? error.message : String(error)}`,
    );
    return null;
  }
}

/**
 * Edit a contact's fields. Requires exactly one match by name.
 * Pass null/empty to clear a field, or a new value to set it.
 */
async function editContact(
  name: string,
  updates: {
    newName?: string;
    birthday?: string | null;
    phone?: string | null;
    email?: string | null;
  },
): Promise<{ success: boolean; message: string }> {
  try {
    const accessResult = await requestContactsAccess();
    if (!accessResult.hasAccess) {
      return { success: false, message: accessResult.message };
    }

    if (!name || name.trim() === "") {
      return { success: false, message: "Contact name is required" };
    }

    const searchName = name.replace(/"/g, '\\"');
    const changes: string[] = [];

    if (updates.birthday !== undefined) {
      if (updates.birthday === null || updates.birthday === "") {
        changes.push('set birth date of p to missing value');
      } else {
        // Parse ISO date (YYYY-MM-DD) and construct date explicitly to avoid locale issues
        const bMatch = updates.birthday.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/);
        if (!bMatch) {
          return { success: false, message: "Birthday must be in YYYY-MM-DD format" };
        }
        const [, bYear, bMonth, bDay] = bMatch;
        changes.push(
          'set bday to current date',
          'set day of bday to 1',
          `set year of bday to ${bYear}`,
          `set month of bday to ${Number(bMonth)}`,
          `set day of bday to ${Number(bDay)}`,
          'set time of bday to 0',
          'set birth date of p to bday',
        );
      }
    }

    if (updates.newName !== undefined && updates.newName.trim() !== "") {
      const parts = updates.newName.trim().split(/\s+/);
      const first = parts[0].replace(/"/g, '\\"');
      const last = parts.slice(1).join(" ").replace(/"/g, '\\"');
      changes.push(`set first name of p to "${first}"`);
      if (last) {
        changes.push(`set last name of p to "${last}"`);
      }
    }

    if (updates.phone !== undefined) {
      if (updates.phone === null || updates.phone === "") {
        changes.push('delete every phone of p');
      } else {
        const phoneVal = updates.phone.replace(/"/g, '\\"');
        changes.push(`make new phone at end of phones of p with properties {label:"mobile", value:"${phoneVal}"}`);
      }
    }

    if (updates.email !== undefined) {
      if (updates.email === null || updates.email === "") {
        changes.push('delete every email of p');
      } else {
        const emailVal = updates.email.replace(/"/g, '\\"');
        changes.push(`make new email at end of emails of p with properties {label:"home", value:"${emailVal}"}`);
      }
    }

    if (changes.length === 0) {
      return { success: false, message: "No updates specified" };
    }

    const script = `
tell application "Contacts"
    set matchingPeople to (every person whose name is "${searchName}")
    if (count of matchingPeople) is 0 then
        return "ERROR:No contact found with name \\"${searchName}\\""
    else if (count of matchingPeople) > 1 then
        return "ERROR:Found " & (count of matchingPeople) & " contacts named \\"${searchName}\\". Please be more specific."
    else
        set p to item 1 of matchingPeople
        ${changes.join('\n        ')}
        save
        return "SUCCESS:" & name of p
    end if
end tell`;

    const result = (await runAppleScript(script)) as string;

    if (result.startsWith("ERROR:")) {
      return { success: false, message: result.slice("ERROR:".length) };
    }
    if (result.startsWith("SUCCESS:")) {
      return { success: true, message: `Updated contact "${result.slice("SUCCESS:".length)}"` };
    }
    return { success: false, message: "Unexpected result from Contacts app" };
  } catch (error) {
    return {
      success: false,
      message: `Error editing contact: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Delete a contact by exact name. Requires exactly one match.
 */
async function deleteContact(name: string): Promise<{ success: boolean; message: string }> {
  try {
    const accessResult = await requestContactsAccess();
    if (!accessResult.hasAccess) {
      return { success: false, message: accessResult.message };
    }

    if (!name || name.trim() === "") {
      return { success: false, message: "Contact name is required" };
    }

    const searchName = name.replace(/"/g, '\\"');
    const script = `
tell application "Contacts"
    set matchingPeople to (every person whose name is "${searchName}")
    if (count of matchingPeople) is 0 then
        return "ERROR:No contact found with name \\"${searchName}\\""
    else if (count of matchingPeople) > 1 then
        return "ERROR:Found " & (count of matchingPeople) & " contacts named \\"${searchName}\\". Please be more specific."
    else
        set personName to name of item 1 of matchingPeople
        delete item 1 of matchingPeople
        save
        return "SUCCESS:" & personName
    end if
end tell`;

    const result = (await runAppleScript(script)) as string;

    if (result.startsWith("ERROR:")) {
      return { success: false, message: result.slice("ERROR:".length) };
    }
    if (result.startsWith("SUCCESS:")) {
      return { success: true, message: `Deleted contact "${result.slice("SUCCESS:".length)}"` };
    }
    return { success: false, message: "Unexpected result from Contacts app" };
  } catch (error) {
    return {
      success: false,
      message: `Error deleting contact: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export default {
  getAllNumbers,
  findNumber,
  findContacts,
  findContactByPhone,
  editContact,
  deleteContact,
  requestContactsAccess,
};
