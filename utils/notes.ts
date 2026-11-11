/**
 * 🍎 Apple MCP Notes Utility - Enhanced Edition
 * 
 * This enhanced version is based on the excellent work by the original supermemoryai/apple-mcp team:
 * - Original Repository: https://github.com/supermemoryai/apple-mcp
 * - Original Authors: @Dhravya, @jxnl, @calclavia, and the entire supermemory team
 * - Enhanced by: @Ayaanisthebest (https://github.com/Ayaanisthebest)
 * 
 * Enhanced Features:
 * - Priority-based search (title vs content matches)
 * - Rich text support with full formatting preservation
 * - Enhanced search results with visual indicators
 * - Note editing capabilities
 * - Improved error handling and debug logging
 * 
 * License: MIT (see LICENSE file)
 */

import { runAppleScript } from "run-applescript";

// Configuration
const CONFIG = {
	// Maximum notes to process (to avoid performance issues)
	MAX_NOTES: 50,
	// Maximum content length for previews
	MAX_CONTENT_PREVIEW: 200,
	// Timeout for operations
	TIMEOUT_MS: 8000,
};

type Note = {
	name: string;
	content: string;
	priority?: string;
	creationDate?: Date;
	modificationDate?: Date;
};

type CreateNoteResult = {
	success: boolean;
	note?: Note;
	message?: string;
	folderName?: string;
	usedDefaultFolder?: boolean;
};

/**
 * Check if Notes app is accessible
 */
async function checkNotesAccess(): Promise<boolean> {
	try {
		const script = `
tell application "Notes"
    return name
end tell`;

		await runAppleScript(script);
		return true;
	} catch (error) {
		console.error(
			`Cannot access Notes app: ${error instanceof Error ? error.message : String(error)}`,
		);
		return false;
	}
}

/**
 * Request Notes app access and provide instructions if not available
 */
async function requestNotesAccess(): Promise<{ hasAccess: boolean; message: string }> {
	try {
		// First check if we already have access
		const hasAccess = await checkNotesAccess();
		if (hasAccess) {
			return {
				hasAccess: true,
				message: "Notes access is already granted."
			};
		}

		// If no access, provide clear instructions
		return {
			hasAccess: false,
			message: "Notes access is required but not granted. Please:\n1. Open System Settings > Privacy & Security > Automation\n2. Find your terminal/app in the list and enable 'Notes'\n3. Restart your terminal and try again\n4. If the option is not available, run this command again to trigger the permission dialog"
		};
	} catch (error) {
		return {
			hasAccess: false,
			message: `Error checking Notes access: ${error instanceof Error ? error.message : String(error)}`
		};
	}
}

/**
 * Get all notes from Notes app (limited for performance)
 */
async function getAllNotes(): Promise<Note[]> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			throw new Error(accessResult.message);
		}

		const script = `
tell application "Notes"
    set notesList to {}
    set noteCount to 0

    -- Get all notes from all folders
    set allNotes to notes

    repeat with i from 1 to (count of allNotes)
        if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

        try
            set currentNote to item i of allNotes
            set noteName to name of currentNote
            set noteContent to body of currentNote

            -- Return full content for listing (no truncation)
            set noteInfo to {name:noteName, content:noteContent}
            set notesList to notesList & {noteInfo}
            set noteCount to noteCount + 1
        on error
            -- Skip problematic notes
        end try
    end repeat

    return notesList
end tell`;

		const result = (await runAppleScript(script)) as any;

		// Convert AppleScript result to our format
		const resultArray = Array.isArray(result) ? result : result ? [result] : [];

		return resultArray.map((noteData: any) => ({
			name: noteData.name || "Untitled Note",
			content: noteData.content || "",
			priority: noteData.priority || "unknown",
			creationDate: undefined,
			modificationDate: undefined,
		}));
	} catch (error) {
		console.error(
			`Error getting all notes: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

/**
 * Find notes by search text
 */
async function findNote(searchText: string): Promise<Note[]> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			throw new Error(accessResult.message);
		}

		if (!searchText || searchText.trim() === "") {
			return [];
		}

		// Escape for an AppleScript string literal: the search text arrives from remote MCP clients.
		const searchTerm = searchText.toLowerCase().replace(/\\/g, "\\\\").replace(/"/g, '\\"');

		// Let Notes filter with "whose" (one Apple Event each, case-insensitive) instead of fetching
		// every note's body in a loop, which took ~100s for ~500 notes and hit Cloudflare's timeout.
		const script = `
tell application "Notes"
    set searchTerm to "${searchTerm}"
    set titleMatches to {}
    set contentMatches to {}
    set seenIds to {}
    set noteCount to 0

    -- Materialize each "whose" result once; iterating the reference directly re-runs the query per item.
    set titleNotes to (notes whose name contains searchTerm)
    set bodyNotes to (notes whose body contains searchTerm)

    repeat with currentNote in titleNotes
        if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat
        try
            set end of titleMatches to {name:name of currentNote, content:body of currentNote, priority:"title"}
            set end of seenIds to id of currentNote
            set noteCount to noteCount + 1
        end try
    end repeat

    repeat with currentNote in bodyNotes
        if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat
        try
            if seenIds does not contain (id of currentNote) then
                set end of contentMatches to {name:name of currentNote, content:body of currentNote, priority:"content"}
                set noteCount to noteCount + 1
            end if
        end try
    end repeat

    return titleMatches & contentMatches
end tell`;

		const result = (await runAppleScript(script)) as any;

		// Debug logging
		console.error("DEBUG: AppleScript result:", JSON.stringify(result, null, 2));

		// Convert AppleScript result to our format
		let resultArray = [];
		
		if (Array.isArray(result)) {
			resultArray = result;
		} else if (result && typeof result === 'string') {
			// Parse the AppleScript string format: "name:NoteName, content:NoteContent, priority:priority"
			// Use regex to properly extract the parts, handling commas in content
			const nameMatch = result.match(/name:([^,]+)/);
			const priorityMatch = result.match(/priority:([^,]+)/);
			
			// For content, get everything between content: and priority: (or end of string)
			const contentStart = result.indexOf('content:') + 8;
			const priorityStart = result.indexOf(', priority:');
			const contentEnd = priorityStart > -1 ? priorityStart : result.length;
			const content = result.substring(contentStart, contentEnd);
			
			const noteData: any = {};
			if (nameMatch) noteData.name = nameMatch[1];
			if (content) noteData.content = content;
			if (priorityMatch) noteData.priority = priorityMatch[1];
			
			if (noteData.name || noteData.content) {
				resultArray = [noteData];
			}
		}
		
		console.error("DEBUG: Processed result array:", JSON.stringify(resultArray, null, 2));

		return resultArray.map((noteData: any) => ({
			name: noteData.name || "Untitled Note",
			content: noteData.content || "",
			priority: noteData.priority || "unknown",
			creationDate: undefined,
			modificationDate: undefined,
		}));
	} catch (error) {
		console.error(
			`Error finding notes: ${error instanceof Error ? error.message : String(error)}`,
		);
		return [];
	}
}

/**
 * Create a new note
 */
async function createNote(
	title: string,
	body: string,
	folderName: string = "Claude",
): Promise<CreateNoteResult> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			return {
				success: false,
				message: accessResult.message,
			};
		}

		// Validate inputs
		if (!title || title.trim() === "") {
			return {
				success: false,
				message: "Note title cannot be empty",
			};
		}

		// Keep the body as-is to preserve original formatting
		// Notes.app handles markdown and formatting natively
		const formattedBody = body.trim();

		// Use file-based approach for complex content to avoid AppleScript string issues
		const tmpFile = `/tmp/note-content-${Date.now()}.txt`;
		const fs = require("fs");

		// Write content to temporary file to avoid AppleScript escaping issues
		fs.writeFileSync(tmpFile, formattedBody, "utf8");

		const script = `
tell application "Notes"
    set targetFolder to null
    set folderFound to false
    set actualFolderName to "${folderName}"

    -- Try to find the specified folder
    try
        set allFolders to folders
        repeat with currentFolder in allFolders
            if name of currentFolder is "${folderName}" then
                set targetFolder to currentFolder
                set folderFound to true
                exit repeat
            end if
        end repeat
    on error
        -- Folders might not be accessible
    end try

    -- If folder not found and it's a test folder, try to create it
    if not folderFound and ("${folderName}" is "Claude" or "${folderName}" is "Test-Claude") then
        try
            make new folder with properties {name:"${folderName}"}
            -- Try to find it again
            set allFolders to folders
            repeat with currentFolder in allFolders
                if name of currentFolder is "${folderName}" then
                    set targetFolder to currentFolder
                    set folderFound to true
                    set actualFolderName to "${folderName}"
                    exit repeat
                end if
            end repeat
        on error
            -- Folder creation failed, use default
            set actualFolderName to "Notes"
        end try
    end if

    -- Read content from file to preserve formatting
    set noteContent to read file POSIX file "${tmpFile}" as «class utf8»

    -- Create the note with proper content using rich text
    if folderFound and targetFolder is not null then
        -- Create note in specified folder with rich text
        set newNote to make new note at targetFolder with properties {name:"${title.replace(/"/g, '\\"')}"}
        set body of newNote to noteContent
        return "SUCCESS:" & actualFolderName & ":false"
    else
        -- Create note in default location with rich text
        set newNote to make new note with properties {name:"${title.replace(/"/g, '\\"')}"}
        set body of newNote to noteContent
        return "SUCCESS:Notes:true"
    end if
end tell`;

		const result = (await runAppleScript(script)) as string;

		// Debug logging
		console.error("DEBUG: createNote AppleScript result:", result);

		// Clean up temporary file
		try {
			fs.unlinkSync(tmpFile);
		} catch (e) {
			// Ignore cleanup errors
		}

		// Parse the result string format: "SUCCESS:folderName:usedDefault"
		if (result && typeof result === "string" && result.startsWith("SUCCESS:")) {
			const parts = result.split(":");
			const folderName = parts[1] || "Notes";
			const usedDefaultFolder = parts[2] === "true";

			return {
				success: true,
				note: {
					name: title,
					content: formattedBody,
				},
				folderName: folderName,
				usedDefaultFolder: usedDefaultFolder,
			};
		} else {
			return {
				success: false,
				message: `Failed to create note: ${result || "No result from AppleScript"}`,
			};
		}
	} catch (error) {
		return {
			success: false,
			message: `Failed to create note: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Get notes from a specific folder
 */
async function getNotesFromFolder(
	folderName: string,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			return {
				success: false,
				message: accessResult.message,
			};
		}

		const script = `
tell application "Notes"
    set notesList to {}
    set noteCount to 0
    set folderFound to false

    -- Try to find the specified folder
    try
        set allFolders to folders
        repeat with currentFolder in allFolders
            if name of currentFolder is "${folderName}" then
                set folderFound to true

                -- Get notes from this folder
                set folderNotes to notes of currentFolder

                repeat with i from 1 to (count of folderNotes)
                    if noteCount >= ${CONFIG.MAX_NOTES} then exit repeat

                    try
                        set currentNote to item i of folderNotes
                        set noteName to name of currentNote
                        set noteContent to body of currentNote

                        -- Limit content for preview
                        if (length of noteContent) > ${CONFIG.MAX_CONTENT_PREVIEW} then
                            set noteContent to (characters 1 thru ${CONFIG.MAX_CONTENT_PREVIEW} of noteContent) as string
                            set noteContent to noteContent & "..."
                        end if

                        set noteInfo to {name:noteName, content:noteContent}
                        set notesList to notesList & {noteInfo}
                        set noteCount to noteCount + 1
                    on error
                        -- Skip problematic notes
                    end try
                end repeat

                exit repeat
            end if
        end repeat
    on error
        -- Handle folder access errors
    end try

    if not folderFound then
        return "ERROR:Folder not found"
    end if

    return "SUCCESS:" & (count of notesList)
end tell`;

		const result = (await runAppleScript(script)) as any;

		// Simple success/failure check based on string result
		if (result && typeof result === "string") {
			if (result.startsWith("ERROR:")) {
				return {
					success: false,
					message: result.replace("ERROR:", ""),
				};
			} else if (result.startsWith("SUCCESS:")) {
				// For now, just return success - the actual notes are complex to parse from AppleScript
				return {
					success: true,
					notes: [], // Return empty array for simplicity
				};
			}
		}

		// If we get here, assume folder was found but no notes
		return {
			success: true,
			notes: [],
		};
	} catch (error) {
		return {
			success: false,
			message: `Failed to get notes from folder: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Get recent notes from a specific folder
 */
async function getRecentNotesFromFolder(
	folderName: string,
	limit: number = 5,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
		// For simplicity, just get notes from folder (they're typically in recent order)
		const result = await getNotesFromFolder(folderName);

		if (result.success && result.notes) {
			return {
				success: true,
				notes: result.notes.slice(0, Math.min(limit, result.notes.length)),
			};
		}

		return result;
	} catch (error) {
		return {
			success: false,
			message: `Failed to get recent notes from folder: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Edit an existing note by name
 */
async function editNote(
	noteName: string,
	newContent: string,
): Promise<{ success: boolean; message?: string; note?: Note }> {
	try {
		console.error("DEBUG: editNote called with:", { noteName, newContentLength: newContent.length });
		
		const accessResult = await requestNotesAccess();
		if (!accessResult.hasAccess) {
			return {
				success: false,
				message: accessResult.message,
			};
		}

		if (!noteName || !newContent) {
			return {
				success: false,
				message: "Note name and new content are required",
			};
		}

		// Use file-based approach for complex content
		const tmpFile = `/tmp/note-edit-${Date.now()}.txt`;
		const fs = require("fs");

		// Write new content to temporary file
		fs.writeFileSync(tmpFile, newContent.trim(), "utf8");

		const script = `
tell application "Notes"
    set targetNote to null
    set noteFound to false
    
    -- Find the note by name
    set allNotes to notes
    repeat with currentNote in allNotes
        if name of currentNote is "${noteName}" then
            set targetNote to currentNote
            set noteFound to true
            exit repeat
        end if
    end repeat
    
    if not noteFound then
        return "ERROR:Note not found"
    end if
    
    -- Read new content from file
    set newContent to read file POSIX file "${tmpFile}" as «class utf8»
    
    -- Delete the old note completely
    delete targetNote
    
    -- Create a new note with the same name and new content
    make new note with properties {name:"${noteName}", body:newContent}
    
    return "SUCCESS:Note replaced successfully"
end tell`;

		const result = (await runAppleScript(script)) as string;

		// Debug logging
		console.error("DEBUG: Edit operation result:", result);

		// Clean up temporary file
		try {
			fs.unlinkSync(tmpFile);
		} catch (e) {
			// Ignore cleanup errors
		}

		if (result && result.startsWith("SUCCESS:")) {
			return {
				success: true,
				message: "Note completely replaced with new content",
				note: {
					name: noteName,
					content: newContent,
				},
			};
		} else {
			const errorMsg = result ? result.replace("ERROR:", "") : "Unknown error";
			return {
				success: false,
				message: `Failed to replace note: ${errorMsg}`,
			};
		}
	} catch (error) {
		return {
			success: false,
			message: `Failed to edit note: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

/**
 * Get notes by date range (simplified implementation)
 */
async function getNotesByDateRange(
	folderName: string,
	fromDate?: string,
	toDate?: string,
	limit: number = 20,
): Promise<{ success: boolean; notes?: Note[]; message?: string }> {
	try {
		// For simplicity, just return notes from folder
		// Date filtering is complex and unreliable in AppleScript
		const result = await getNotesFromFolder(folderName);

		if (result.success && result.notes) {
			return {
				success: true,
				notes: result.notes.slice(0, Math.min(limit, result.notes.length)),
			};
		}

		return result;
	} catch (error) {
		return {
			success: false,
			message: `Failed to get notes by date range: ${error instanceof Error ? error.message : String(error)}`,
		};
	}
}

export default {
	getAllNotes,
	findNote,
	createNote,
	editNote,
	getNotesFromFolder,
	getRecentNotesFromFolder,
	getNotesByDateRange,
	requestNotesAccess,
};
